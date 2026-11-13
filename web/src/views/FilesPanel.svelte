<script lang="ts">
  import { folder } from '../folder.svelte';
  import type { WorkerClient } from '../worker/client';
  import type { FindingsSummary, Summary } from '../worker/protocol';
  import DropZone from './DropZone.svelte';
  import EditedFiles from './EditedFiles.svelte';
  import FolderBar from './FolderBar.svelte';
  import SummaryView from './SummaryView.svelte';

  /**
   * The Files sidebar: what is loaded and from where, adding more, the folder edits are saved into,
   * the files edited, and clearing it all. Always there; collapsed to a rail, it says how many files.
   */
  let {
    client,
    version,
    summary,
    busy,
    kept,
    elapsed,
    findings,
    checking,
    collapsed = $bindable(false),
    onfiles,
    onclear,
    onundo,
  }: {
    client: WorkerClient;
    version: number;
    summary: Summary;
    busy: boolean;
    kept: boolean;
    elapsed: number | null;
    findings: FindingsSummary | null;
    checking: boolean;
    collapsed?: boolean;
    onfiles: (files: File[]) => void;
    onclear: () => void;
    onundo: () => void;
  } = $props();

  let names = $derived(summary.files.filter((f) => f.status === 'loaded').map((f) => f.name));
</script>

{#if collapsed}
  <nav class="rail" aria-label="Files, collapsed">
    <button type="button" class="ghost icon" aria-label="Show the files" aria-expanded="false" onclick={() => (collapsed = false)}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4h5l2 2h7v9H2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg>
    </button>
    <span class="sub" title="Files loaded">{names.length}</span>
  </nav>
{:else}
  <aside class="files" aria-label="Files" data-testid="files-panel">
    <div class="head">
      <span class="label">Files</span>
      <button type="button" class="ghost icon" aria-label="Collapse the files" aria-expanded="true" onclick={() => (collapsed = true)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 3L5 7l4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>
      </button>
    </div>
    <DropZone {busy} compact={true} {onfiles} />
    <FolderBar {client} {version} {names} ready={!checking && findings !== null} />
    <EditedFiles {client} {version} {findings} {checking} folderOpen={folder.connected} {onundo} />
    <SummaryView {summary} part="files" />
    <div class="actions">
      <button type="button" disabled={busy} onclick={onclear}>Clear</button>
      {#if elapsed !== null}<span class="sub" data-testid="elapsed">{Math.round(elapsed).toLocaleString('en')} ms</span>{/if}
    </div>
    {#if kept}<p class="sub small" data-testid="kept">Kept in this browser, on this machine, until you clear them.</p>{/if}
  </aside>
{/if}

<style>
  .files {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 18rem;
    height: 100%;
    padding: 0.75rem;
    overflow-y: auto;
    background: var(--surface);
    border-right: 1px solid var(--line);
  }

  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    width: 3rem;
    height: 100%;
    padding-top: 0.6rem;
    background: var(--surface);
    border-right: 1px solid var(--line);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .label {
    color: var(--text-3);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    padding: 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .small {
    margin: 0;
    font-size: 0.8rem;
  }

  /* On a phone: over the view, not beside it. */
  @media (max-width: 48rem) {
    .files {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 5;
      width: min(18rem, 85vw);
      box-shadow: var(--shadow);
    }
  }
</style>
