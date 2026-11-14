<script lang="ts">
  import type { ModelMessage } from 'ai';
  import { pieces } from '../chat/render';
  import { PROVIDERS, providerOf, type ProviderId } from '../chat/providers';
  import type { Part, Status } from '../chat/session';
  import type { WorkerClient } from '../worker/client';
  import type { FindingsSummary } from '../worker/protocol';
  import Edge from './Edge.svelte';
  import { Width } from './resize.svelte';

  /**
   * A chat about the model, on the right: the user's own key, to the provider they choose, straight
   * from the page. Nothing is sent until they ask, and what is sent is said where they type.
   */
  let {
    client,
    findings,
    onnavigate,
    onclose,
  }: {
    client: WorkerClient;
    findings: FindingsSummary | null;
    onnavigate: (id: string) => void;
    onclose: () => void;
  } = $props();

  type Entry = { role: 'user'; text: string } | { role: 'assistant'; parts: Part[]; error?: string };

  const SETTINGS = 'cimlens.chat';
  interface Settings {
    provider: ProviderId;
    models: Partial<Record<ProviderId, string>>;
    /** Keys kept in this browser, by provider: only those the user asked to be. */
    keys: Partial<Record<ProviderId, string>>;
    remember: boolean;
  }
  function load(): Settings {
    const none: Settings = { provider: 'anthropic', models: {}, keys: {}, remember: false };
    try {
      const kept = JSON.parse(localStorage.getItem(SETTINGS) ?? '{}');
      return { ...none, ...kept, provider: providerOf(kept.provider).id };
    } catch {
      return none;
    }
  }
  const initial = load();
  let settings = $state<Settings>(initial);
  /** Keys typed this visit; the kept ones too. */
  let keys = $state<Partial<Record<ProviderId, string>>>({ ...initial.keys });
  $effect(() => {
    const kept: Settings = { ...$state.snapshot(settings), keys: settings.remember ? $state.snapshot(keys) : {} };
    try {
      localStorage.setItem(SETTINGS, JSON.stringify(kept));
    } catch {
      // A convenience.
    }
  });

  let provider = $derived(providerOf(settings.provider));
  let model = $derived(settings.models[settings.provider]?.trim() || provider.model);
  let key = $derived(keys[settings.provider]?.trim() ?? '');
  /** The settings, open from the start until there is a key. */
  let configuring = $state(!initial.keys[initial.provider]);

  let entries = $state<Entry[]>([]);
  let history: ModelMessage[] = [];
  let question = $state('');
  let asking = $state<AbortController | null>(null);
  let log = $state<HTMLElement>();
  /** What the turn waits for, and since when: said under the answer, so a slow step does not look stuck. */
  let status = $state<Status | null>(null);
  let since = $state(0);
  let now = $state(0);
  $effect(() => {
    if (!asking) return;
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });
  let seconds = $derived(Math.max(0, Math.round((now - since) / 1000)));

  function phase(next: Status) {
    if (status?.phase !== next.phase || ('tool' in next && status && 'tool' in status && status.tool !== next.tool)) {
      since = now = Date.now();
    }
    status = next;
  }

  function said(s: Status): string {
    switch (s.phase) {
      case 'waiting':
        return 'Waiting for the model';
      case 'thinking':
        return 'Thinking';
      case 'writing':
        return 'Writing';
      case 'calling':
        return `Asking for ${TOOLS[s.tool]?.toLowerCase() ?? s.tool}`;
      case 'tool':
        return `${RUNNING[s.tool] ?? `Running ${s.tool}`}`;
    }
  }

  const TOOLS: Record<string, string> = {
    summary: 'Read the summary',
    search: 'Searched the model',
    object: 'Read an object',
    validation: 'Read the validation',
    findings: 'Read the findings',
    powerFlow: 'Ran a power flow',
    contingencies: 'Read the contingencies',
    show: 'Showed an object',
  };
  /** The same, while it runs. */
  const RUNNING: Record<string, string> = {
    summary: 'Reading the summary',
    search: 'Searching the model',
    object: 'Reading an object',
    validation: 'Reading the validation',
    findings: 'Reading the findings',
    powerFlow: 'Running a power flow',
    contingencies: 'Reading the contingencies',
    show: 'Showing an object',
  };

  function scroll() {
    setTimeout(() => log?.scrollTo({ top: log.scrollHeight }), 0);
  }

  async function send(event?: Event) {
    event?.preventDefault();
    const text = question.trim();
    if (!text || asking) return;
    if (!key) {
      configuring = true;
      return;
    }
    question = '';
    entries.push({ role: 'user', text });
    entries.push({ role: 'assistant', parts: [] });
    const answer = entries.length - 1;
    const controller = new AbortController();
    asking = controller;
    phase({ phase: 'waiting' });
    scroll();
    try {
      const { ask, describe } = await import('../chat/session');
      try {
        history = await ask({
          provider: settings.provider,
          apiKey: key,
          model,
          history,
          question: text,
          host: { client, findings: () => findings, navigate: onnavigate },
          signal: controller.signal,
          onparts: (parts) => {
            entries[answer] = { role: 'assistant', parts };
            scroll();
          },
          onstatus: phase,
        });
      } catch (failure) {
        const entry = entries[answer];
        if (entry.role === 'assistant') {
          entry.error = controller.signal.aborted ? 'Stopped.' : describe(failure);
          // A tool the turn ended in the middle of did not finish.
          for (const part of entry.parts) if (part.type === 'tool' && part.state === 'running') part.state = 'error';
        }
      }
    } catch (failure) {
      // The chat's code could not be fetched, such as offline before it was ever loaded.
      const entry = entries[answer];
      if (entry.role === 'assistant') entry.error = `The chat could not be loaded: ${failure}`;
    } finally {
      asking = null;
      status = null;
      scroll();
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) void send(event);
  }

  /** Its width, dragged or keyed at its left edge, kept in this browser; wide, but leaving the view beside it some room. */
  const width = new Width({ key: 'cimlens.chat-width', initial: 384, min: 280, max: 960, side: 'left', room: 360 });

  function restart() {
    asking?.abort();
    entries = [];
    history = [];
  }
