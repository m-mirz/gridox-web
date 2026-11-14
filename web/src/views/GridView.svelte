<script lang="ts">
  import cytoscape, { type Core, type EdgeSingular, type NodeSingular } from 'cytoscape';
  import { onDestroy, untrack } from 'svelte';
  import {
    choice,
    count,
    flowLines,
    flowOf,
    type Grid,
    gridElements,
    gridSummary,
    type Inside,
    insideElements,
    insideSummary,
    type Layout,
    place,
    type Point,
    type Reveal,
    route,
  } from '../grid/model';
  import { stylesheet } from '../grid/style';
  import type { WorkerClient } from '../worker/client';
  import type { FlowOverlay } from '../worker/protocol';
  import type { Info } from './Details.svelte';

  let {
    client,
    version,
    flow = null,
    onselect,
  }: {
    client: WorkerClient;
    /** Changes when the model does. */
    version: number;
    /** A power flow of the model, to colour the grid by. */
    flow?: FlowOverlay | null;
    /** What is selected here, with the object it stands for; `null` when nothing is. */
    onselect: (selection: { id: string | null; info: Info } | null) => void;
  } = $props();

  let container = $state<HTMLElement>();
  let grid = $state.raw<Grid | null>(null);
  let inside = $state.raw<Inside | null>(null);
  let busy = $state(true);
  let failed = $state<string | null>(null);
  let query = $state('');
  let layouts = $state.raw<Layout[]>([]);
  let layout = $state('auto');
  /** What a table row asked to see: shown until cleared. */
  let highlighting = $state(false);
  /** Counts the grids loaded to be drawn anew, as a refresh of the findings is not. */
  let loaded = $state(0);
  /** What the scene is coloured by, once there is a power flow. */
  let colourBy = $state<'voltage' | 'flow'>('voltage');

  let cy: Core | undefined;
  /** The layout picked for the grid and for substations: a layout's id, or `auto`. */
  const chosen: { grid?: string; inside?: string } = {};
  /** The grid's viewport when a substation was opened, to return to. */
  let gridView: { zoom: number; pan: Point; selected: string } | undefined;
  /** What to show once the grid is drawn. */
  let pending: Reveal | undefined;

  type Target = NodeSingular | EdgeSingular;

  // The grid's selection, as details.
  function gridInfo(g: Grid, target: Target): { id: string | null; info: Info } | null {
    if (target.isNode()) {
      const n = g.nodes.find((x) => x.id === target.id());
      if (!n) return null;
      const kV = n.kV.length ? ` · ${n.kV.join(' / ')} kV` : '';
      return {
        id: n.id,
        info: {
          heading: n.label || n.id,
          sub: `${n.kind}${n.region ? ` · ${n.region}` : ''}${kV}`,
          table: Object.entries(n.equipment).sort((a, b) => b[1] - a[1]),
          lines: flow ? flowLines(n.id, flow) : [],
          actions: n.kind === 'Substation' ? [{ label: 'Show inside', run: () => enter(n.id) }] : [],
        },
      };
    }
    const e = g.edges.find((x) => `e:${x.id}` === target.id());
    if (!e) return null;
    const end = (id: string) => g.nodes.find((x) => x.id === id)?.label || id;
    return {
      id: e.id.split('#')[0],
      info: {
        heading: e.label,
        sub: `${e.class}${e.kV !== null ? ` · ${e.kV} kV` : ''}`,
        lines: [`${end(e.source)} — ${end(e.target)}`, ...(flow ? flowLines(e.id.split('#')[0], flow) : [])],
      },
    };
  }

  // A substation's selection, as details.
  function insideInfo(s: Inside, target: Target): { id: string | null; info: Info } | null {
    const id = target.isNode() ? target.id() : undefined;
    const group = s.groups.find((g) => `g:${g.id}` === id);
    if (group) {
      const held = s.items.filter((x) => x.group === group.id);
      return {
        id: group.id,
        info: {
          heading: group.label,
          sub: `VoltageLevel${group.kV !== null ? ` · ${group.kV} kV` : ''}`,
          lines: [`${held.filter((x) => !x.junction).length} equipment, ${count(held.filter((x) => x.junction).length, 'node')}`],
        },
      };
    }
    const it = s.items.find((x) => x.id === id);
    if (!it) return null;
    const state = [it.open === true ? 'open' : it.open === false ? 'closed' : '', it.inService === false ? 'out of service' : '']
      .filter((x) => x)
      .join(', ');
    const level = s.groups.find((g) => g.id === it.group)?.label;
    return {
      id: it.id,
      info: {
        heading: it.label,
        sub: `${it.class}${level ? ` · ${level}` : ''}${state ? ` · ${state}` : ''}`,
        lines: [...(it.far.length ? [`To ${it.far.map((f) => f.label || f.id).join(', ')}`] : []), ...(flow ? flowLines(it.id, flow) : [])],
        actions: it.far
          .filter((f) => f.kind === 'Substation')
          .map((f) => ({ label: `Show ${f.label || f.id}`, run: () => enter(f.id) })),
      },
    };
  }

  function selection(target: Target) {
    if (inside) return insideInfo(inside, target);
    return grid ? gridInfo(grid, target) : null;
  }

  /** Double-clicking: into a substation, or on through a line to its other end. */
  function open(target: Target) {
    if (inside) {
      const far = inside.items.find((x) => x.id === target.id())?.far.filter((f) => f.kind === 'Substation') ?? [];
      if (far.length === 1) void enter(far[0].id);
    } else if (target.isNode() && target.data('kind') === 'substation') {
      void enter(target.id());
    }
  }

  async function enter(id: string) {
    if (!inside && cy) gridView = { zoom: cy.zoom(), pan: { ...cy.pan() }, selected: id };
    const found = await client.request<'inside'>({ kind: 'inside', id });
    if (found) {
      inside = found;
      draw();
    }
  }

  function leave() {
    if (!inside) return;
    inside = null;
    onselect(null);
    draw();
  }

  /** Lays the scene out in the layout chosen. */
  function arrange() {
    if (!cy) return;
    const scene = inside
      ? {
          auto: undefined,
          ids: inside.items.map((it) => it.id),
          pairs: inside.links.map((l): [string, string] => [l.source, l.target]),
          routed: [] as { id: string; key: string }[],
        }
      : {
          auto: grid?.auto ?? undefined,
          ids: (grid as Grid).nodes.map((n) => n.id),
          pairs: (grid as Grid).edges.map((e): [string, string] => [e.source, e.target]),
          routed: (grid as Grid).edges.map((e) => ({ id: `e:${e.id}`, key: e.id })),
        };
    const picked = layout;
    // Automatic: the library's layout for the grid; Cytoscape's inside a substation (it boxes the voltage levels).
    const found = layouts.find((l) => l.id === picked) ?? (picked === 'auto' ? scene.auto : undefined);
    cy.edges().removeStyle();
    if (!found) {
      // `cose` is quadratic per iteration: past a few hundred nodes, a plain grid rather than a hang.
      cy.layout(
        scene.ids.length > 1000
          ? { name: 'grid', animate: false }
          : {
              name: 'cose',
              animate: false,
              nodeRepulsion: () => 8000,
              idealEdgeLength: () => (inside ? 30 : 60),
              numIter: scene.ids.length > 500 ? 400 : 1000,
            },
      ).run();
      return;
    }
    const { nodes, routes } = place(scene.ids, scene.pairs, found);
    cy.layout({ name: 'preset', positions: Object.fromEntries(nodes), fit: true, padding: 30 }).run();
    for (const e of scene.routed) {
      const points = routes.get(e.key);
      if (points) route(cy.getElementById(e.id) as EdgeSingular, points);
    }
  }

  function draw() {
    if (!container || !grid) return;
    const elements = inside ? insideElements(inside) : gridElements(grid);
    cy?.destroy();
    query = '';
    cy = cytoscape({
      container,
      elements,
      style: stylesheet(),
      layout: { name: 'preset' },
      // Large grids: draw a snapshot while panning and zooming.
      textureOnViewport: elements.length > 3000,
      hideEdgesOnViewport: elements.length > 3000,
      minZoom: 0.05,
      maxZoom: 4,
      // Finer steps per wheel notch than the default (1).
      wheelSensitivity: 0.8,
    });
    layouts = inside ? inside.layouts : grid.layouts;
    layout = choice(layouts, inside ? chosen.inside : chosen.grid);
    arrange();
    if (!inside && gridView) {
      // Back from a substation: the grid as it was, with that substation selected.
      cy.zoom(gridView.zoom);
      cy.pan(gridView.pan);
      cy.getElementById(gridView.selected).select();
      gridView = undefined;
    }
    cy.on('select', 'node, edge', (event) => onselect(selection(event.target as Target)));
    cy.on('unselect', () => {
      // Moving the selection unselects first; nothing is selected only if nothing follows.
      queueMicrotask(() => {
        if (cy?.$(':selected').empty()) onselect(null);
      });
    });
    cy.on('dbltap', 'node, edge', (event) => open(event.target as Target));
    highlighting = false;
    paint();
  }

  /**
   * Colours the scene by the power flow, or as drawn: each element keeps its own label as `base`,
   * and a power flow adds a line to it, on an edge its own label.
   */
  function paint() {
    if (!cy) return;
    const on = flow && colourBy === 'flow' ? flow : null;
    cy.batch(() => {
      cy!.elements().forEach((el) => {
        if (el.data('base') === undefined) el.data('base', el.data('label') ?? '');
        const base = el.data('base') as string;
        const found = on ? flowOf(el.id(), el.data('kind') as string | undefined, on) : null;
        if (on && el.data('kind') !== 'group' && !el.id().startsWith('t:')) el.data('pf', found?.band ?? 'none');
        else el.removeData('pf');
        if (el.group() === 'edges') {
          if (found) el.data('flowLabel', found.text);
          else el.removeData('flowLabel');
        } else el.data('label', found ? (base ? `${base}\n${found.text}` : found.text) : base);
      });
    });
  }

  // A power flow comes, goes, or the colouring changes.
  $effect(() => {
    if (flow) untrack(() => (colourBy = 'flow'));
    else untrack(() => (colourBy = 'voltage'));
  });
  $effect(() => {
    void flow;
    void colourBy;
    untrack(paint);
  });

  function changeLayout() {
    if (inside) chosen.inside = layout;
    else chosen.grid = layout;
    arrange();
  }

  function find() {
    if (!cy) return;
    const q = query.trim().toLowerCase();
    clearHighlight();
    cy.elements().removeClass('dim');
    if (!q) return;
    const hits = cy.nodes().filter((n) => String(n.data('label')).toLowerCase().includes(q));
    cy.elements().not(hits).not(hits.ancestors()).addClass('dim');
    if (hits.nonempty()) cy.animate({ fit: { eles: hits, padding: 80 } }, { duration: 200 });
  }

  /** Brings `at` into view: into its substation or out of the one shown, then selects it. */
  export async function reveal(at: Reveal) {
    if (!grid) {
      pending = at;
      return;
    }
    if (at.enter) {
      if (inside?.id !== at.enter) await enter(at.enter);
    } else if (inside) {
      inside = null;
      draw();
    }
    const el = at.select ? cy?.getElementById(at.select) : undefined;
    if (!cy || !el || el.empty()) return;
    if (!el.selected()) {
      cy.$(':selected').unselect();
      el.select();
    }
    // A small scene is seen whole; in a large one, what the selection joins.
    const near = el.isEdge() ? el.union(el.connectedNodes()) : (el as NodeSingular).closedNeighborhood();
    cy.animate({ fit: { eles: cy.elements().length < 40 ? cy.elements() : near, padding: 40 } }, { duration: 200 });
  }

  /**
   * Shows `at` together on the grid, the rest faded: each where the grid has it, equipment inside a
   * substation as that substation. What the grid does not show is left out. How many it showed.
   */
  export function highlight(at: Reveal[]): number {
    if (!grid || !container) return 0;
    if (inside) {
      inside = null;
      draw();
    }
    if (!cy) return 0;
    let shown = cy.collection();
    for (const reveal of at) {
      const id = reveal.enter ?? reveal.select;
      if (id) shown = shown.union(cy.getElementById(id));
    }
    clearHighlight();
    if (shown.empty()) return 0;
    // With what it joins, for where it is: a substation alone fills the view and says little.
    const near = shown.union(shown.connectedNodes()).closedNeighborhood();
    shown.addClass('highlighted');
    cy.elements().not(near).addClass('dim');
    highlighting = true;
    cy.animate({ fit: { eles: near, padding: 60 } }, { duration: 200 });
    return shown.length;
  }

  function clearHighlight() {
    cy?.elements().removeClass('highlighted').removeClass('dim');
    highlighting = false;
  }

  /** The grid's selection goes: what is selected elsewhere is not on it. */
  export function unselect() {
    cy?.$(':selected').unselect();
  }

  $effect(() => {
    version;
    untrack(async () => {
      busy = true;
      failed = null;
      inside = null;
      try {
        grid = await client.request<'grid'>({ kind: 'grid' });
      } catch (error) {
        failed = String(error);
        grid = null;
      }
      busy = false;
      loaded += 1;
    });
  });

  // Once there is both a grid and an element to draw it in, which an empty grid never gets.
  $effect(() => {
    void loaded;
    if (untrack(() => container && grid?.nodes.length)) {
      untrack(() => {
        draw();
        if (pending) {
          const at = pending;
          pending = undefined;
          void reveal(at);
        }
      });
    }
  });

  // Follows the system's light and dark.
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const restyle = () => cy?.style(stylesheet());
  scheme.addEventListener('change', restyle);

  // Shown again after another view, or resized: the drawing follows its box, and is fitted to it
  // when it had none.
  $effect(() => {
    const box = container;
    if (!box) return;
    let empty = box.clientWidth === 0;
    const watch = new ResizeObserver(() => {
      if (!cy) return;
      cy.resize();
      const now = box.clientWidth === 0;
      if (empty && !now) cy.fit(undefined, 24);
      empty = now;
    });
    watch.observe(box);
    return () => watch.disconnect();
  });

  // A theme chosen or the system's changed: the colours drawn are read again.
  $effect(() => {
    const restyle = () => cy?.style(stylesheet());
    const theme = new MutationObserver(restyle);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', restyle);
    return () => {
      theme.disconnect();
      scheme.removeEventListener('change', restyle);
    };
  });

  onDestroy(() => {
    scheme.removeEventListener('change', restyle);
    cy?.destroy();
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') leave();
  }}
