<script lang="ts">
  import { open, supported } from '../folder.svelte';

  let { busy, compact, onfiles }: { busy: boolean; compact: boolean; onfiles: (files: File[]) => void } = $props();
  function chosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (files.length) onfiles(files);
    input.value = '';
  }

  /** A folder's XML files and zip archives, in its subfolders too, in path order. */
  function folder(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const path = (f: File) => f.webkitRelativePath || f.name;
    const files = [...(input.files ?? [])].filter((f) => /\.(xml|zip)$/i.test(f.name)).sort((a, b) => (path(a) < path(b) ? -1 : 1));
    input.value = '';
    if (files.length) onfiles(files);
    else empty = 'There are no XML files or zip archives in that folder.';
  }
  let empty = $state<string | null>(null);

  /** A folder whose files edits are saved back into. */
  async function openInPlace() {
    empty = null;
    try {
      const files = await open();
      if (files === null) return;
      if (files.length) onfiles(files);
      else empty = 'There are no XML files or zip archives in that folder.';
    } catch (error) {
      empty = `That folder could not be read: ${error}`;
    }
  }
</script>

<div class="zone" class:compact>
  <label class="files" data-testid="dropzone">
    <input
      type="file"
      multiple
      accept=".xml,application/xml,text/xml,.zip,application/zip"
      aria-label="Choose files"
      disabled={busy}
      onchange={chosen}
    />
    <strong>{busy ? 'Reading…' : compact ? 'Add files' : 'Drop CGMES or NC files, a zip of them or their folder anywhere, or choose them'}</strong>
    {#if !compact}<span>They are read on this machine. Nothing is uploaded.</span>{/if}
  </label>
  <label class="folder">
    <input type="file" webkitdirectory multiple aria-label="Choose a folder" disabled={busy} onchange={folder} onclick={() => (empty = null)} />
    <span>{compact ? 'Add a folder' : 'Or a folder: its XML files and zip archives, in its subfolders too.'}</span>
  </label>
  {#if supported}
    <button type="button" class="in-place" disabled={busy} onclick={openInPlace}>Open a folder to save edits in place</button>
  {/if}
</div>
{#if empty}<p role="status" data-testid="folder-empty">{empty}</p>{/if}

<style>
  .zone {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1.5rem;
    border: 2px dashed var(--line-strong);
    border-radius: var(--radius-l);
    background: var(--surface);
    cursor: pointer;
  }

  label:focus-within,
  label:hover {
    border-color: var(--accent);
  }

  span {
    color: var(--text-2);
  }

  input {
    max-width: 100%;
  }

  label.folder {
    padding: 0.75rem 1.5rem;
    border-style: solid;
    border-width: 1px;
  }

  /* In the sidebar: buttons, the inputs hidden inside them but still there to focus and to label. */
  .compact label,
  .compact label.folder {
    position: relative;
    flex-direction: row;
    align-items: center;
    min-height: 2rem;
    padding: 0 0.75rem;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    font-weight: 500;
  }

  .compact label span,
  .compact label strong {
    color: var(--text);
    font-weight: 500;
  }

  .compact label:hover {
    background: var(--surface-2);
  }

  .compact input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }

  .compact label:focus-within {
    outline: 2px solid var(--info);
    outline-offset: 2px;
  }

  .in-place {
    max-width: 100%;
  }

  .compact .in-place {
    font-size: 0.85rem;
  }
</style>
