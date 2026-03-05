# Plan: Batch API Calls Once an Hour

## Goal
Replace the current 30-second polling + sequential individual API calls with hourly batch processing using the Anthropic Message Batches API (50% cost savings, higher throughput). Fall back to the existing sequential approach for OpenAI (which uses a file-based batch API that's more complex and less suitable here).

## Current Architecture
- `src/middleware.ts` starts a processor on first request via `startProcessor(30000)`
- `src/lib/ai/processor.ts` polls every 30s, fetches up to 5 pending questions, processes them one-by-one with individual API calls
- `src/lib/ai/providers.ts` has `AnthropicProvider` and `OpenAIProvider` classes with `generateResponse()` for single requests

## Design Decisions

1. **Anthropic-only batching**: Anthropic's batch API is SDK-native (create batch → poll → stream results). OpenAI's batch API requires file uploads (JSONL → Files API → Batch API), which adds significant complexity. Since Anthropic is the preferred/primary provider, we'll implement batching for Anthropic and keep the existing sequential fallback for OpenAI.

2. **Two-phase processor**: Replace the single poll loop with two separate intervals:
   - **Batch submission** (hourly): Collect all pending questions, submit as an Anthropic batch
   - **Batch result polling** (every 5 minutes): Check in-flight batches for completion, process results

3. **New question status**: Add `'batched'` to the status enum to distinguish questions that have been submitted in a batch (but not yet answered) from those still `'pending'`. This prevents re-submitting the same questions in the next batch cycle.

4. **Batch tracking table**: Store batch metadata (batch ID, status, question IDs) so we can map results back to questions when polling for completion.

## Changes

### 1. Database Schema (`src/lib/db/schema.ts`)

- Add `'batched'` to the `questionStatusEnum`: `['pending', 'batched', 'processing', 'complete', 'failed']`
- Add a new `batches` table:
  ```
  batches
  ├── id (uuid, pk)
  ├── provider_batch_id (text) - e.g. "msgbatch_01Hkc..."
  ├── status (text) - 'submitted' | 'ended' | 'failed'
  ├── question_count (integer)
  ├── created_at (timestamp)
  ├── completed_at (timestamp, nullable)
  ```
- Add `batchId` (uuid, nullable, fk → batches) column to `questions` table to link questions to their batch

### 2. Generate Migration

- Run `bun db:generate` to produce a migration for the schema changes
- Run `bun db:push` to apply (dev workflow)

### 3. Batch Provider (`src/lib/ai/batch-provider.ts`) — new file

Create an Anthropic batch provider:

```typescript
export interface BatchProvider {
  submitBatch(requests: BatchRequest[]): Promise<string>; // returns provider batch ID
  checkBatch(batchId: string): Promise<BatchStatus>;
  getResults(batchId: string): Promise<BatchResult[]>;
}
```

- `AnthropicBatchProvider` implementation using `client.messages.batches.create()`, `.retrieve()`, `.results()`
- Maps each question to a batch request with `custom_id` = question UUID
- Uses appropriate system/user prompts based on question depth

### 4. Batch Processor (`src/lib/ai/batch-processor.ts`) — new file

Two main functions:

**`submitPendingBatch()`** — runs hourly:
1. Query all `'pending'` questions (no limit, or cap at ~1000 for safety)
2. If none, return early
3. Create a `batches` row with status `'submitted'`
4. Mark all selected questions as `'batched'` and set their `batchId`
5. Build batch requests (custom_id = question.id, params = model/prompt per depth)
6. Submit via `AnthropicBatchProvider.submitBatch()`
7. Store the returned `provider_batch_id` on the batches row

**`pollBatchResults()`** — runs every 5 minutes:
1. Query all `batches` with status `'submitted'`
2. For each, call `AnthropicBatchProvider.checkBatch()`
3. If still processing, skip
4. If ended, stream results via `AnthropicBatchProvider.getResults()`
5. For each result:
   - If succeeded: insert answer, mark question `'complete'`
   - If errored/expired: mark question `'failed'` (or back to `'pending'` for retry)
6. Update batch status to `'ended'` or `'failed'`

### 5. Update Processor (`src/lib/ai/processor.ts`)

- Keep existing `processPendingQuestions()` as a fallback for OpenAI
- Add new `startBatchProcessor()` function that sets up two intervals:
  - `submitPendingBatch()` every 60 minutes (3,600,000 ms)
  - `pollBatchResults()` every 5 minutes (300,000 ms)
- Run `submitPendingBatch()` immediately on startup (to pick up any pending questions)
- Run `pollBatchResults()` immediately on startup (to check any in-flight batches from before a restart)

### 6. Update Middleware (`src/middleware.ts`)

- If `ANTHROPIC_API_KEY` is set, use `startBatchProcessor()` (batch mode)
- Otherwise fall back to `startProcessor(30000)` (sequential mode for OpenAI)

### 7. Update Exports (`src/lib/ai/index.ts`)

- Export the new batch processor functions

### 8. Update Frontend Status Display

- In `src/pages/questions/index.astro` and `src/pages/questions/[id].astro`: treat `'batched'` status like `'processing'` for display purposes (show "Processing..." or "In queue..." with auto-refresh)
- Update the API endpoint `src/pages/api/questions/[id].ts` to include `'batched'` as a "still working" status for client polling

## File Summary

| File | Action |
|------|--------|
| `src/lib/db/schema.ts` | Modify — add `'batched'` status, `batches` table, `batchId` FK |
| `src/lib/ai/batch-provider.ts` | Create — Anthropic batch API wrapper |
| `src/lib/ai/batch-processor.ts` | Create — batch submission + result polling logic |
| `src/lib/ai/processor.ts` | Modify — add `startBatchProcessor()`, keep sequential as fallback |
| `src/lib/ai/index.ts` | Modify — export new functions |
| `src/middleware.ts` | Modify — use batch processor when Anthropic key available |
| `src/pages/questions/index.astro` | Modify — handle `'batched'` status display |
| `src/pages/questions/[id].astro` | Modify — handle `'batched'` status display + auto-refresh |
| `src/pages/api/questions/[id].ts` | Modify — treat `'batched'` as in-progress for polling |

## Sequence Diagram

```
Every hour:
  submitPendingBatch()
    ├── SELECT * FROM questions WHERE status = 'pending'
    ├── INSERT INTO batches (status='submitted')
    ├── UPDATE questions SET status='batched', batch_id=...
    └── anthropic.messages.batches.create(requests)

Every 5 minutes:
  pollBatchResults()
    ├── SELECT * FROM batches WHERE status = 'submitted'
    ├── anthropic.messages.batches.retrieve(id)
    │   └── if ended:
    │       ├── for await (result of .results(id)):
    │       │   ├── succeeded → INSERT answer + UPDATE question status='complete'
    │       │   └── errored   → UPDATE question status='failed'
    │       └── UPDATE batches SET status='ended'
    └── (skip if still processing)
```