/>

<section aria-label="Grid" data-testid="grid">
  <div class="bar">
    {#if inside}
      <button type="button" onclick={leave}>← Grid</button>
    {/if}
    {#if layouts.length}
      <select aria-label="Layout" bind:value={layout} onchange={changeLayout}>
        {#each layouts as l (l.id)}
          <option value={l.id}>{l.name}</option>
        {/each}
        <option value="auto">Automatic</option>
      </select>
    {/if}
    {#if flow}
      <select aria-label="Colour by" bind:value={colourBy}>
        <option value="flow">Power flow</option>
        <option value="voltage">Voltage level</option>
      </select>
    {/if}
    {#if highlighting}
      <button type="button" onclick={clearHighlight}>Clear highlight</button>
    {/if}
    {#if grid?.nodes.length}
      <input type="search" aria-label={inside ? 'Find equipment' : 'Find a substation'} placeholder={inside ? 'Find equipment' : 'Find a substation'} bind:value={query} oninput={find} />
    {/if}
    <span data-testid="grid-summary">
      {#if busy}Laying out the grid…{:else if inside}{insideSummary(inside)}{:else if grid?.nodes.length}{gridSummary(grid)}{/if}
    </span>
  </div>
  {#if failed}
    <p role="alert">The grid could not be drawn: {failed}</p>
  {:else if grid && !grid.nodes.length}
    <p data-testid="no-grid">These files hold no substations to draw. The objects are in the tree.</p>
  {:else}
    <div class="graph" bind:this={container} data-testid="graph"></div>
    {#if flow && colourBy === 'flow'}
      <p class="legend" data-testid="flow-legend">
        <span class="key ok"></span> within 5 % of nominal, loaded below 80 %
        <span class="key warn"></span> within 10 %, up to its limit
        <span class="key bad"></span> beyond
        <span class="key none"></span> not solved, or no limit
      </p>
    {/if}
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--line);
  }

  .bar span {
    color: var(--muted);
  }

  .bar input,
  .bar select,
  .bar button {
    min-height: 2rem;
    font: inherit;
  }

  .bar input {
    width: 12rem;
    max-width: 100%;
    padding: 0 0.5rem;
  }

  .graph {
    position: relative;
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }

  p {
    margin: 1rem;
    color: var(--muted);
  }

  p.legend {
    margin: 0;
    padding: 0.3rem 0.5rem;
    border-top: 1px solid var(--line);
    font-size: 0.8rem;
  }

  .key {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    margin-left: 0.5rem;
    border-radius: 50%;
    vertical-align: middle;
  }

  .key.ok {
    background: var(--accent);
  }

  .key.warn {
    background: var(--warning);
  }

  .key.bad {
    background: var(--violation);
  }

  .key.none {
    background: var(--muted);
  }
</style>
