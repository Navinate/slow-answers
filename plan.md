# Plan: Batch API Calls Once an Hour

## Goal
Replace the current 30-second polling + sequential individual API calls with hourly batch processing using the Anthropic Message Batches API (50% cost savings, higher throughput). Fall back to the existing sequential approach for OpenAI (which uses a file-based batch API that's more complex and less suitable here).

## Current Architecture
- `src/middleware.ts` starts a processor on first request via `startProcessor(30000)`
- `src/lib/ai/processor.ts` polls every 30s, fetches up to 5 pending questions, processes them one-by-one with individual API calls
- `src/lib/ai/providers.ts` has `AnthropicProvider` and `OpenAIProvider` classes with `generateResponse()` for single requests
- Model defaults: `claude-haiku-4-5-20251001` (Anthropic), `gpt-4o-mini` (OpenAI)
- Both providers use `max_tokens: 2048`
- Prompts differ by depth (`quick` vs `deep`) — see `src/lib/ai/prompts.ts`

## Design Decisions

1. **Anthropic-only batching**: Anthropic's batch API is SDK-native (`client.messages.batches.create()` → poll → stream results). OpenAI's batch API requires JSONL file uploads via the Files API, which adds significant complexity. Since Anthropic is the preferred/primary provider, we'll implement batching for Anthropic only and keep the existing sequential fallback for OpenAI.

2. **Two-phase processor**: Replace the single poll loop with two separate intervals:
   - **Batch submission** (hourly): Collect all pending questions, submit as an Anthropic batch
   - **Batch result polling** (every 5 minutes): Check in-flight batches for completion, process results

3. **New question status**: Add `'batched'` to the status enum to distinguish questions that have been submitted in a batch (but not yet answered) from those still `'pending'`. This prevents re-submitting the same questions in the next batch cycle.

4. **Batch tracking table**: Store batch metadata (Anthropic batch ID, status, question count) so we can map results back to questions when polling for completion.

5. **Transaction safety**: DB writes (creating batch row + marking questions as `'batched'`) happen in a single transaction before the Anthropic API call. If the API call fails, we revert questions back to `'pending'` and mark the batch as `'failed'`.

6. **Crash recovery**: On startup, `submitPendingBatch()` runs first, then `pollBatchResults()` runs after it completes (sequential, not concurrent — see "Startup race condition" below). This handles:
   - Questions stuck in `'pending'` from before a restart → picked up by submission
   - In-flight batches from before a restart → results polled and processed
   - Batch rows without a `provider_batch_id` (server crashed between DB write and API call) → detected and questions reverted to `'pending'`

7. **Orphan detection grace period**: When `pollBatchResults` finds a batch with `providerBatchId = null`, it only treats it as orphaned if the batch's `createdAt` is more than 5 minutes ago. This prevents a race condition where poll runs while submit is mid-flight (between its DB transaction and the API response). A batch created less than 5 minutes ago with no `providerBatchId` is assumed to still be in the submission flow.

8. **Stuck batch circuit breaker**: If a batch has been in `'submitted'` status for more than 24 hours (even with a `providerBatchId`), `pollBatchResults` marks it as `'failed'` and reverts its questions to `'pending'`. This prevents questions from being stuck indefinitely if Anthropic's API never transitions the batch to a terminal state.

9. **Idempotent result processing**: Answer inserts use `ON CONFLICT (question_id) DO NOTHING` to handle the case where result processing is interrupted mid-iteration (crash/error after saving some answers but before marking the batch as `ended`). On the next poll cycle, the batch is re-processed and already-saved answers are safely skipped.

---

## Step 1: Database Schema (`src/lib/db/schema.ts`)

### 1a. Add `'batched'` to `questionStatusEnum`

Change the enum from:
```typescript
export const questionStatusEnum = pgEnum('question_status', ['pending', 'processing', 'complete', 'failed']);
```
to:
```typescript
export const questionStatusEnum = pgEnum('question_status', ['pending', 'batched', 'processing', 'complete', 'failed']);
```

### 1b. Add `batches` table

```typescript
export const batchStatusEnum = pgEnum('batch_status', ['submitted', 'ended', 'failed']);

export const batches = pgTable('batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerBatchId: text('provider_batch_id'),       // e.g. "msgbatch_01Hkc..." — null until API call succeeds
  status: batchStatusEnum('status').notNull().default('submitted'),
  questionCount: integer('question_count').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at')
});
```

Need to add the `integer` import from `drizzle-orm/pg-core`.

### 1c. Add `batchId` FK to `questions` table

Add a nullable column linking each question to its batch:

```typescript
export const questions = pgTable('questions', {
  // ... existing columns ...
  batchId: uuid('batch_id').references(() => batches.id, { onDelete: 'set null' })
});
```

`onDelete: 'set null'` so that if a batch row is ever deleted, questions aren't cascade-deleted — they just lose their batch reference.

### 1d. Add type exports

```typescript
export type Batch = typeof batches.$inferSelect;
```

---

## Step 2: Generate and Apply Migration

```bash
bun db:generate   # creates migration SQL in drizzle/
bun db:push       # applies to dev database directly
```

**Note on enum migration**: Drizzle handles adding a new value to an existing pgEnum via `ALTER TYPE question_status ADD VALUE 'batched'`. This is a non-transactional DDL statement in PostgreSQL and cannot be rolled back. For production, run `bun db:migrate` instead of `bun db:push`.

**Note on enum ordering**: PostgreSQL's `ADD VALUE` appends to the end of the enum by default. To insert `'batched'` between `'pending'` and `'processing'`, the migration must use `ADD VALUE 'batched' BEFORE 'processing'`. Check the generated migration and adjust if Drizzle doesn't produce positional syntax. This is cosmetic (the app doesn't rely on enum ordering), but keeps the DB consistent with the schema definition.

---

## Step 3: Batch Provider (`src/lib/ai/batch-provider.ts`) — new file

This module wraps the Anthropic Message Batches SDK. It is a thin adapter that translates between our domain types and the Anthropic SDK.

### Types

```typescript
export interface BatchRequest {
  questionId: string;            // used as custom_id for correlation
  userPrompt: string;
  systemPrompt: string;
}

export interface BatchSubmitResult {
  providerBatchId: string;       // Anthropic's batch ID (e.g. "msgbatch_...")
}

export type BatchProcessingStatus = 'in_progress' | 'ended' | 'canceling' | 'canceled' | 'expired';

export interface BatchStatusResult {
  status: BatchProcessingStatus;
  requestCounts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
}

export interface BatchResultEntry {
  questionId: string;            // from custom_id
  type: 'succeeded' | 'errored' | 'expired' | 'canceled';
  content?: string;              // the answer text (only if succeeded)
  model?: string;                // e.g. "claude-haiku-4-5-20251001" (only if succeeded)
  error?: string;                // error message (only if errored)
}
```

### `AnthropicBatchProvider` class

```typescript
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicBatchProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }
```

**`submitBatch(requests: BatchRequest[]): Promise<BatchSubmitResult>`**
- Maps each `BatchRequest` into the SDK format:
  ```typescript
  {
    custom_id: request.questionId,
    params: {
      model: this.model,
      max_tokens: 2048,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userPrompt }]
    }
  }
  ```
- Calls `this.client.messages.batches.create({ requests: mappedRequests })`
- Returns `{ providerBatchId: batch.id }`

**`checkBatch(providerBatchId: string): Promise<BatchStatusResult>`**
- Calls `this.client.messages.batches.retrieve(providerBatchId)`
- Returns `{ status: batch.processing_status, requestCounts: batch.request_counts }`

**`getResults(providerBatchId: string): Promise<BatchResultEntry[]>`**
- Calls `this.client.messages.batches.results(providerBatchId)` — returns an async iterable
- Iterates with `for await (const entry of results)`:
  - If `entry.result.type === 'succeeded'`: extract text from `entry.result.message.content[0]` (assert type is `'text'`), and `entry.result.message.model`
  - If `entry.result.type === 'errored'`: extract `entry.result.error.message`
  - If `entry.result.type === 'expired'` or `'canceled'`: just record the type
- Returns array of `BatchResultEntry`

---

## Step 4: Batch Processor (`src/lib/ai/batch-processor.ts`) — new file

This module orchestrates batch submission and result processing. It uses the database and `AnthropicBatchProvider`.

### Imports needed
```typescript
import { db } from '../db';
import { questions, answers, batches } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { AnthropicBatchProvider } from './batch-provider';
import {
  QUICK_SYSTEM_PROMPT, DEEP_SYSTEM_PROMPT,
  buildQuickPrompt, buildDeepPrompt
} from './prompts';
```

### `submitPendingBatch(): Promise<void>`

Runs hourly. Collects all pending questions and submits them as a single Anthropic batch.

**Detailed steps:**

1. **Create provider instance.** Read `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` from env (same logic as `createProvider()` in `providers.ts`). If no key, log and return early.

2. **Fetch pending questions.** Query all questions with `status = 'pending'`, ordered by `createdAt` ascending. Cap at 10,000 (Anthropic supports up to 100,000 but this is a safety limit).

3. **Early return if empty.** If no pending questions, log and return.

4. **Build batch requests.** For each question, construct a `BatchRequest`:
   ```typescript
   {
     questionId: question.id,
     userPrompt: question.depth === 'deep' ? buildDeepPrompt(question.content) : buildQuickPrompt(question.content),
     systemPrompt: question.depth === 'deep' ? DEEP_SYSTEM_PROMPT : QUICK_SYSTEM_PROMPT
   }
   ```

5. **Database transaction: create batch + mark questions.** In a single transaction:
   - Insert a row into `batches` with `status: 'submitted'`, `questionCount: questions.length`, `providerBatchId: null`
   - Update all selected questions: `status → 'batched'`, `batchId → batch.id`

6. **Call Anthropic API.** Call `provider.submitBatch(batchRequests)` to get the `providerBatchId`.

7. **Store provider batch ID.** Update the batch row: `providerBatchId = result.providerBatchId`.

8. **Error handling.** If the API call (step 6) throws:
   - Log the error
   - Update the batch row: `status → 'failed'`
   - Update all questions in this batch: `status → 'pending'`, `batchId → null` (revert so they're picked up next cycle)

### `pollBatchResults(): Promise<void>`

Runs every 5 minutes. Checks all in-flight batches for completion and processes results.

**Detailed steps:**

1. **Fetch submitted batches.** Query all batches with `status = 'submitted'`.

2. **Handle orphaned batches.** For any batch with `status = 'submitted'` and `providerBatchId = null`:
   - **Grace period**: Only treat as orphaned if `createdAt` is more than 5 minutes ago. If less than 5 minutes old, skip it — the submission flow may still be in progress (between DB write and API call).
   - For orphaned batches past the grace period: mark batch as `'failed'`, revert its questions to `status = 'pending'`, `batchId = null`.
   - Continue to next batch.

3. **Handle stuck batches (circuit breaker).** For any batch with `status = 'submitted'` and a `providerBatchId`, check if `createdAt` is more than 24 hours ago. If so:
   - Mark batch as `'failed'`
   - Revert questions to `'pending'`, `batchId = null`
   - Log a warning: the batch has been in-flight for over 24 hours and is presumed lost
   - Continue to next batch

4. **Check each batch status.** For each remaining batch with a `providerBatchId`, call `provider.checkBatch(providerBatchId)`.

5. **Skip if still processing.** If `status === 'in_progress'` or `status === 'canceling'`, log progress counts and continue to next batch. (`canceling` is a transient state that will eventually reach `canceled`.)

6. **Handle expired/canceled.** If `status === 'expired'` or `'canceled'`:
   - Mark batch as `'failed'`
   - Revert questions to `'pending'`, `batchId = null` (so they're resubmitted next cycle)
   - Log a warning

7. **Process ended batch.** If `status === 'ended'`:
   - Call `provider.getResults(providerBatchId)` to get all result entries
   - For each entry, wrap in a try/catch so a single entry's failure doesn't abort the whole batch:
     - **`succeeded`**: Insert into `answers` table using `ON CONFLICT (question_id) DO NOTHING` (idempotent — handles re-processing after a crash mid-iteration). If the insert was a no-op (answer already existed), just ensure the question is `'complete'`. Update question: `status → 'complete'`, `completedAt → new Date()`.
     - **`errored`**: Update question: `status → 'failed'`. Log the error.
     - **`expired` or `canceled`**: Update question: `status → 'pending'`, `batchId → null` (retry next cycle). Log the situation.
   - After processing all entries: update batch row: `status → 'ended'`, `completedAt → new Date()`

8. **Error handling.** If the Anthropic API call to check/retrieve results throws, log the error and skip to the next batch (will retry on next poll cycle). Do NOT mark the batch as failed — the error may be transient.

### `startBatchProcessor(): void`

Sets up the two intervals and runs both functions immediately on startup.

```typescript
let batchProcessorRunning = false;
let submitIntervalId: ReturnType<typeof setInterval> | null = null;
let pollIntervalId: ReturnType<typeof setInterval> | null = null;

export function startBatchProcessor(): void {
  if (batchProcessorRunning) {
    console.log('[BatchProcessor] Already running');
    return;
  }
  batchProcessorRunning = true;
  console.log('[BatchProcessor] Starting batch processor');

  // Run immediately on startup — SEQUENTIAL to avoid race condition.
  // Submit must complete before poll runs, otherwise poll could see
  // a freshly-created batch with no providerBatchId and treat it as orphaned.
  submitPendingBatch()
    .catch(console.error)
    .then(() => pollBatchResults().catch(console.error));

  // Submit new batches every 60 minutes
  submitIntervalId = setInterval(() => {
    submitPendingBatch().catch(console.error);
  }, 60 * 60 * 1000);

  // Poll for results every 5 minutes
  pollIntervalId = setInterval(() => {
    pollBatchResults().catch(console.error);
  }, 5 * 60 * 1000);
}

export function stopBatchProcessor(): void {
  if (submitIntervalId) clearInterval(submitIntervalId);
  if (pollIntervalId) clearInterval(pollIntervalId);
  submitIntervalId = null;
  pollIntervalId = null;
  batchProcessorRunning = false;
  console.log('[BatchProcessor] Stopped');
}
```

### Concurrency guard

Both `submitPendingBatch` and `pollBatchResults` should have a simple mutex (boolean flag) to prevent overlapping executions if a previous run hasn't finished when the next interval fires:

```typescript
let isSubmitting = false;

async function submitPendingBatch(): Promise<void> {
  if (isSubmitting) return;
  isSubmitting = true;
  try { /* ... */ } finally { isSubmitting = false; }
}
```

Same pattern for `pollBatchResults`.

---

## Step 5: Update Processor (`src/lib/ai/processor.ts`)

No changes to the existing code. The existing `startProcessor()`, `processPendingQuestions()`, and `stopProcessor()` remain as-is. They serve as the OpenAI fallback path.

The batch processor is a separate module (`batch-processor.ts`) with its own `startBatchProcessor()` / `stopBatchProcessor()`.

---

## Step 6: Update Exports (`src/lib/ai/index.ts`)

Add new exports:

```typescript
export { startBatchProcessor, stopBatchProcessor } from './batch-processor';
```

---

## Step 7: Update Middleware (`src/middleware.ts`)

Change the processor startup logic to choose between batch and sequential mode:

```typescript
import { startProcessor, startBatchProcessor } from './lib/ai';

// In the onRequest handler:
if (!processorStarted && (import.meta.env.DATABASE_URL ?? process.env.DATABASE_URL)) {
  processorStarted = true;
  try {
    const anthropicKey = import.meta.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      startBatchProcessor();   // Anthropic batch mode (hourly batches, 50% savings)
    } else {
      startProcessor(30000);   // OpenAI sequential fallback (every 30s)
    }
  } catch (error) {
    console.error('[Middleware] Failed to start processor:', error);
  }
}
```

---

## Step 8: Update Frontend Status Display

### 8a. `src/pages/questions/index.astro`

In `getStatusColor()`, add the `'batched'` case mapping to the same color as `'processing'` (amber):

```typescript
case 'batched': return '#f59e0b';   // same as processing
```

In the status text display, add the `'batched'` case:

```typescript
question.status === 'batched' ? '⏳ Queued' :
```

This goes before the existing `'processing'` check in the ternary chain. Use "Queued" rather than "In Batch" — users don't know what batching is.

### 8b. `src/pages/questions/[id].astro`

**Status display**: Add a `'batched'` branch to the status card rendering. It should show a "queued" UI card (no spinner — distinguishes from active processing):

```astro
) : question.status === 'batched' ? (
  <div class="status-card pending">
    <p>Your question is queued and will be answered soon. Check back in a bit!</p>
  </div>
```

Insert this branch between the `processing` and `failed` checks. Uses the `pending` card style (no spinner) since the question is waiting, not actively being processed.

**CSS**: Add `.status-batched` color rule:

```css
.status-batched { color: #f59e0b; }
```

**Auto-refresh script**: Update the condition that gates the auto-refresh `<script>` to also include `'batched'`:

```astro
{(question.status === 'pending' || question.status === 'batched' || question.status === 'processing') && (
```

**Adjust polling interval based on status**: With hourly batching, polling every 10 seconds for a `batched` question wastes ~390 requests per page view before the answer arrives. Use the server-rendered status to choose the interval:

```astro
<script is:inline define:vars={{ questionId: question.id, currentStatus: question.status }}>
  // Poll frequently for actively-processing questions, less often for queued/pending
  const pollInterval = (currentStatus === 'processing') ? 10000 : 60000;

  async function checkStatus() {
    try {
      const response = await fetch(`/api/questions/${questionId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'complete' || data.status === 'failed') {
          window.location.reload();
        }
        // If status changed from pending/batched to processing, reload to get faster polling
        if (currentStatus !== 'processing' && data.status === 'processing') {
          window.location.reload();
        }
      }
    } catch (e) {
      // Silently ignore errors
    }
  }

  setInterval(checkStatus, pollInterval);
</script>
```

This reloads the page when status transitions to `processing`, which re-renders with the 10-second interval.

### 8c. `src/pages/api/questions/[id].ts`

No changes needed. The endpoint returns the raw question status. The frontend handles display. The `'batched'` status flows through as-is.

---

## File Summary

| File | Action | What changes |
|------|--------|--------------|
| `src/lib/db/schema.ts` | Modify | Add `'batched'` to `questionStatusEnum`, add `batchStatusEnum`, add `batches` table, add `batchId` FK to `questions`, add `integer` import, add `Batch` type export |
| `drizzle/` | Auto-generated | Migration files from `bun db:generate` |
| `src/lib/ai/batch-provider.ts` | **Create** | `AnthropicBatchProvider` class wrapping the Anthropic SDK's batch API |
| `src/lib/ai/batch-processor.ts` | **Create** | `submitPendingBatch()`, `pollBatchResults()`, `startBatchProcessor()`, `stopBatchProcessor()` |
| `src/lib/ai/processor.ts` | No change | Kept as-is for OpenAI sequential fallback |
| `src/lib/ai/index.ts` | Modify | Add exports for `startBatchProcessor`, `stopBatchProcessor` |
| `src/middleware.ts` | Modify | Branch on `ANTHROPIC_API_KEY` to choose batch vs sequential processor |
| `src/pages/questions/index.astro` | Modify | Handle `'batched'` in status color + display text |
| `src/pages/questions/[id].astro` | Modify | Handle `'batched'` in status card, CSS class, and auto-refresh condition |
| `src/pages/api/questions/[id].ts` | No change | Raw status passthrough already works |

---

## Implementation Order

Steps must be done in this order due to dependencies:

```
Step 1 (schema) → Step 2 (migration) → Step 3 (batch-provider) → Step 4 (batch-processor)
                                                                        ↓
                                                               Step 6 (exports)
                                                                        ↓
                                                               Step 7 (middleware)
                                                                        ↓
                                                               Step 8 (frontend)
```

Step 5 (processor.ts) requires no changes.

Steps 3 and 8 are independent of each other — they could be done in parallel. But Step 4 depends on Step 3, Step 6 depends on Step 4, and Step 7 depends on Step 6.

---

## Sequence Diagram

```
On startup (sequential):
  await submitPendingBatch()   // must complete before poll runs
  await pollBatchResults()

Every hour:
  submitPendingBatch()
    ├── SELECT * FROM questions WHERE status = 'pending' ORDER BY created_at LIMIT 10000
    ├── BEGIN TRANSACTION
    │   ├── INSERT INTO batches (status='submitted', question_count=N)
    │   └── UPDATE questions SET status='batched', batch_id=<batch-uuid> WHERE id IN (...)
    ├── COMMIT
    ├── anthropic.messages.batches.create({ requests: [...] })
    │   └── returns { id: "msgbatch_..." }
    └── UPDATE batches SET provider_batch_id='msgbatch_...' WHERE id=<batch-uuid>

    On API error:
    ├── UPDATE batches SET status='failed' WHERE id=<batch-uuid>
    └── UPDATE questions SET status='pending', batch_id=NULL WHERE batch_id=<batch-uuid>

Every 5 minutes:
  pollBatchResults()
    ├── SELECT * FROM batches WHERE status = 'submitted'
    ├── For batches with provider_batch_id = NULL AND created_at < 5 min ago:
    │   └── Skip (submission may still be in flight)
    ├── For batches with provider_batch_id = NULL AND created_at >= 5 min ago (orphaned):
    │   ├── UPDATE batches SET status='failed'
    │   └── UPDATE questions SET status='pending', batch_id=NULL WHERE batch_id=<batch-uuid>
    ├── For batches with created_at > 24 hours ago (stuck — circuit breaker):
    │   ├── UPDATE batches SET status='failed'
    │   └── UPDATE questions SET status='pending', batch_id=NULL WHERE batch_id=<batch-uuid>
    └── For each remaining batch with provider_batch_id:
        ├── anthropic.messages.batches.retrieve(provider_batch_id)
        │   ├── if 'in_progress' or 'canceling': log progress, skip
        │   ├── if 'expired'/'canceled': mark batch failed, revert questions to pending
        │   └── if 'ended':
        │       ├── for await (result of .results(provider_batch_id)):
        │       │   ├── succeeded → INSERT answer ON CONFLICT DO NOTHING, UPDATE question status='complete'
        │       │   ├── errored   → UPDATE question status='failed'
        │       │   └── expired/canceled → UPDATE question status='pending' (retry)
        │       └── UPDATE batches SET status='ended', completed_at=now()
        └── On API error: log and skip (retry next poll cycle)
```

---

## Implementation Status

### Completed

**Step 1: Database Schema** — Done
- Modified `src/lib/db/schema.ts`: added `'batched'` to `questionStatusEnum`, added `batchStatusEnum`, added `batches` table, added `batchId` FK to `questions`, added `integer` import, added `Batch` type export

**Step 3: Batch Provider** — Done
- Created `src/lib/ai/batch-provider.ts`: `AnthropicBatchProvider` class with `submitBatch()`, `checkBatch()`, `getResults()`
- Created `src/lib/ai/batch-provider.test.ts`: 7 tests covering SDK mapping, error propagation, status retrieval, and all result types (succeeded/errored/expired/canceled/mixed)
- **Deviation from plan**: Constructor accepts optional `client?: Anthropic` parameter for test dependency injection (not in original plan)

**Step 4: Batch Processor** — Done
- Created `src/lib/ai/batch-processor.ts`: `submitPendingBatch()`, `pollBatchResults()`, `startBatchProcessor()`, `stopBatchProcessor()`, `_resetPollingMutex()`
- Created `src/lib/ai/batch-processor.test.ts`: 22 tests covering submission flow, error recovery, mutex guards, orphan detection, circuit breaker, result processing (all entry types), per-entry error isolation, start/stop lifecycle
- **Deviation from plan**: Added `_resetPollingMutex()` export for test isolation (resets the `isPolling` boolean between tests)

**Step 5: Processor** — No changes needed (as planned)

**Test Infrastructure** — Set up
- Created `vitest.config.ts` with `globals: true`
- Added `vitest` as devDependency, added `test` and `test:watch` scripts to `package.json`
- **29/29 tests passing** across both test files

### Remaining

**Step 2: Generate and Apply Migration** — Not done
- Run `bun db:generate` and `bun db:push` (or `bun db:migrate` for production)
- Check generated migration for correct enum ordering (`ADD VALUE 'batched' BEFORE 'processing'`)

**Step 6: Update Exports** — Not done
- Add `startBatchProcessor`, `stopBatchProcessor` exports to `src/lib/ai/index.ts`

**Step 7: Update Middleware** — Not done
- Branch on `ANTHROPIC_API_KEY` in `src/middleware.ts` to choose batch vs sequential processor

**Step 8: Frontend Status Display** — Not done
- Handle `'batched'` status in `src/pages/questions/index.astro` (color + display text)
- Handle `'batched'` status in `src/pages/questions/[id].astro` (status card, CSS, auto-refresh, adaptive poll interval)

### Notes for Resuming

- **SDK type discovery**: Anthropic SDK `processing_status` only has `'in_progress' | 'canceling' | 'ended'` — the plan's `'expired'` and `'canceled'` batch-level statuses don't exist. Those types only apply to individual result entries within a batch. The implementation handles this correctly (pollBatchResults checks for `'in_progress'`, `'canceling'`, and `'ended'` only).
- **Test patterns**: Tests use `vi.mock('../db', ...)` and `vi.mock('./batch-provider', ...)` for module mocking. A `mockChain()` Proxy-based helper handles Drizzle ORM's fluent query API. A `trackUpdates()` helper captures `db.update().set()` calls for assertion. The `AnthropicBatchProvider` constructor mock uses a regular `function()` (not arrow) because arrow functions can't be called with `new`.
- **Run tests with**: `bun run test` (not `bun test`, which uses Bun's built-in test runner instead of vitest)

---

## Edge Cases and Recovery

| Scenario | What happens |
|----------|-------------|
| **No pending questions** | `submitPendingBatch()` returns early. No batch created. |
| **Anthropic API down during submission** | Batch marked `'failed'`, questions reverted to `'pending'`. Retried next hour. |
| **Server crashes after DB transaction but before API call** | Batch row exists with `providerBatchId = null`. After 5-minute grace period, `pollBatchResults()` detects this, marks batch `'failed'`, reverts questions to `'pending'`. |
| **Server crashes after API call but before storing providerBatchId** | Batch row has `providerBatchId = null` — same as above (after grace period). The Anthropic batch runs but results are orphaned (acceptable loss; questions get resubmitted next cycle). |
| **Poll runs while submit is mid-flight** | Grace period: batches with `providerBatchId = null` and `createdAt` less than 5 minutes ago are skipped. Submit finishes normally and stores the `providerBatchId`. |
| **Startup race condition** | Prevented: `startBatchProcessor()` runs submit first, then poll sequentially (not concurrently). The grace period provides defense-in-depth for interval-based races. |
| **Batch expires (>24 hours)** | `pollBatchResults()` sees `'expired'` status, reverts questions to `'pending'` for resubmission. |
| **Batch stuck in `in_progress` indefinitely** | Circuit breaker: if `createdAt` is more than 24 hours ago, batch is marked `'failed'` and questions reverted to `'pending'`. |
| **Batch in `canceling` state** | Treated the same as `in_progress` — logged and skipped. Will eventually transition to `canceled`, which is handled. |
| **Partial batch failure** | Each result entry handled individually with per-entry try/catch. Succeeded → answer saved. Errored → question marked `'failed'`. Expired/canceled → question reverted to `'pending'`. |
| **Crash during result processing** (some answers saved, batch still `submitted`) | On next poll, batch is re-processed. Already-saved answers hit `ON CONFLICT DO NOTHING` and are safely skipped. Remaining answers are saved normally. |
| **Overlapping execution** (interval fires while previous run is still going) | Concurrency guard (boolean flag) prevents re-entry. |
| **Multiple batches in-flight** | Each batch tracked independently. `pollBatchResults()` iterates all `'submitted'` batches. |
| **OpenAI-only deployment** (no `ANTHROPIC_API_KEY`) | Middleware falls back to existing `startProcessor(30000)` sequential mode. No batch code runs. |
