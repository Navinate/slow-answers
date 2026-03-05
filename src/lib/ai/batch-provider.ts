import Anthropic from '@anthropic-ai/sdk';

export interface BatchRequest {
  questionId: string;
  userPrompt: string;
  systemPrompt: string;
}

export interface BatchSubmitResult {
  providerBatchId: string;
}

export interface BatchStatusResult {
  status: string;
  requestCounts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
}

export interface BatchResultEntry {
  questionId: string;
  type: 'succeeded' | 'errored' | 'expired' | 'canceled';
  content?: string;
  model?: string;
  error?: string;
}

export class AnthropicBatchProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey });
    this.model = model;
  }

  async submitBatch(requests: BatchRequest[]): Promise<BatchSubmitResult> {
    const batch = await this.client.messages.batches.create({
      requests: requests.map((r) => ({
        custom_id: r.questionId,
        params: {
          model: this.model,
          max_tokens: 2048,
          system: r.systemPrompt,
          messages: [{ role: 'user' as const, content: r.userPrompt }],
        },
      })),
    });

    return { providerBatchId: batch.id };
  }

  async checkBatch(providerBatchId: string): Promise<BatchStatusResult> {
    const batch = await this.client.messages.batches.retrieve(providerBatchId);

    return {
      status: batch.processing_status,
      requestCounts: batch.request_counts,
    };
  }

  async getResults(providerBatchId: string): Promise<BatchResultEntry[]> {
    const results = await this.client.messages.batches.results(providerBatchId);
    const entries: BatchResultEntry[] = [];

    for await (const entry of results) {
      if (entry.result.type === 'succeeded') {
        const content = entry.result.message.content[0];
        entries.push({
          questionId: entry.custom_id,
          type: 'succeeded',
          content: content.type === 'text' ? content.text : undefined,
          model: entry.result.message.model,
        });
      } else if (entry.result.type === 'errored') {
        entries.push({
          questionId: entry.custom_id,
          type: 'errored',
          error: entry.result.error.message,
        });
      } else {
        entries.push({
          questionId: entry.custom_id,
          type: entry.result.type,
        });
      }
    }

    return entries;
  }
}
