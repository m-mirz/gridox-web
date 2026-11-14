/**
 * The model providers the chat can talk to, each with the user's own key, straight from the page.
 * Each host is also in the Content-Security-Policy's connect-src (vite.config.ts): nothing else
 * can be reached.
 */

import type { JSONValue, LanguageModel } from 'ai';

export type ProviderId = 'anthropic' | 'openai' | 'google';

export interface Provider {
  id: ProviderId;
  label: string;
  /** The model asked for unless another is typed in. */
  model: string;
  /** Where the key comes from, for the settings. */
  keys: string;
  host: string;
}

export const PROVIDERS: Provider[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', model: 'claude-opus-5-5', keys: 'https://platform.claude.com/settings/keys', host: 'https://api.anthropic.com' },
  { id: 'openai', label: 'OpenAI', model: 'gpt-6-astra', keys: 'https://platform.openai.com/api-keys', host: 'https://api.openai.com' },
  { id: 'google', label: 'Google (Gemini)', model: 'gemini-4-argon', keys: 'https://aistudio.google.com/apikey', host: 'https://generativelanguage.googleapis.com' },
];

export const providerOf = (id: ProviderId): Provider => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

/** The model, its provider's library loaded only now: the page without the chat never fetches it. */
export async function languageModel(id: ProviderId, apiKey: string, model: string): Promise<LanguageModel> {
  switch (id) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      // Anthropic answers a page's requests only when it says it means to send the key from one.
      return createAnthropic({ apiKey, headers: { 'anthropic-dangerous-direct-browser-access': 'true' } })(model);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(model);
    }
    case 'google': {
      const { createGoogle } = await import('@ai-sdk/google');
      return createGoogle({ apiKey })(model);
    }
  }
}

/**
 * Options for the provider. Each sends a summary of its reasoning where it can, so that the panel
 * shows something while a model thinks rather than sitting still. Claude's newest models also retry
 * a turn their classifiers block on another model, and think at medium effort: enough for questions
 * about a model, without long waits.
 */
export function providerOptions(id: ProviderId, model: string): Record<string, Record<string, JSONValue>> {
  switch (id) {
    case 'anthropic': {
      const newest = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
      return {
        anthropic: {
          thinking: { type: 'adaptive' as const, display: 'summarized' as const },
          ...(newest ? { fallbacks: 'default' as const, effort: 'medium' as const } : {}),
        },
      };
    }
    case 'openai':
      // Models that do not reason ignore it, with a warning.
      return { openai: { reasoningSummary: 'auto' } };
    case 'google':
      return { google: { thinkingConfig: { includeThoughts: true } } };
  }
}
