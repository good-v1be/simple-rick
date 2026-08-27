import { describe, it, expect } from 'vitest';
import { createProviders } from '../services/ai-providers.js';

describe('createProviders', () => {
  it('selects OpenAI when OPENAI_API_KEY is set', () => {
    const { embedding, chat } = createProviders({ OPENAI_API_KEY: 'test' });
    expect(embedding.name).toBe('openai');
    expect(embedding.dimension).toBe(1536);
    expect(chat.name).toBe('openai');
  });

  it('selects Google when GOOGLE_API_KEY is set', () => {
    const { embedding, chat } = createProviders({ GOOGLE_API_KEY: 'test' });
    expect(embedding.name).toBe('google');
    expect(embedding.dimension).toBe(768);
    expect(chat.name).toBe('google');
  });

  it('selects Mistral when MISTRAL_API_KEY is set', () => {
    const { embedding, chat } = createProviders({ MISTRAL_API_KEY: 'test' });
    expect(embedding.name).toBe('mistral');
    expect(embedding.dimension).toBe(1024);
    expect(chat.name).toBe('mistral');
  });

  it('selects Voyage + Haiku when ANTHROPIC_API_KEY and VOYAGE_API_KEY are set', () => {
    const { embedding, chat } = createProviders({ ANTHROPIC_API_KEY: 'x', VOYAGE_API_KEY: 'y' });
    expect(embedding.name).toBe('voyage');
    expect(embedding.dimension).toBe(1024);
    expect(chat.name).toBe('haiku');
  });

  it('throws when ANTHROPIC_API_KEY is set without VOYAGE_API_KEY', () => {
    expect(() => createProviders({ ANTHROPIC_API_KEY: 'x' })).toThrow('VOYAGE_API_KEY');
  });

  it('throws when no API keys are set', () => {
    expect(() => createProviders({})).toThrow('No AI provider configured');
  });

  it('prefers OpenAI over other providers when multiple keys are set', () => {
    const { embedding, chat } = createProviders({
      OPENAI_API_KEY: 'a',
      GOOGLE_API_KEY: 'b',
      MISTRAL_API_KEY: 'c',
    });
    expect(embedding.name).toBe('openai');
    expect(chat.name).toBe('openai');
  });
});
