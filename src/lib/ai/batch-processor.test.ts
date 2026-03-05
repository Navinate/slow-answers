import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the db module before importing anything that uses it
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

// Mock the batch-provider module
vi.mock('./batch-provider', () => ({
  AnthropicBatchProvider: vi.fn(),
}));

import { db } from '../db';
import { AnthropicBatchProvider } from './batch-provider';
import { submitPendingBatch, pollBatchResults, startBatchProcessor, stopBatchProcessor, _resetPollingMutex } from './batch-processor';

// Helper: creates a proxy that accepts any chain of method calls (.from().where().etc())
// and resolves to `value` when awaited. Optionally captures calls via `tracker`.
function mockChain(value: any = undefined): any {
  const proxy: any = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === 'then') {
          // Make it a thenable — resolve immediately with value
          return (resolve: (v: any) => void) => resolve(value);
        }
        // Any property access returns a callable that returns the proxy
        return (..._args: any[]) => proxy;
      },
    },
  );
  return proxy;
}

// Helper: creates a mock AnthropicBatchProvider instance
function createMockProvider() {
  return {
    submitBatch: vi.fn(),
    checkBatch: vi.fn(),
    getResults: vi.fn(),
  };
}

describe('submitPendingBatch', () => {
  const originalEnv = process.env;
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockProvider = createMockProvider();
    vi.mocked(AnthropicBatchProvider).mockImplementation(function () { return mockProvider as any; } as any);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns early when no ANTHROPIC_API_KEY is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await submitPendingBatch();

    // Should not touch the database or provider
    expect(db.select).not.toHaveBeenCalled();
    expect(mockProvider.submitBatch).not.toHaveBeenCalled();
  });

  it('returns early when no pending questions exist', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(db.select).mockReturnValue(mockChain([]));

    await submitPendingBatch();

    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockProvider.submitBatch).not.toHaveBeenCalled();
  });

  it('creates batch row and marks questions as batched in a transaction', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const pendingQuestions = [
      { id: 'q-1', content: 'What is TDD?', depth: 'quick' as const, status: 'pending' as const },
      { id: 'q-2', content: 'Explain batch APIs', depth: 'deep' as const, status: 'pending' as const },
    ];
    vi.mocked(db.select).mockReturnValue(mockChain(pendingQuestions));

    // Transaction should be called with a function
    const batchId = 'batch-uuid-1';
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      // Create a mock tx that records operations
      const txOps: Array<{ op: string; args: any }> = [];
      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: batchId }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      const result = await fn(mockTx);
      return result;
    });

    // Provider succeeds
    mockProvider.submitBatch.mockResolvedValue({ providerBatchId: 'msgbatch_abc123' });

    // After transaction, store the provider batch ID
    vi.mocked(db.update).mockReturnValue(mockChain(undefined));

    await submitPendingBatch();

    // Should have called transaction
    expect(db.transaction).toHaveBeenCalledOnce();

    // Should have called provider
    expect(mockProvider.submitBatch).toHaveBeenCalledOnce();

    // Should have stored the provider batch ID
    expect(db.update).toHaveBeenCalled();
  });

  it('builds correct prompts based on question depth', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const pendingQuestions = [
      { id: 'q-1', content: 'Quick question', depth: 'quick' as const, status: 'pending' as const },
      { id: 'q-2', content: 'Deep question', depth: 'deep' as const, status: 'pending' as const },
    ];
    vi.mocked(db.select).mockReturnValue(mockChain(pendingQuestions));
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'batch-1' }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return fn(mockTx);
    });
    mockProvider.submitBatch.mockResolvedValue({ providerBatchId: 'msgbatch_abc' });
    vi.mocked(db.update).mockReturnValue(mockChain(undefined));

    await submitPendingBatch();

    const batchRequests = mockProvider.submitBatch.mock.calls[0][0];
    expect(batchRequests).toHaveLength(2);

    // Quick question should use quick prompt
    expect(batchRequests[0].questionId).toBe('q-1');
    expect(batchRequests[0].userPrompt).toContain('concisely');
    expect(batchRequests[0].systemPrompt).toContain('concise');

    // Deep question should use deep prompt
    expect(batchRequests[1].questionId).toBe('q-2');
    expect(batchRequests[1].userPrompt).toContain('thorough');
    expect(batchRequests[1].systemPrompt).toContain('thorough');
  });

  it('stores providerBatchId after successful API call', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    vi.mocked(db.select).mockReturnValue(
      mockChain([{ id: 'q-1', content: 'test', depth: 'quick', status: 'pending' }]),
    );
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'batch-1' }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return fn(mockTx);
    });
    mockProvider.submitBatch.mockResolvedValue({ providerBatchId: 'msgbatch_xyz789' });

    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);

    await submitPendingBatch();

    // Verify the update was called to store the provider batch ID
    expect(db.update).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ providerBatchId: 'msgbatch_xyz789' }),
    );
  });

  it('reverts questions to pending and marks batch failed on API error', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    vi.mocked(db.select).mockReturnValue(
      mockChain([{ id: 'q-1', content: 'test', depth: 'quick', status: 'pending' }]),
    );

    const batchId = 'batch-fail-1';
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: batchId }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return fn(mockTx);
    });

    // Provider throws an error
    mockProvider.submitBatch.mockRejectedValue(new Error('Anthropic API down'));

    // Track the update calls for error recovery
    const updateCalls: Array<{ set: any }> = [];
    vi.mocked(db.update).mockImplementation((_table: any) => {
      const setFn = vi.fn().mockImplementation((values: any) => {
        updateCalls.push({ set: values });
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      });
      return { set: setFn } as any;
    });

    await submitPendingBatch();

    // Should have made update calls to revert
    // One to mark batch as failed, one to revert questions to pending
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);

    const batchFailUpdate = updateCalls.find((c) => c.set.status === 'failed');
    expect(batchFailUpdate).toBeDefined();

    const questionRevert = updateCalls.find(
      (c) => c.set.status === 'pending' && c.set.batchId === null,
    );
    expect(questionRevert).toBeDefined();
  });

  it('prevents concurrent execution with a mutex', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    vi.mocked(db.select).mockReturnValue(
      mockChain([{ id: 'q-1', content: 'test', depth: 'quick', status: 'pending' }]),
    );
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'batch-1' }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return fn(mockTx);
    });
    mockProvider.submitBatch.mockResolvedValue({ providerBatchId: 'msgbatch_abc' });
    vi.mocked(db.update).mockReturnValue(mockChain(undefined));

    // Start first call — sets isSubmitting=true synchronously before any await
    const first = submitPendingBatch();

    // Second call while first is in-flight: isSubmitting is true, returns immediately
    await submitPendingBatch();

    // db.select was only called once (by the first call, not the second)
    expect(db.select).toHaveBeenCalledTimes(1);

    // Let first call finish
    await first;
  });
});

