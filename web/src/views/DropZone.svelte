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

<label
  class:compact
  data-testid="dropzone"
>
  <input
    type="file"
    multiple
    accept=".xml,application/xml,text/xml,.zip,application/zip"
    aria-label="Choose files"
    disabled={busy}
    onchange={chosen}
  />
  <strong>{busy ? 'Reading…' : compact ? 'Add more files' : 'Drop CGMES or NC files, a zip of them or their folder anywhere, or choose them'}</strong>
  <span>They are read on this machine. Nothing is uploaded.</span>
</label>
<label class="folder" class:compact>
  <input type="file" webkitdirectory multiple aria-label="Choose a folder" disabled={busy} onchange={folder} onclick={() => (empty = null)} />
  <span>Or a folder: its XML files and zip archives, in its subfolders too.</span>
</label>
{#if supported}
  <button type="button" class="in-place" disabled={busy} onclick={openInPlace}>Open a folder to save edits in place</button>
{/if}
{#if empty}<p role="status" data-testid="folder-empty">{empty}</p>{/if}

<style>
  .in-place {
    margin-top: 0.5rem;
    min-height: 2rem;
    max-width: 100%;
    padding: 0 0.75rem;
    font: inherit;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1.5rem;
    border: 2px dashed var(--line);
    border-radius: 0.5rem;
    cursor: pointer;
  }

  label.compact {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
    padding: 0.5rem 0.75rem;
  }

  label:focus-within {
    border-color: var(--accent);
    background: var(--panel);
  }

  span {
    color: var(--muted);
  }

  input {
    margin-bottom: 0.5rem;
    max-width: 100%;
  }

  label.folder {
    margin-top: 0.5rem;
    padding: 0.75rem 1.5rem;
    border-style: solid;
    border-width: 1px;
  }

  label.folder.compact {
    padding: 0.4rem 0.75rem;
  }

  label.folder input {
    margin-bottom: 0;
  }
</style>
