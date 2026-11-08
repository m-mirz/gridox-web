<script lang="ts">
  import DropZone from './views/DropZone.svelte';
  import SummaryView from './views/SummaryView.svelte';
  import { WorkerClient } from './worker/client';
  import type { Request, Summary } from './worker/protocol';
  import ModelWorker from './worker/worker?worker';

  const client = new WorkerClient(() => new ModelWorker());

  let summary = $state<Summary | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let elapsed = $state<number | null>(null);

  async function run(request: Request) {
    busy = true;
    error = null;
    const started = performance.now();
    try {
      summary = await client.request(request);
      elapsed = performance.now() - started;
    } catch (failure) {
      // The worker, and the model it held, may be gone: nothing shown can still be trusted.
      summary = null;
      elapsed = null;
      error = String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <header>
    <h1>gridox</h1>
    <p>Power system models in your browser.</p>
  </header>

  <DropZone {busy} onfiles={(files) => run({ kind: 'load', files })} />

  {#if error}
    <p role="alert" data-testid="error">Something went wrong, and the model was lost: {error}</p>
  {/if}

  {#if summary && summary.files.length}
    <div class="actions">
      <button type="button" disabled={busy} onclick={() => run({ kind: 'clear' })}>Clear</button>
      {#if elapsed !== null}<span data-testid="elapsed">{Math.round(elapsed).toLocaleString('en')} ms</span>{/if}
    </div>
    <SummaryView {summary} />
  {/if}
</main>

<style>
  header p {
    margin: 0 0 1rem;
    color: var(--muted);
  }

  [role='alert'] {
    color: var(--warn);
  }

  .actions {
    display: flex;
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