describe('pollBatchResults', () => {
  const originalEnv = process.env;
  let mockProvider: ReturnType<typeof createMockProvider>;

  // Helper to track db.update calls with their .set() arguments
  function trackUpdates() {
    const calls: Array<{ set: any }> = [];
    vi.mocked(db.update).mockImplementation((_table: any) => {
      const setFn = vi.fn().mockImplementation((values: any) => {
        calls.push({ set: values });
        return { where: vi.fn().mockResolvedValue(undefined) };
      });
      return { set: setFn } as any;
    });
    return calls;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockProvider = createMockProvider();
    vi.mocked(AnthropicBatchProvider).mockImplementation(function () { return mockProvider as any; } as any);
    // Reset the polling mutex between tests
    _resetPollingMutex();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns early when no ANTHROPIC_API_KEY is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    await pollBatchResults();

    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns early when no submitted batches exist', async () => {
    vi.mocked(db.select).mockReturnValue(mockChain([]));

    await pollBatchResults();

    expect(mockProvider.checkBatch).not.toHaveBeenCalled();
  });

  it('skips batches with no providerBatchId created less than 5 minutes ago', async () => {
    const youngBatch = {
      id: 'batch-young',
      providerBatchId: null,
      status: 'submitted',
      createdAt: new Date(), // just now
    };
    vi.mocked(db.select).mockReturnValue(mockChain([youngBatch]));

    await pollBatchResults();

    // Should not update anything — batch is still within grace period
    expect(db.update).not.toHaveBeenCalled();
    expect(mockProvider.checkBatch).not.toHaveBeenCalled();
  });

  it('marks orphaned batches (no providerBatchId, > 5 min old) as failed and reverts questions', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const orphanedBatch = {
      id: 'batch-orphan',
      providerBatchId: null,
      status: 'submitted',
      createdAt: tenMinutesAgo,
    };
    vi.mocked(db.select).mockReturnValue(mockChain([orphanedBatch]));
    const updateCalls = trackUpdates();

    await pollBatchResults();

    // Should mark batch as failed
    const batchFail = updateCalls.find((c) => c.set.status === 'failed');
    expect(batchFail).toBeDefined();

    // Should revert questions to pending
    const questionRevert = updateCalls.find(
      (c) => c.set.status === 'pending' && c.set.batchId === null,
    );
    expect(questionRevert).toBeDefined();
  });

  it('circuit breaker: marks batches older than 24 hours as failed', async () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const stuckBatch = {
      id: 'batch-stuck',
      providerBatchId: 'msgbatch_stuck',
      status: 'submitted',
      createdAt: twentyFiveHoursAgo,
    };
    vi.mocked(db.select).mockReturnValue(mockChain([stuckBatch]));
    const updateCalls = trackUpdates();

    await pollBatchResults();

    // Should NOT have called checkBatch (circuit breaker fires first)
    expect(mockProvider.checkBatch).not.toHaveBeenCalled();

    // Should mark batch as failed and revert questions
    const batchFail = updateCalls.find((c) => c.set.status === 'failed');
    expect(batchFail).toBeDefined();
    const questionRevert = updateCalls.find(
      (c) => c.set.status === 'pending' && c.set.batchId === null,
    );
    expect(questionRevert).toBeDefined();
  });

  it('skips in_progress batches without state changes', async () => {
    const activeBatch = {
      id: 'batch-active',
      providerBatchId: 'msgbatch_active',
      status: 'submitted',
      createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
    };
    vi.mocked(db.select).mockReturnValue(mockChain([activeBatch]));
    mockProvider.checkBatch.mockResolvedValue({
      status: 'in_progress',
      requestCounts: { processing: 3, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
    });

    await pollBatchResults();

    expect(mockProvider.checkBatch).toHaveBeenCalledWith('msgbatch_active');
    // No updates should happen
    expect(db.update).not.toHaveBeenCalled();
  });

  it('processes ended batch: succeeded entries create answers and mark questions complete', async () => {
    const endedBatch = {
      id: 'batch-done',
      providerBatchId: 'msgbatch_done',
      status: 'submitted',
      createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    };
    vi.mocked(db.select).mockReturnValue(mockChain([endedBatch]));
    mockProvider.checkBatch.mockResolvedValue({
      status: 'ended',
      requestCounts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
    });
    mockProvider.getResults.mockResolvedValue([
      { questionId: 'q-1', type: 'succeeded', content: 'The answer is 42.', model: 'claude-haiku' },
    ]);

    // Track inserts and updates
    vi.mocked(db.insert).mockReturnValue(mockChain(undefined));
    const updateCalls = trackUpdates();

    await pollBatchResults();

    // Should have called getResults
    expect(mockProvider.getResults).toHaveBeenCalledWith('msgbatch_done');

    // Should have inserted an answer
    expect(db.insert).toHaveBeenCalled();

    // Should have marked question as complete
    const questionComplete = updateCalls.find((c) => c.set.status === 'complete');
    expect(questionComplete).toBeDefined();
    expect(questionComplete!.set.completedAt).toBeInstanceOf(Date);

    // Should have marked batch as ended
    const batchEnded = updateCalls.find((c) => c.set.status === 'ended');
    expect(batchEnded).toBeDefined();
    expect(batchEnded!.set.completedAt).toBeInstanceOf(Date);
  });

  it('processes ended batch: errored entries mark questions as failed', async () => {
    const endedBatch = {
      id: 'batch-err',
      providerBatchId: 'msgbatch_err',
      status: 'submitted',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    };
    vi.mocked(db.select).mockReturnValue(mockChain([endedBatch]));
    mockProvider.checkBatch.mockResolvedValue({
      status: 'ended',
      requestCounts: { processing: 0, succeeded: 0, errored: 1, canceled: 0, expired: 0 },
    });
    mockProvider.getResults.mockResolvedValue([
      { questionId: 'q-2', type: 'errored', error: 'Content policy violation' },
    ]);

    vi.mocked(db.insert).mockReturnValue(mockChain(undefined));
    const updateCalls = trackUpdates();

    await pollBatchResults();

    // Question should be marked as failed
    const questionFailed = updateCalls.find((c) => c.set.status === 'failed');
    expect(questionFailed).toBeDefined();
  });

  it('processes ended batch: expired/canceled entries revert questions to pending', async () => {
    const endedBatch = {
      id: 'batch-mix',
      providerBatchId: 'msgbatch_mix',
      status: 'submitted',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    };
    vi.mocked(db.select).mockReturnValue(mockChain([endedBatch]));
    mockProvider.checkBatch.mockResolvedValue({
      status: 'ended',
      requestCounts: { processing: 0, succeeded: 0, errored: 0, canceled: 1, expired: 1 },
    });
    mockProvider.getResults.mockResolvedValue([
      { questionId: 'q-3', type: 'expired' },
      { questionId: 'q-4', type: 'canceled' },
    ]);

    vi.mocked(db.insert).mockReturnValue(mockChain(undefined));
    const updateCalls = trackUpdates();

    await pollBatchResults();

    // Both questions should be reverted to pending
    const reverts = updateCalls.filter(
      (c) => c.set.status === 'pending' && c.set.batchId === null,
    );
    expect(reverts.length).toBe(2);
  });

  it('does not mark batch as failed when API check throws (transient error)', async () => {
    const batch = {
      id: 'batch-api-err',
      providerBatchId: 'msgbatch_api_err',
      status: 'submitted',
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    };
    vi.mocked(db.select).mockReturnValue(mockChain([batch]));
    mockProvider.checkBatch.mockRejectedValue(new Error('Network timeout'));

    const updateCalls = trackUpdates();

    await pollBatchResults();

    // Should NOT have marked batch as failed — error is transient
    const batchFail = updateCalls.find((c) => c.set.status === 'failed');
    expect(batchFail).toBeUndefined();
  });

  it('prevents concurrent execution with a mutex', async () => {
    vi.mocked(db.select).mockReturnValue(mockChain([]));

    // Start first call
    const first = pollBatchResults();

    // Second call while first is in-flight
    await pollBatchResults();

    // db.select was only called once
    expect(db.select).toHaveBeenCalledTimes(1);

    await first;
  });
});

