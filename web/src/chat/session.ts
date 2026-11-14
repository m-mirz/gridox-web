/**
 * One turn of the chat: the user's question to the model, with the tools, until it has answered.
 * Loaded only when the chat sends something, with the AI SDK and zod.
 */

import { APICallError, isStepCount, streamText, type ModelMessage } from 'ai';
import { languageModel, providerOptions, type ProviderId } from './providers';
import { INSTRUCTIONS, chatTools, type ToolHost } from './tools';

/** What the panel shows of an answer, as it comes. */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'done' | 'error'; error?: string }
  | { type: 'note'; text: string };

/** What the turn waits for now, for the panel to say. */
export type Status = { phase: 'waiting' | 'thinking' | 'writing' } | { phase: 'calling' | 'tool'; tool: string };

export interface Turn {
  provider: ProviderId;
  apiKey: string;
  model: string;
  /** The conversation so far, as the model was sent and answered it. */
  history: ModelMessage[];
  question: string;
  host: ToolHost;
  signal: AbortSignal;
  /** The answer so far, each time it grows. */
  onparts: (parts: Part[]) => void;
  onstatus: (status: Status) => void;
}

/** How many model calls a question may take: each tool call is one more. */
const STEPS = 12;

/**
 * How long to wait before giving up, rather than wait for ever: for a model's first output in a
 * step (thinking may come only as it ends), between its outputs, and for a tool, whose request to
 * the worker may wait behind the page's own, such as validating a large model.
 */
const TIMEOUT = { firstChunkMs: 180_000, chunkMs: 90_000, toolMs: 180_000 };

/** Asks, and answers the conversation with the question and the answer in it. Throws what failed. */
export async function ask({ provider, apiKey, model, history, question, host, signal, onparts, onstatus }: Turn): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [...history, { role: 'user', content: question }];
  const parts: Part[] = [];
  const emit = () => onparts(parts.map((p) => ({ ...p })));
  /** Adds to the last part if it is of the kind, or starts one. */
  const grow = (type: 'text' | 'reasoning', text: string) => {
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
    emit();
  };
  let failure: unknown = null;
  let aborted: string | null = null;

  onstatus({ phase: 'waiting' });
  const result = streamText({
    model: await languageModel(provider, apiKey, model),
    instructions: INSTRUCTIONS,
    messages,
    tools: chatTools(host),
    stopWhen: isStepCount(STEPS),
    providerOptions: providerOptions(provider, model),
    abortSignal: signal,
    timeout: TIMEOUT,
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'start-step':
        onstatus({ phase: 'waiting' });
        break;
      case 'reasoning-start':
        onstatus({ phase: 'thinking' });
        break;
      case 'reasoning-delta':
        onstatus({ phase: 'thinking' });
        if (part.text) grow('reasoning', part.text);
        break;
      case 'text-delta':
        onstatus({ phase: 'writing' });
        grow('text', part.text);
        break;
      case 'tool-input-start':
        onstatus({ phase: 'calling', tool: part.toolName });
        break;
      case 'tool-call':
        onstatus({ phase: 'tool', tool: part.toolName });
        parts.push({ type: 'tool', id: part.toolCallId, name: part.toolName, state: 'running' });
        emit();
        break;
      case 'tool-result':
      case 'tool-error': {
        const call = parts.find((p) => p.type === 'tool' && p.id === part.toolCallId);
        if (call?.type === 'tool') {
          call.state = part.type === 'tool-result' ? 'done' : 'error';
          if (part.type === 'tool-error') call.error = describe(part.error);
        }
        // The model goes on with what the tool found.
        onstatus({ phase: 'waiting' });
        emit();
        break;
      }
      case 'finish': {
        const note = ending(part.finishReason, parts);
        if (note) {
          parts.push({ type: 'note', text: note });
          emit();
        }
        break;
      }
      case 'abort':
        aborted = part.reason ?? 'Stopped.';
        break;
      case 'error':
        failure = part.error;
        break;
    }
  }
  if (failure) throw new Error(describe(failure));
  if (aborted !== null) throw new Error(signal.aborted ? 'Stopped.' : aborted);
  return [...messages, ...(await result.responseMessages)];
}

/** Why a turn ended without its answer, when it did. */
function ending(reason: string, parts: Part[]): string | null {
  if (reason === 'content-filter') return 'The provider declined to answer this.';
  if (reason === 'length') return 'The answer was cut short at the length limit.';
  // A last step that called tools: it ran out of steps before it answered.
  if (reason === 'tool-calls') return `It stopped after ${STEPS} steps without an answer. Ask it to go on, or ask something narrower.`;
  if (!parts.some((p) => p.type === 'text' && p.text.trim())) return 'The model ended without an answer. Try asking again.';
  return null;
}

/** An error as the user can act on it. */
export function describe(error: unknown): string {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) return 'The provider refused the key: check it in the settings.';
    if (error.statusCode === 404) return `The provider does not know that model: ${error.message}`;
    if (error.statusCode === 429) return 'Too many requests, or the key has no credit left: try again later.';
    return `${error.statusCode ?? 'The request'}: ${error.message}`;
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `Nothing came for too long, and the turn was given up (${error.message}). The provider may be busy: try again.`;
  }
  if (error instanceof TypeError && /fetch/i.test(error.message)) return 'The provider could not be reached: are you offline?';
  return error instanceof Error ? error.message : String(error);
}
