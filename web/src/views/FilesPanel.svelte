<script lang="ts">
  import { folder } from '../folder.svelte';
  import { ATTRIBUTION, FOLDER, LICENSE, REPOSITORY } from '../example';
  import type { WorkerClient } from '../worker/client';
  import type { FindingsSummary, Summary } from '../worker/protocol';
  import DropZone from './DropZone.svelte';
  import Edge from './Edge.svelte';
  import { Width } from './resize.svelte';
  import EditedFiles from './EditedFiles.svelte';
  import FileTree from './FileTree.svelte';
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
    paths,
    busy,
    kept,
    elapsed,
    findings,
    checking,
    collapsed = $bindable(false),
    onfiles,
    onclear,
    onundo,
    onexclude,
  }: {
    client: WorkerClient;
    version: number;
    summary: Summary;
    /** Each file's path in the folder or archive it came from, by name. */
    paths: Record<string, string>;
    busy: boolean;
    kept: boolean;
    elapsed: number | null;
    findings: FindingsSummary | null;
    checking: boolean;
    collapsed?: boolean;
    onfiles: (files: File[], paths?: string[]) => void;
    onclear: () => void;
    onundo: () => void;
    /** The model to be made of all files but these. */
    onexclude: (excluded: string[]) => void;
  } = $props();

  let names = $derived(summary.files.filter((f) => f.status === 'loaded').map((f) => f.name));

  /** Its width, dragged or keyed at its right edge, kept in this browser. */
  const width = new Width({ key: 'cimlens.files-width', initial: 288, min: 220, max: 640, side: 'right' });
</script>

{#if collapsed}
  <nav class="rail" aria-label="Files, collapsed">
    <button type="button" class="ghost icon" aria-label="Show the files" aria-expanded="false" onclick={() => (collapsed = false)}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4h5l2 2h7v9H2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg>
    </button>
    <span class="sub" title="Files in the model">{names.length - summary.excluded.length}</span>
  </nav>
{:else}
  <div class="panel" style:width={`${width.value}px`}>
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
    {#if Object.values(paths).some((p) => p.startsWith(`${FOLDER}/`))}
      <p class="sub small" data-testid="example-attribution">
        The example: <a href={REPOSITORY} target="_blank" rel="noopener">{ATTRIBUTION}</a>
        (<a href={LICENSE} target="_blank" rel="noopener">licence</a>).
      </p>
    {/if}
    <FileTree {summary} {paths} {busy} {onexclude} />
    <div class="actions">
      <button type="button" disabled={busy} onclick={onclear}>Clear</button>
      {#if elapsed !== null}<span class="sub" data-testid="elapsed">{Math.round(elapsed).toLocaleString('en')} ms</span>{/if}
    </div>
    {#if kept}<p class="sub small" data-testid="kept">Kept in this browser, on this machine, until you clear them.</p>{/if}
    <p class="sub small"><a href="./third-party-licenses.txt" target="_blank" rel="noopener">Licences</a> of the software in cimlens</p>
  </aside>
  <Edge {width} label="Width of the files" />
  </div>
{/if}

<style>
  .panel {
    position: relative;
    flex-shrink: 0;
    height: 100%;
  }

  .files {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
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
    .panel {
      position: absolute;
      top: 0;
      left: 0;
      z-index: 5;
      width: min(18rem, 85vw) !important;
    }

    .files {
      box-shadow: var(--shadow);
    }
  }
</style>
