<script lang="ts">
  import type { WorkerClient } from '../worker/client';
  import type { TreeEntry } from '../worker/protocol';
  import Details, { type Info } from './Details.svelte';
  import GridView from './GridView.svelte';
  import TreeView from './TreeView.svelte';

  let {
    client,
    version,
    findingsVersion,
    validated,
  }: { client: WorkerClient; version: number; findingsVersion: number; validated: boolean } = $props();

  let tree = $state<TreeView>();
  let gridView = $state<GridView>();
  let id = $state<string | null>(null);
  let info = $state.raw<Info | null>(null);

  // The tree leads the grid, and the grid the tree; `id` says when they already agree.
  function picked(entry: TreeEntry) {
    id = entry.id ?? null;
    info = null;
    if (entry.grid) void gridView?.reveal(entry.grid);
    else gridView?.unselect();
  }

  function selectedOnGrid(selection: { id: string | null; info: Info } | null) {
    info = selection?.info ?? null;
    if (selection?.id === id) return;
    id = selection?.id ?? null;
    if (id) void tree?.reveal(id);
  }

  /** Shows the object `to` in the tree and the grid, and its details. */
  export async function navigate(to: string) {
    const entry = await tree?.reveal(to);
    id = to;
    info = null;
    if (entry) picked(entry);
  }
</script>

<div class="browse">
  <TreeView bind:this={tree} {client} {version} {findingsVersion} {validated} onpick={picked} />
  <GridView bind:this={gridView} {client} {version} {findingsVersion} {validated} onselect={selectedOnGrid} />
  <Details {client} {id} {info} {findingsVersion} onnavigate={navigate} />
</div>

<style>
  .browse {
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr) minmax(14rem, 20rem);
    height: max(30rem, calc(100dvh - 2rem));
    margin-top: 1rem;
    border: 1px solid var(--line);
  }

  .browse > :global(* + *) {
    border-left: 1px solid var(--line);
  }

  @media (max-width: 60rem) {
    .browse {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: 20rem 26rem auto;
      height: auto;
    }

    .browse > :global(* + *) {
      border-left: none;
      border-top: 1px solid var(--line);
    }
  }
</style>
