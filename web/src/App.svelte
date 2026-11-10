<script lang="ts">
  import { onMount } from 'svelte';
  import { droppedFiles } from './drop';
  import Browse from './views/Browse.svelte';
  import DropZone from './views/DropZone.svelte';
  import FindingsView from './views/FindingsView.svelte';
  import SummaryView from './views/SummaryView.svelte';
  import { WorkerClient } from './worker/client';
  import type { Checks, FindingsSummary, Summary } from './worker/protocol';
  import ModelWorker from './worker/worker?worker';

  const client = new WorkerClient(() => new ModelWorker());

  let summary = $state<Summary | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let elapsed = $state<number | null>(null);

  let kept = $state(false);
  /** Files are being dragged over the page. */
  let dragging = $state(false);
  /** What a drop came to, when that was nothing. */
  let notice = $state<string | null>(null);
  /** A drag that started on this page, such as of selected text, is not for us. */
  let dragFromPage = false;

  /** Whether a drag is one to take: from outside, and not onto a box that takes text. */
  function ours(event: DragEvent): boolean {
    return !dragFromPage && !(event.target instanceof Element && event.target.closest('input[type=search]'));
  }

  function over(event: DragEvent) {
    if (!ours(event)) return;
    event.preventDefault();
    dragging = true;
  }

  function left(event: DragEvent) {
    // Moving between the page's elements leaves each of them; only leaving the window has no next.
    if (!event.relatedTarget) dragging = false;
  }

  async function dropped(event: DragEvent) {
    if (!ours(event)) return;
    // Left alone, the browser would replace the page with the file.
    event.preventDefault();
    dragging = false;
    notice = null;
    if (!event.dataTransfer) return;
    // The browser's own word on what this holds; the drop is gone once anything waits.
    const heldFiles = event.dataTransfer.types.includes('Files');
    let files: File[];
    try {
      files = await droppedFiles(event.dataTransfer);
    } catch (failure) {
      notice = `That folder could not be read: ${failure}`;
      return;
    }
    if (files.length) await run({ kind: 'load', files });
    else if (heldFiles) notice = 'There are no XML files in that folder.';
    // Firefox's snap on Ubuntu 26.04 hands over an empty drop from the Files app, types and all.
    else notice = 'No files came through in that drop: the browser did not pass them on. Choose them with the button above instead.';
  }
  /** Counts the model's changes, for the views to ask again. */
  let version = $state(0);
  let objects = $derived((summary?.objects ?? 0) > 0);

  let findings = $state.raw<FindingsSummary | null>(null);
  let checking = $state(false);
  /** Counts validations, for the views to show the findings. */
  let findingsVersion = $state(0);
  const CHECKS = 'gridox.checks';
  let checks = $state<Checks>(storedChecks());
  let browse = $state<Browse>();

  /** The checks chosen last time, in this browser. */
  function storedChecks(): Checks {
    try {
      const { common, quality } = JSON.parse(localStorage.getItem(CHECKS) ?? '{}');
      return { common: common === true, quality: quality === true };
    } catch {
      return { common: false, quality: false };
    }
  }

  function changeChecks(chosen: Checks) {
    checks = chosen;
    try {
      localStorage.setItem(CHECKS, JSON.stringify(chosen));
    } catch {
      // Remembering is a convenience.
    }
    void enqueue(validate);
  }

  type ModelRequest = { kind: 'load'; files: File[] } | { kind: 'restore' } | { kind: 'clear' };

  /** One at a time, in the order asked: a drop while kept files come back waits for them. */
  let queue: Promise<void> = Promise.resolve();
  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task);
    return queue;
  }

  function run(request: ModelRequest): Promise<void> {
    return enqueue(() => perform(request));
  }

  /** Validates the model as it is now, after whatever was asked before. */
  async function validate() {
    if (!objects) return;
    checking = true;
    try {
      findings = await client.request<'validate'>({ kind: 'validate', ...checks });
      findingsVersion += 1;
    } catch (failure) {
      findings = null;
      error = `Validation failed: ${failure}`;
    } finally {
      checking = false;
    }
  }

  async function perform(request: ModelRequest) {
    busy = true;
    error = null;
    notice = null;
    const started = performance.now();
    try {
      ({ summary, kept } = await client.request<typeof request.kind>(request as never));
      version += 1;
      findings = null;
      elapsed = performance.now() - started;
      // After this one, so that it reads every file loaded.
      if (objects) void enqueue(validate);
    } catch (failure) {
      // The worker, and the model it held, may be gone: nothing shown can still be trusted.
      summary = null;
      kept = false;
      elapsed = null;
      error = String(failure);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void run({ kind: 'restore' });
  });
</script>

<svelte:window
  ondragstart={() => (dragFromPage = true)}
  ondragend={() => (dragFromPage = false)}
  ondragover={over}
  ondragleave={left}
  ondrop={dropped}
/>

{#if dragging}
  <div class="drop" data-testid="drop-overlay">Drop to read them here. Nothing is uploaded.</div>
{/if}

<main class:wide={objects}>
  <header>
    <h1>gridox</h1>
    <p>Power system models in your browser.</p>
  </header>

  <DropZone {busy} compact={objects} onfiles={(files) => run({ kind: 'load', files })} />

  {#if notice}
    <p role="status" class="notice" data-testid="notice">{notice}</p>
  {/if}

  {#if error}
    <p role="alert" data-testid="error">Something went wrong, and the model was lost: {error}</p>
    <!-- A kept file that brings the worker down would do so at every visit. -->
    <button type="button" disabled={busy} onclick={() => run({ kind: 'clear' })}>Clear the kept files</button>
  {/if}

  {#if summary && summary.files.length}
    <div class="actions">
      <button type="button" disabled={busy} onclick={() => run({ kind: 'clear' })}>Clear</button>
      {#if elapsed !== null}<span data-testid="elapsed">{Math.round(elapsed).toLocaleString('en')} ms</span>{/if}
      {#if kept}<span data-testid="kept">Kept in this browser, on this machine, until you clear them.</span>{/if}
    </div>
    <SummaryView {summary} />
    {#if objects}
      <FindingsView {client} {findings} {checking} {checks} onchecks={changeChecks} onnavigate={(id) => browse?.navigate(id)} />
      <Browse bind:this={browse} {client} {version} {findingsVersion} validated={findings !== null} />
    {/if}
  {/if}
</main>

<style>
  .drop {
    position: fixed;
    inset: 0.5rem;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    border: 3px dashed var(--accent);
    border-radius: 0.5rem;
    background: var(--panel);
    font-weight: 600;
    text-align: center;
    opacity: 0.92;
    /* The drop goes to what is under it, and on up to the window. */
    pointer-events: none;
  }

  .notice {
    color: var(--warn);
  }

  main.wide {
    max-width: none;
  }

  header p {
    margin: 0 0 1rem;
    color: var(--muted);
  }

  [role='alert'] {
    color: var(--warn);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .actions span {
    color: var(--muted);
  }

  button {
    min-height: 2.25rem;
    padding: 0 0.75rem;
    font: inherit;
  }
</style>