describe('startBatchProcessor / stopBatchProcessor', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env = { ...originalEnv };
    // Ensure no API key so submit/poll return early fast
    delete process.env.ANTHROPIC_API_KEY;
    stopBatchProcessor(); // reset state
  });

  afterEach(() => {
    stopBatchProcessor();
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it('prevents double-starting', () => {
    startBatchProcessor();
    startBatchProcessor(); // should be no-op

    // Verify it doesn't throw and runs cleanly
    expect(() => startBatchProcessor()).not.toThrow();
  });

  it('runs submit then poll sequentially on startup', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(db.select).mockReturnValue(mockChain([]));
    const mockProvider = createMockProvider();
    vi.mocked(AnthropicBatchProvider).mockImplementation(function () { return mockProvider as any; } as any);
    _resetPollingMutex();

    startBatchProcessor();

    // Flush the startup promise chain (submit().then(() => poll()))
    // Use advanceTimersByTime(0) + microtask flush
    await vi.advanceTimersByTimeAsync(0);

    // Both submit and poll should have been called (both query db.select)
    // submit queries for pending questions, poll queries for submitted batches
    expect(db.select).toHaveBeenCalled();
  });

  it('stop clears intervals and allows restart', () => {
    startBatchProcessor();
    stopBatchProcessor();

    // Should be able to start again after stopping
    expect(() => startBatchProcessor()).not.toThrow();
    stopBatchProcessor();
  });

  it('sets up correct interval timings', async () => {
    startBatchProcessor();

    // Flush the startup promise chain
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();

    // Advance 5 minutes — poll interval should fire
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // Advance to 60 minutes total — submit interval should also fire
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);

    stopBatchProcessor();
  });
});
