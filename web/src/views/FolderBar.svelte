<script lang="ts">
  import { count } from '../grid/model';
  import { folder, forget, plan, reconnect, write, type Planned } from '../folder.svelte';
  import type { WorkerClient } from '../worker/client';

  /**
   * The folder the model was opened from, to save edits into the files they were made to. Saving
   * says first what it will do: which files it overwrites, which it creates, and which it leaves
   * alone, as changed on disk since they were read. It waits for validation, as downloads do.
   */
  let {
    client,
    version,
    names,
    ready,
  }: {
    client: WorkerClient;
    /** Changes when the model does. */
    version: number;
    /** The model's files. */
    names: string[];
    /** Validated, and not validating. */
    ready: boolean;
  } = $props();

  let planned = $state.raw<Planned[] | null>(null);
  let busy = $state(false);
  let said = $state<string | null>(null);
  let failed = $state<string | null>(null);

  $effect(() => {
    void version;
    planned = null;
  });

  const text = (name: string) => client.request<'fileText'>({ kind: 'fileText', name });
  let fromFolder = $derived(names.filter((n) => folder.entries[n]).length);
  let writes = $derived((planned ?? []).filter((p) => p.action === 'overwrite' || p.action === 'create'));

  async function check() {
    busy = true;
    failed = null;
    said = null;
    try {
      const state = await client.request<'editState'>({ kind: 'editState' });
      const created = new Set(state.edited.filter((n) => !folder.entries[n]));
      planned = await plan(names, text, created);
      if (!planned.length) said = 'The folder has the model as it is: nothing to save.';
    } catch (error) {
      failed = String(error);
    } finally {
      busy = false;
    }
  }

  async function save() {
    if (!planned) return;
    busy = true;
    failed = null;
    try {
      const n = await write(planned, text);
      said = `Saved ${count(n, 'file')} into ${folder.root?.name}.`;
      planned = null;
    } catch (error) {
      failed = String(error);
    } finally {
      busy = false;
    }
  }

  const WHY: Record<Planned['action'], string> = {
    overwrite: 'overwritten',
    create: 'created',
    'changed on disk': 'left alone: changed on disk since it was read',
    exists: 'left alone: the folder has a file of that name',
    ambiguous: 'left alone: the folder has more than one file of that name',
  };
</script>

{#if folder.root}
  <section class="folder" aria-label="Folder" data-testid="folder">
    {#if folder.connected}
      <p>
        <strong>{folder.root.name}</strong>
        <span class="sub">· {count(fromFolder, 'file')} of the model from this folder; edits can be saved into them.</span>
      </p>
      <div class="bar">
        <button type="button" disabled={busy || !ready} onclick={check}>Save in place…</button>
        <button type="button" disabled={busy} onclick={() => void forget()}>Forget the folder</button>
        {#if !ready}<span class="sub">After validation.</span>{/if}
      </div>
    {:else}
      <p><strong>{folder.root.name}</strong> <span class="sub">· remembered from the last visit; this browser asks before writing to it again.</span></p>
      <div class="bar">
        <button type="button" disabled={busy} onclick={() => void reconnect()}>Reconnect {folder.root.name}</button>
        <button type="button" disabled={busy} onclick={() => void forget()}>Forget the folder</button>
      </div>
    {/if}

    {#if planned?.length}
      <ul data-testid="folder-plan">
        {#each planned as p (p.name)}
          <li class:skip={!(p.action === 'overwrite' || p.action === 'create')}>{p.name}: {WHY[p.action]}</li>
        {/each}
      </ul>
      <div class="bar">
        <button type="button" disabled={busy || !writes.length} onclick={save}>Write {count(writes.length, 'file')}</button>
        <button type="button" disabled={busy} onclick={() => (planned = null)}>Cancel</button>
      </div>
    {/if}
    {#if said}<p class="sub" role="status">{said}</p>{/if}
    {#if failed}<p role="alert">{failed}</p>{/if}
  </section>
{/if}

<style>
  .folder {
    margin-top: 1rem;
    padding: 0.5rem 0.75rem;
    border-left: 4px solid var(--line);
    background: var(--panel);
  }

  p {
    margin: 0.25rem 0;
    overflow-wrap: anywhere;
  }

  ul {
    margin: 0.4rem 0;
    padding-left: 1.25rem;
    overflow-wrap: anywhere;
  }

  .skip {
    color: var(--warn);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  button {
    min-height: 2rem;
    max-width: 100%;
    padding: 0 0.6rem;
    font: inherit;
  }

  .sub {
    color: var(--muted);
  }
</style>
