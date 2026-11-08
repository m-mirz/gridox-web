<script lang="ts">
  let { busy, onfiles }: { busy: boolean; onfiles: (files: File[]) => void } = $props();
  let over = $state(false);

  function dropped(event: DragEvent) {
    event.preventDefault();
    over = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) onfiles(files);
  }

  function chosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (files.length) onfiles(files);
    input.value = '';
  }
</script>

<label
  class:over
  data-testid="dropzone"
  ondragover={(event) => {
    event.preventDefault();
    over = true;
  }}
  ondragleave={() => (over = false)}
  ondrop={dropped}
>
  <input type="file" multiple accept=".xml,application/xml,text/xml" disabled={busy} onchange={chosen} />
  <strong>{busy ? 'Reading…' : 'Drop CGMES or NC files here, or choose them'}</strong>
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

  label.over,
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