</script>

<div class="panel" style:width={`${width.value}px`}>
<Edge {width} label="Width of the chat" />
<aside class="chat" aria-label="Chat" data-testid="chat-panel">
  <div class="head">
    <span class="label">Chat</span>
    <span class="model" title={`${provider.label}: ${model}`}>{model}</span>
    <span class="grow"></span>
    <button type="button" class="ghost" disabled={!entries.length} onclick={restart} title="Start a new conversation">New</button>
    <button type="button" class="ghost" aria-expanded={configuring} onclick={() => (configuring = !configuring)}>Settings</button>
    <button type="button" class="ghost icon" aria-label="Close the chat" onclick={onclose}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5"></path></svg>
    </button>
  </div>

  {#if configuring}
    <form class="settings" onsubmit={(e) => { e.preventDefault(); if (key) configuring = false; }}>
      <label>
        Provider
        <select bind:value={settings.provider}>
          {#each PROVIDERS as p (p.id)}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
      </label>
      <label>
        Model
        <input type="text" placeholder={provider.model} spellcheck="false" bind:value={settings.models[settings.provider]} />
      </label>
      <label>
        API key
        <input type="password" autocomplete="off" spellcheck="false" placeholder="Your own key" bind:value={keys[settings.provider]} data-testid="chat-key" />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={settings.remember} /> Keep the key in this browser
      </label>
      <p class="sub small">
        Get a key from <a href={provider.keys} target="_blank" rel="noopener">{provider.label}</a>; you pay them for what you ask. The key
        goes only to them.
      </p>
      <button type="submit" class="primary" disabled={!key}>Done</button>
    </form>
  {/if}

  <div class="log" bind:this={log} aria-live="polite">
    {#if !entries.length}
      <p class="sub notice" data-testid="chat-notice">
        Ask about the model loaded: what is in it, why a check fails, how the power flow comes out. Your questions, and what the
        assistant reads of the model to answer them, go to {provider.label}. Nothing is sent until you ask.
      </p>
    {/if}
    {#each entries as entry, i (i)}
      {#if entry.role === 'user'}
        <div class="msg user">{entry.text}</div>
      {:else}
        <div class="msg assistant">
          {#each entry.parts as part, j (j)}
            {#if part.type === 'tool'}
              <div class="tool" class:error={part.state === 'error'} title={part.error ?? ''}>
                {part.state === 'running' ? `${RUNNING[part.name] ?? part.name}…` : `${TOOLS[part.name] ?? part.name}${part.state === 'error' ? ': failed' : ''}`}
              </div>
            {:else if part.type === 'reasoning'}
              <details class="reasoning">
                <summary>Thought</summary>
                <div class="text">{part.text}</div>
              </details>
            {:else if part.type === 'note'}
              <div class="note" data-testid="chat-note">{part.text}</div>
            {:else}
              <div class="text">
                {#each pieces(part.text) as p, k (k)}
                  {#if p.type === 'object'}
                    <a href={`#object:${p.id}`} onclick={(e) => { e.preventDefault(); onnavigate(p.id); }}>{p.text}</a>
                  {:else if p.type === 'link'}
                    <a href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a>
                  {:else if p.type === 'code'}
                    <code>{p.text}</code>
                  {:else if p.type === 'bold'}
                    <strong>{p.text}</strong>
                  {:else}
                    {p.text}
                  {/if}
                {/each}
              </div>
            {/if}
          {/each}
          {#if i === entries.length - 1 && asking && status && !entry.error}
            <div class="status" data-testid="chat-status">{said(status)}… {seconds >= 3 ? `${seconds} s` : ''}</div>
          {/if}
          {#if entry.error}
            <div class="failure" role="alert">{entry.error}</div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <form class="ask" onsubmit={send}>
    <textarea rows="3" placeholder="Ask about the model" bind:value={question} onkeydown={keydown} data-testid="chat-input"></textarea>
    {#if asking}
      <button type="button" onclick={() => asking?.abort()}>Stop</button>
    {:else}
      <button type="submit" class="primary" disabled={!question.trim()}>Send</button>
    {/if}
  </form>
</aside>
</div>

<style>
  .panel {
    position: relative;
    flex-shrink: 0;
    height: 100%;
  }


  .chat {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--surface);
    border-left: 1px solid var(--line);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.4rem 0.4rem 0.4rem 0.75rem;
    border-bottom: 1px solid var(--line);
  }

  .label {
    color: var(--text-3);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .model {
    min-width: 0;
    margin-left: 0.4rem;
    overflow: hidden;
    color: var(--text-3);
    font-size: 0.8rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grow {
    flex-grow: 1;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    padding: 0;
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.75rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
  }

  .settings label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }

  .settings label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }

  .settings button {
    align-self: flex-end;
  }

  .small {
    margin: 0;
    font-size: 0.8rem;
  }

  .log {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    padding: 0.75rem;
    overflow-y: auto;
  }

  .notice {
    margin: 0;
    font-size: 0.85rem;
  }

  .msg {
    overflow-wrap: anywhere;
    line-height: 1.45;
  }

  .msg.user {
    align-self: flex-end;
    max-width: 85%;
    padding: 0.45rem 0.65rem;
    border-radius: var(--radius-l);
    background: var(--accent-soft);
    white-space: pre-wrap;
  }

  .msg.assistant {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .text {
    white-space: pre-wrap;
  }

  .tool {
    align-self: flex-start;
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 1rem;
    color: var(--text-3);
    font-size: 0.78rem;
  }

  .tool.error {
    color: var(--warning);
  }

  .status {
    color: var(--text-3);
    font-size: 0.8rem;
  }

  .reasoning {
    color: var(--text-3);
    font-size: 0.82rem;
  }

  .reasoning summary {
    cursor: pointer;
  }

  .note {
    color: var(--text-2);
    font-size: 0.85rem;
    font-style: italic;
  }

  .failure {
    padding: 0.4rem 0.6rem;
    border-radius: var(--radius);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: 0.85rem;
  }

  code {
    font-family: var(--mono);
    font-size: 0.9em;
  }

  .ask {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid var(--line);
  }

  .ask textarea {
    flex: 1 1 auto;
    padding: 0.4rem 0.5rem;
    resize: none;
  }

  /* On a phone the chat lies over the view, as wide as it can be, and is not resized. */
  @media (max-width: 48rem) {
    .panel {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 5;
      width: min(24rem, 100%) !important;
    }

    .chat {
      box-shadow: var(--shadow);
    }

  }
</style>
