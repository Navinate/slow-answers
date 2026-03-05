import { db } from '../db';
import { questions, answers, batches } from '../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { AnthropicBatchProvider, type BatchRequest } from './batch-provider';
import {
  QUICK_SYSTEM_PROMPT,
  DEEP_SYSTEM_PROMPT,
  buildQuickPrompt,
  buildDeepPrompt,
} from './prompts';

let isSubmitting = false;

export async function submitPendingBatch(): Promise<void> {
  if (isSubmitting) return;
  isSubmitting = true;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('[BatchProcessor] No ANTHROPIC_API_KEY, skipping');
      return;
    }

    const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
    const provider = new AnthropicBatchProvider(apiKey, model);

    // Fetch pending questions
    const pending = await db
      .select()
      .from(questions)
      .where(eq(questions.status, 'pending'))
      .orderBy(questions.createdAt)
      .limit(10000);

    if (pending.length === 0) {
      console.log('[BatchProcessor] No pending questions');
      return;
    }

    console.log(`[BatchProcessor] Found ${pending.length} pending questions`);

    // Build batch requests
    const batchRequests: BatchRequest[] = pending.map((q) => ({
      questionId: q.id,
      userPrompt: q.depth === 'deep' ? buildDeepPrompt(q.content) : buildQuickPrompt(q.content),
      systemPrompt: q.depth === 'deep' ? DEEP_SYSTEM_PROMPT : QUICK_SYSTEM_PROMPT,
    }));

    // Create batch row + mark questions as batched in a transaction
    const questionIds = pending.map((q) => q.id);
    const batchRow = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(batches)
        .values({ questionCount: pending.length })
        .returning();
      await tx
        .update(questions)
        .set({ status: 'batched', batchId: batch.id })
        .where(inArray(questions.id, questionIds));
      return batch;
    });

    // Submit to Anthropic
    try {
      const result = await provider.submitBatch(batchRequests);

      // Store the provider batch ID
      await db
        .update(batches)
        .set({ providerBatchId: result.providerBatchId })
        .where(eq(batches.id, batchRow.id));

      console.log(`[BatchProcessor] Batch ${batchRow.id} submitted as ${result.providerBatchId}`);
    } catch (error) {
      console.error('[BatchProcessor] API call failed:', error);

      // Mark batch as failed
      await db
        .update(batches)
        .set({ status: 'failed' })
        .where(eq(batches.id, batchRow.id));

      // Revert questions to pending
      await db
        .update(questions)
        .set({ status: 'pending', batchId: null })
        .where(eq(questions.batchId, batchRow.id));
    }
  } finally {
    isSubmitting = false;
  }
}

let isPolling = false;

export function _resetPollingMutex(): void {
  isPolling = false;
}

const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
const CIRCUIT_BREAKER_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function pollBatchResults(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('[BatchProcessor] No ANTHROPIC_API_KEY, skipping poll');
      return;
    }

    const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
    const provider = new AnthropicBatchProvider(apiKey, model);

    // Fetch all submitted batches
    const submittedBatches = await db
      .select()
      .from(batches)
      .where(eq(batches.status, 'submitted'));

    if (submittedBatches.length === 0) return;

    const now = Date.now();

    for (const batch of submittedBatches) {
      try {
        // Handle orphaned batches (no providerBatchId)
        if (!batch.providerBatchId) {
          const age = now - new Date(batch.createdAt).getTime();
          if (age < GRACE_PERIOD_MS) {
            console.log(`[BatchProcessor] Batch ${batch.id} has no providerBatchId but is only ${Math.round(age / 1000)}s old, skipping`);
            continue;
          }
          // Orphaned — mark failed and revert questions
          console.warn(`[BatchProcessor] Batch ${batch.id} orphaned (no providerBatchId after ${Math.round(age / 1000)}s)`);
          await db.update(batches).set({ status: 'failed' }).where(eq(batches.id, batch.id));
          await db.update(questions).set({ status: 'pending', batchId: null }).where(eq(questions.batchId, batch.id));
          continue;
        }

        // Circuit breaker: batches older than 24 hours
        const batchAge = now - new Date(batch.createdAt).getTime();
        if (batchAge > CIRCUIT_BREAKER_MS) {
          console.warn(`[BatchProcessor] Batch ${batch.id} stuck for ${Math.round(batchAge / 3600000)}h, marking failed`);
          await db.update(batches).set({ status: 'failed' }).where(eq(batches.id, batch.id));
          await db.update(questions).set({ status: 'pending', batchId: null }).where(eq(questions.batchId, batch.id));
          continue;
        }

        // Check batch status with provider
        const status = await provider.checkBatch(batch.providerBatchId);

        if (status.status === 'in_progress' || status.status === 'canceling') {
          console.log(`[BatchProcessor] Batch ${batch.id} still ${status.status}:`, status.requestCounts);
          continue;
        }

        if (status.status === 'ended') {
          // Process results
          const results = await provider.getResults(batch.providerBatchId);

          for (const entry of results) {
            try {
              if (entry.type === 'succeeded') {
                // Insert answer (idempotent)
                await db
                  .insert(answers)
                  .values({
                    questionId: entry.questionId,
                    content: entry.content!,
                    modelUsed: entry.model!,
                  })
                  .onConflictDoNothing();

                // Mark question as complete
                await db
                  .update(questions)
                  .set({ status: 'complete', completedAt: new Date() })
                  .where(eq(questions.id, entry.questionId));
              } else if (entry.type === 'errored') {
                await db
                  .update(questions)
                  .set({ status: 'failed' })
                  .where(eq(questions.id, entry.questionId));
                console.error(`[BatchProcessor] Question ${entry.questionId} errored: ${entry.error}`);
              } else {
                // expired or canceled — revert to pending for retry
                await db
                  .update(questions)
                  .set({ status: 'pending', batchId: null })
                  .where(eq(questions.id, entry.questionId));
                console.log(`[BatchProcessor] Question ${entry.questionId} ${entry.type}, reverting to pending`);
              }
            } catch (entryError) {
              console.error(`[BatchProcessor] Error processing entry ${entry.questionId}:`, entryError);
            }
          }

          // Mark batch as ended
          await db
            .update(batches)
            .set({ status: 'ended', completedAt: new Date() })
            .where(eq(batches.id, batch.id));

          console.log(`[BatchProcessor] Batch ${batch.id} completed`);
        }
      } catch (error) {
        // Transient API error — log and skip, will retry next poll cycle
        console.error(`[BatchProcessor] Error checking batch ${batch.id}:`, error);
      }
    }
  } finally {
    isPolling = false;
  }
}

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
