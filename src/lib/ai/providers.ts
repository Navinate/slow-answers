import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface AIResponse {
  content: string;
  model: string;
}

export interface AIProvider {
  name: string;
  generateResponse(prompt: string, systemPrompt?: string): Promise<AIResponse>;
}

export class AnthropicProvider implements AIProvider {
  name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = 'claude-3-haiku-20240307') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async generateResponse(prompt: string, systemPrompt?: string): Promise<AIResponse> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    return {
      content: content.text,
      model: `anthropic/${this.model}`
    };
  }
}

export class OpenAIProvider implements AIProvider {
  name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = 'gpt-4o-mini') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async generateResponse(prompt: string, systemPrompt?: string): Promise<AIResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 2048,
      messages
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response content');
    }

    return {
      content,
      model: `openai/${this.model}`
    };
  }
}

export function createProvider(): AIProvider {
  // Try Anthropic first (cheaper for Haiku), then OpenAI
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(
      process.env.ANTHROPIC_API_KEY,
      process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307'
    );
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider(
      process.env.OPENAI_API_KEY,
      process.env.OPENAI_MODEL || 'gpt-4o-mini'
    );
  }

  throw new Error('No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
}
