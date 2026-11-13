<script lang="ts">
  import { findingsText } from '../grid/model';
  import type { WorkerClient } from '../worker/client';
  import type { EditState, FindingsSummary } from '../worker/protocol';

  /**
   * The files edited since they were loaded, as they are now: undo the last edit, download each,
   * or, where the browser can, save them all into a folder. They go out validated: not while
   * validation of them is under way, and with what it found said beside them.
   */
  let {
    client,
    version,
    findings,
    checking,
    onundo,
  }: {
    client: WorkerClient;
    /** Changes when the model does. */
    version: number;
    findings: FindingsSummary | null;
    checking: boolean;
    onundo: () => void;
  } = $props();

  let files = $state.raw<EditState | null>(null);
  let failed = $state<string | null>(null);
  let saved = $state<string | null>(null);
  const canSave = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  $effect(() => {
    void version;
    let live = true;
    saved = null;
    client.request<'editState'>({ kind: 'editState' }).then((s) => {
      if (live) files = s;
    });
    return () => {
      live = false;
    };
  });

  let ready = $derived(!checking && findings !== null);
  /** What validation found, in a line. */
  let found = $derived(findings ? findingsText(findings) : 'not validated yet');

  async function text(name: string): Promise<string> {
    const found = await client.request<'fileText'>({ kind: 'fileText', name });
    if (found === null) throw new Error(`${name} is not loaded`);
    return found;
  }

  async function download(name: string) {
    failed = null;
    try {
      const url = URL.createObjectURL(new Blob([await text(name)], { type: 'application/rdf+xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      failed = String(error);
    }
  }

  async function save() {
    failed = null;
    try {
      // @ts-expect-error Not in every browser, nor in TypeScript's DOM library.
      const dir: FileSystemDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      for (const name of files?.edited ?? []) {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(await text(name));
        await writable.close();
      }
      saved = `Saved ${files?.edited.length} into ${dir.name}.`;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) failed = String(error);
    }
  }
</script>

{#if files && (files.edited.length || files.undo)}
  <section class="edited" aria-label="Edited files" data-testid="edited-files">
    <p>
      <strong>{files.edited.length === 1 ? '1 file edited' : `${files.edited.length} files edited`}</strong>
      <span class="sub">· validated: {checking ? 'validating…' : found}</span>
    </p>
    <div class="bar">
      <button type="button" disabled={!files.undo} onclick={onundo}>Undo</button>
      {#each files.edited as name (name)}
        <button type="button" disabled={!ready} onclick={() => download(name)}>Download {name}</button>
      {/each}
      {#if canSave && files.edited.length}
        <button type="button" disabled={!ready} onclick={save}>Save all to a folder…</button>
      {/if}
    </div>
    {#if saved}<p class="sub" role="status">{saved}</p>{/if}
    {#if failed}<p role="alert">{failed}</p>{/if}
  </section>
{/if}

<style>
  .edited {
    margin-top: 1rem;
    padding: 0.5rem 0.75rem;
    border-left: 4px solid var(--accent);
    background: var(--panel);
  }

  p {
    margin: 0.25rem 0;
    overflow-wrap: anywhere;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  button {
    min-height: 2rem;
    max-width: 100%;
    padding: 0 0.6rem;
    font: inherit;
    overflow-wrap: anywhere;
  }

  .sub {
    color: var(--muted);
  }
</style>
