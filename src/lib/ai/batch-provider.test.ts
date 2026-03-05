import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicBatchProvider } from './batch-provider';
import type { BatchRequest } from './batch-provider';

// We'll inject a mock client rather than mocking the module.
// The constructor accepts an optional client parameter for testing.

function createMockClient() {
  return {
    messages: {
      batches: {
        create: vi.fn(),
        retrieve: vi.fn(),
        results: vi.fn(),
      },
    },
  };
}

describe('AnthropicBatchProvider', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let provider: AnthropicBatchProvider;

  beforeEach(() => {
    mockClient = createMockClient();
    provider = new AnthropicBatchProvider('test-key', 'claude-haiku-4-5-20251001', mockClient as any);
  });

  describe('submitBatch', () => {
    it('maps BatchRequests to Anthropic SDK format and returns providerBatchId', async () => {
      const requests: BatchRequest[] = [
        {
          questionId: 'q-1',
          userPrompt: 'What is 2+2?',
          systemPrompt: 'Be concise.',
        },
        {
          questionId: 'q-2',
          userPrompt: 'Explain gravity.',
          systemPrompt: 'Be thorough.',
        },
      ];

      mockClient.messages.batches.create.mockResolvedValue({
        id: 'msgbatch_abc123',
        processing_status: 'in_progress',
      });

      const result = await provider.submitBatch(requests);

      // Verify the SDK was called with correctly mapped requests
      expect(mockClient.messages.batches.create).toHaveBeenCalledWith({
        requests: [
          {
            custom_id: 'q-1',
            params: {
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 2048,
              system: 'Be concise.',
              messages: [{ role: 'user', content: 'What is 2+2?' }],
            },
          },
          {
            custom_id: 'q-2',
            params: {
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 2048,
              system: 'Be thorough.',
              messages: [{ role: 'user', content: 'Explain gravity.' }],
            },
          },
        ],
      });

      // Verify the result maps the batch ID
      expect(result).toEqual({ providerBatchId: 'msgbatch_abc123' });
    });

    it('propagates API errors', async () => {
      mockClient.messages.batches.create.mockRejectedValue(
        new Error('API rate limit exceeded'),
      );

      await expect(
        provider.submitBatch([
          { questionId: 'q-1', userPrompt: 'test', systemPrompt: 'test' },
        ]),
      ).rejects.toThrow('API rate limit exceeded');
    });
  });

  describe('checkBatch', () => {
    it('returns processing status and request counts', async () => {
      mockClient.messages.batches.retrieve.mockResolvedValue({
        id: 'msgbatch_abc123',
        processing_status: 'in_progress',
        request_counts: {
          processing: 3,
          succeeded: 2,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      });

      const result = await provider.checkBatch('msgbatch_abc123');

      expect(mockClient.messages.batches.retrieve).toHaveBeenCalledWith('msgbatch_abc123');
      expect(result).toEqual({
        status: 'in_progress',
        requestCounts: {
          processing: 3,
          succeeded: 2,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      });
    });
  });

  describe('getResults', () => {
    it('extracts text content and model from succeeded entries', async () => {
      const mockResults = [
        {
          custom_id: 'q-1',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'text', text: 'The answer is 4.' }],
              model: 'claude-haiku-4-5-20251001',
            },
          },
        },
      ];
      mockClient.messages.batches.results.mockResolvedValue(mockResults);

      const results = await provider.getResults('msgbatch_abc123');

      expect(results).toEqual([
        {
          questionId: 'q-1',
          type: 'succeeded',
          content: 'The answer is 4.',
          model: 'claude-haiku-4-5-20251001',
        },
      ]);
    });

    it('extracts error message from errored entries', async () => {
      const mockResults = [
        {
          custom_id: 'q-2',
          result: {
            type: 'errored',
            error: { type: 'error', message: 'Content too long' },
          },
        },
      ];
      mockClient.messages.batches.results.mockResolvedValue(mockResults);

      const results = await provider.getResults('msgbatch_abc123');

      expect(results).toEqual([
        {
          questionId: 'q-2',
          type: 'errored',
          error: 'Content too long',
        },
      ]);
    });

    it('records type for expired and canceled entries', async () => {
      const mockResults = [
        { custom_id: 'q-3', result: { type: 'expired' } },
        { custom_id: 'q-4', result: { type: 'canceled' } },
      ];
      mockClient.messages.batches.results.mockResolvedValue(mockResults);

      const results = await provider.getResults('msgbatch_abc123');

      expect(results).toEqual([
        { questionId: 'q-3', type: 'expired' },
        { questionId: 'q-4', type: 'canceled' },
      ]);
    });

    it('handles mixed result types in a single batch', async () => {
      const mockResults = [
        {
          custom_id: 'q-1',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'text', text: 'Answer here.' }],
              model: 'claude-haiku-4-5-20251001',
            },
          },
        },
        {
          custom_id: 'q-2',
          result: {
            type: 'errored',
            error: { type: 'error', message: 'Server error' },
          },
        },
        { custom_id: 'q-3', result: { type: 'expired' } },
      ];
      mockClient.messages.batches.results.mockResolvedValue(mockResults);

      const results = await provider.getResults('msgbatch_abc123');

      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ questionId: 'q-1', type: 'succeeded', content: 'Answer here.' });
      expect(results[1]).toMatchObject({ questionId: 'q-2', type: 'errored', error: 'Server error' });
      expect(results[2]).toMatchObject({ questionId: 'q-3', type: 'expired' });
    });
  });
});
