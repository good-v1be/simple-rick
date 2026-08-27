/**
 * AI provider auto-detection for embedding and chat completion.
 * Supports OpenAI, Google, Mistral, and Voyage+Anthropic.
 * Detection order: OPENAI → GOOGLE → MISTRAL → ANTHROPIC (requires VOYAGE).
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export interface EmbeddingProvider {
  embed(text: string, inputType?: 'document' | 'query'): Promise<number[]>;
  readonly dimension: number;
  readonly name: string;
}

export interface ChatProvider {
  chat(system: string, user: string): Promise<string>;
  readonly name: string;
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

export class OpenAIEmbedding implements EmbeddingProvider {
  readonly dimension = 1536;
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return res.data[0]!.embedding;
  }
}

export class OpenAIChat implements ChatProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(system: string, user: string): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });
    return res.choices[0]?.message?.content ?? '';
  }
}

// ── Google ───────────────────────────────────────────────────────────────────

export class GoogleEmbedding implements EmbeddingProvider {
  readonly dimension = 768;
  readonly name = 'google';

  constructor(private apiKey: string) {}

  async embed(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    });
    if (!res.ok) throw new Error(`Google Embedding API ${res.status}`);
    const data = await res.json() as { embedding: { values: number[] } };
    return data.embedding.values;
  }
}

export class GoogleChat implements ChatProvider {
  readonly name = 'google';

  constructor(private apiKey: string) {}

  async chat(system: string, user: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
      }),
    });
    if (!res.ok) throw new Error(`Google Chat API ${res.status}`);
    const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return data.candidates[0]?.content?.parts[0]?.text ?? '';
  }
}

// ── Mistral ─────────────────────────────────────────────────────────────────

export class MistralEmbedding implements EmbeddingProvider {
  readonly dimension = 1024;
  readonly name = 'mistral';

  constructor(private apiKey: string) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch('https://api.mistral.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'mistral-embed', input: [text] }),
    });
    if (!res.ok) throw new Error(`Mistral Embedding API ${res.status}`);
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]!.embedding;
  }
}

export class MistralChat implements ChatProvider {
  readonly name = 'mistral';

  constructor(private apiKey: string) {}

  async chat(system: string, user: string): Promise<string> {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistral-small-latest',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });
    if (!res.ok) throw new Error(`Mistral Chat API ${res.status}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }
}

// ── Voyage + Anthropic ──────────────────────────────────────────────────────

export class VoyageEmbedding implements EmbeddingProvider {
  readonly dimension = 1024;
  readonly name = 'voyage';

  constructor(private apiKey: string) {}

  async embed(text: string, inputType: 'document' | 'query' = 'document'): Promise<number[]> {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'voyage-3', input: text, input_type: inputType }),
    });
    if (!res.ok) throw new Error(`Voyage API ${res.status}`);
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]!.embedding;
  }
}

export class HaikuChat implements ChatProvider {
  readonly name = 'haiku';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(system: string, user: string): Promise<string> {
    const res = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = res.content[0];
    return block?.type === 'text' ? block.text : '';
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createProviders(env: Record<string, string | undefined>): {
  embedding: EmbeddingProvider;
  chat: ChatProvider;
} {
  if (env['OPENAI_API_KEY']) {
    const key = env['OPENAI_API_KEY']!;
    console.error('[simple-rick] Provider: OpenAI (text-embedding-3-small + gpt-4o-mini)');
    return { embedding: new OpenAIEmbedding(key), chat: new OpenAIChat(key) };
  }

  if (env['GOOGLE_API_KEY']) {
    const key = env['GOOGLE_API_KEY']!;
    console.error('[simple-rick] Provider: Google (text-embedding-004 + gemini-2.0-flash)');
    return { embedding: new GoogleEmbedding(key), chat: new GoogleChat(key) };
  }

  if (env['MISTRAL_API_KEY']) {
    const key = env['MISTRAL_API_KEY']!;
    console.error('[simple-rick] Provider: Mistral (mistral-embed + mistral-small-latest)');
    return { embedding: new MistralEmbedding(key), chat: new MistralChat(key) };
  }

  if (env['ANTHROPIC_API_KEY']) {
    const voyageKey = env['VOYAGE_API_KEY'];
    if (!voyageKey) {
      throw new Error('ANTHROPIC_API_KEY requires VOYAGE_API_KEY for embeddings');
    }
    console.error('[simple-rick] Provider: Voyage (voyage-3) + Anthropic (claude-haiku-4.5)');
    return { embedding: new VoyageEmbedding(voyageKey), chat: new HaikuChat(env['ANTHROPIC_API_KEY']!) };
  }

  throw new Error('No AI provider configured. Set one of: OPENAI_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, or ANTHROPIC_API_KEY + VOYAGE_API_KEY');
}
