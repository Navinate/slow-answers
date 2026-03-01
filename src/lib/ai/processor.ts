import { db } from '../db';
import { questions, answers } from '../db/schema';
import { eq } from 'drizzle-orm';
import { createProvider, type AIProvider } from './providers';
import {
  QUICK_SYSTEM_PROMPT,
  DEEP_SYSTEM_PROMPT,
  buildQuickPrompt,
  buildDeepPrompt
} from './prompts';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processQuestion(
  questionId: string,
  content: string,
  depth: 'quick' | 'deep',
  provider: AIProvider
): Promise<void> {
  const systemPrompt = depth === 'deep' ? DEEP_SYSTEM_PROMPT : QUICK_SYSTEM_PROMPT;
  const userPrompt = depth === 'deep' ? buildDeepPrompt(content) : buildQuickPrompt(content);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Mark as processing
      await db
        .update(questions)
        .set({ status: 'processing' })
        .where(eq(questions.id, questionId));

      // Generate response
      const response = await provider.generateResponse(userPrompt, systemPrompt);

      // Save answer
      await db.insert(answers).values({
        questionId,
        content: response.content,
        modelUsed: response.model
      });

      // Mark as complete
      await db
        .update(questions)
        .set({
          status: 'complete',
          completedAt: new Date()
        })
        .where(eq(questions.id, questionId));

      console.log(`[Processor] Completed question ${questionId} using ${response.model}`);
      return;

    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Processor] Attempt ${attempt}/${MAX_RETRIES} failed for ${questionId}:`, lastError.message);

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  // All retries exhausted - mark as failed
  await db
    .update(questions)
    .set({ status: 'failed' })
    .where(eq(questions.id, questionId));

  console.error(`[Processor] Question ${questionId} failed after ${MAX_RETRIES} attempts:`, lastError?.message);
}

export async function processPendingQuestions(): Promise<number> {
  let provider: AIProvider;

  try {
    provider = createProvider();
  } catch (error) {
    console.error('[Processor] No AI provider available:', error);
    return 0;
  }

  // Get pending questions (oldest first)
  const pending = await db
    .select()
    .from(questions)
    .where(eq(questions.status, 'pending'))
    .orderBy(questions.createdAt)
    .limit(5);

  if (pending.length === 0) {
    return 0;
  }

  console.log(`[Processor] Found ${pending.length} pending questions`);

  // Process sequentially to avoid rate limits
  for (const question of pending) {
    await processQuestion(
      question.id,
      question.content,
      question.depth,
      provider
    );
  }

  return pending.length;
}

let isRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

export function startProcessor(intervalMs = 30000): void {
  if (isRunning) {
    console.log('[Processor] Already running');
    return;
  }

  isRunning = true;
  console.log(`[Processor] Starting with ${intervalMs}ms interval`);

  // Run immediately
  processPendingQuestions().catch(console.error);

  // Then run on interval
  intervalId = setInterval(() => {
    processPendingQuestions().catch(console.error);
  }, intervalMs);
}

export function stopProcessor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  isRunning = false;
  console.log('[Processor] Stopped');
}
