<script lang="ts">
  let { busy, compact, onfiles }: { busy: boolean; compact: boolean; onfiles: (files: File[]) => void } = $props();
  function chosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (files.length) onfiles(files);
    input.value = '';
  }
</script>

<label
  class:compact
  data-testid="dropzone"
>
  <input type="file" multiple accept=".xml,application/xml,text/xml" disabled={busy} onchange={chosen} />
  <strong>{busy ? 'Reading…' : compact ? 'Add more files' : 'Drop CGMES or NC files or their folder anywhere, or choose them'}</strong>
  <span>They are read on this machine. Nothing is uploaded.</span>
</label>

<style>
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
</style>
