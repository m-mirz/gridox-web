<script lang="ts">
  import type { WorkerClient } from '../worker/client';
  import type { Reveal } from '../grid/model';
  import type { EditResult, FlowOverlay, TreeEntry } from '../worker/protocol';
  import Details, { type Info } from './Details.svelte';
  import GridView from './GridView.svelte';
  import TreeView from './TreeView.svelte';

  let {
    client,
    version,
    findingsVersion,
    validated,
    flow = null,
    onedited,
  }: {
    client: WorkerClient;
    version: number;
    findingsVersion: number;
    validated: boolean;
    flow?: FlowOverlay | null;
    onedited: (result: EditResult, show: string | null) => void;
  } = $props();

  let tree = $state<TreeView>();
  let gridView = $state<GridView>();
  let id = $state<string | null>(null);
  let info = $state.raw<Info | null>(null);
  /** The objects shown before, for Back; the model's own. */
  let history = $state<string[]>([]);
  /** The grid is being moved to what the tree or a link chose: what it selects is no new step. */
  let following = false;

  $effect(() => {
    void version;
    history = [];
  });

  function remember(next: string | null) {
    if (id && next !== id) history = [...history, id];
  }

  // The tree leads the grid, and the grid the tree; `id` says when they already agree.
  function show(entry: TreeEntry) {
    id = entry.id ?? null;
    info = null;
    if (entry.grid) {
      following = true;
      void gridView?.reveal(entry.grid).finally(() => (following = false));
    } else gridView?.unselect();
  }

  function picked(entry: TreeEntry) {
    remember(entry.id ?? null);
    show(entry);
  }

  function selectedOnGrid(selection: { id: string | null; info: Info } | null) {
    // Following an object picked elsewhere, the grid shows where it is: a schedule its breaker. The object stays.
    if (following && selection?.id !== id) return;
    info = selection?.info ?? null;
    if (selection?.id === id) return;
    if (!following && selection?.id) remember(selection.id);
    id = selection?.id ?? null;
    if (id) void tree?.reveal(id);
  }

  /** Shows `at` together on the grid; how many it could. */
  export function highlight(at: Reveal[]): number {
    return gridView?.highlight(at) ?? 0;
  }

  /** Shows the object `to` in the tree and the grid, and its details. */
  export async function navigate(to: string, record = true) {
    if (record) remember(to);
    const entry = await tree?.reveal(to);
    id = to;
    info = null;
    if (entry) show(entry);
  }

  function back() {
    const previous = history[history.length - 1];
    history = history.slice(0, -1);
    if (previous) void navigate(previous, false);
  }
</script>

<div class="browse">
  <TreeView bind:this={tree} {client} {version} {findingsVersion} {validated} onpick={picked} />
  <GridView bind:this={gridView} {client} {version} {findingsVersion} {validated} {flow} onselect={selectedOnGrid} />
  <Details {client} {id} {info} {findingsVersion} onnavigate={(to) => navigate(to)} onback={history.length ? back : null} {onedited} />
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
