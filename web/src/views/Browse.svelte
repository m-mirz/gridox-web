<script lang="ts">
  import type { WorkerClient } from '../worker/client';
  import type { Reveal } from '../grid/model';
  import type { EditResult, FlowOverlay, TreeEntry } from '../worker/protocol';
  import Details, { type Info } from './Details.svelte';
  import GridView from './GridView.svelte';
  import TreeView from './TreeView.svelte';
  import Edge from './Edge.svelte';
  import { Width } from './resize.svelte';

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
  /** The tree's width, dragged or keyed at its right edge, kept in this browser; the grid keeps some room. */
  const treeWidth = new Width({ key: 'cimlens.tree-width', initial: 320, min: 200, max: 720, side: 'right', room: 480 });
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

  /** The inspector closed: nothing selected, the grid whole again. */
  export function close() {
    id = null;
    info = null;
    gridView?.unselect();
  }

  function back() {
    const previous = history[history.length - 1];
    history = history.slice(0, -1);
    if (previous) void navigate(previous, false);
  }
</script>

<div class="browse" style:--tree={`${treeWidth.value}px`}>
  <div class="side">
    <TreeView bind:this={tree} {client} {version} {findingsVersion} {validated} onpick={picked} />
    <Edge width={treeWidth} label="Width of the tree" />
  </div>
  <div class="stage">
    <GridView bind:this={gridView} {client} {version} {flow} onselect={selectedOnGrid} />
    {#if id || info}
      <div class="drawer" data-testid="inspector">
        <Details {client} {id} {info} {findingsVersion} onnavigate={(to) => navigate(to)} onback={history.length ? back : null} onclose={close} {onedited} />
      </div>
    {/if}
  </div>
</div>

<style>
  .browse {
    display: grid;
    grid-template-columns: var(--tree) minmax(0, 1fr);
    flex-grow: 1;
    min-height: 0;
  }

  .side {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--line);
    background: var(--surface);
  }

  .side > :global(nav) {
    flex-grow: 1;
  }

  .stage {
    position: relative;
    display: flex;
    min-width: 0;
    min-height: 0;
  }

  .stage > :global(:first-child) {
    flex-grow: 1;
    min-width: 0;
  }

  /* The inspector: a drawer over the grid's right side, the grid whole behind it. */
  .drawer {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    bottom: 0.75rem;
    z-index: 2;
    display: flex;
    width: min(24rem, calc(100% - 1.5rem));
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-l);
    box-shadow: var(--shadow);
  }

  .drawer > :global(*) {
    flex-grow: 1;
  }

  @media (max-width: 48rem) {
    .browse {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(12rem, 40%) minmax(0, 1fr);
    }

    .side {
      border-right: none;
      border-bottom: 1px solid var(--line);
    }

    /* On a phone, a sheet from the bottom. */
    .drawer {
      top: auto;
      right: 0;
      bottom: 0;
      left: 0;
      width: auto;
      height: 70%;
      border-radius: var(--radius-l) var(--radius-l) 0 0;
    }
  }
</style>
