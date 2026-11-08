<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { symbolOf, symbolSvg } from '../grid/symbols';
  import type { WorkerClient } from '../worker/client';
  import type { SearchHit, TreeEntry } from '../worker/protocol';

  let {
    client,
    version,
    onpick,
  }: {
    client: WorkerClient;
    /** Changes when the model does. */
    version: number;
    onpick: (entry: TreeEntry) => void;
  } = $props();

  const ROOT = '';
  /** Each level asked for, by its parent's key. */
  const levels = new SvelteMap<string, TreeEntry[]>();
  const open = new SvelteSet<string>();
  let selected = $state<string | null>(null);
  let query = $state('');
  let hits = $state.raw<SearchHit[] | null>(null);
  let list = $state<HTMLElement>();

  type Row = { entry: TreeEntry; depth: number };

  function flatten(key: string, depth: number, rows: Row[]): Row[] {
    for (const entry of levels.get(key) ?? []) {
      rows.push({ entry, depth });
      if (open.has(entry.key)) flatten(entry.key, depth + 1, rows);
    }
    return rows;
  }

  let rows = $derived(flatten(ROOT, 0, []));

  async function fetchLevel(key: string): Promise<TreeEntry[]> {
    const known = levels.get(key);
    if (known) return known;
    const entries = (await client.request<'children'>({ kind: 'children', key: key === ROOT ? null : key })) ?? [];
    levels.set(key, entries);
    return entries;
  }

  $effect(() => {
    version;
    untrack(() => {
      levels.clear();
      open.clear();
      selected = null;
      void fetchLevel(ROOT);
    });
  });

  async function toggle(entry: TreeEntry) {
    if (open.has(entry.key)) {
      open.delete(entry.key);
    } else {
      await fetchLevel(entry.key);
      open.add(entry.key);
    }
  }

  function pick(entry: TreeEntry) {
    selected = entry.key;
    if (entry.id) onpick(entry);
    else void toggle(entry);
  }

  /** Opens the way down to the object `id` and marks it; what it finds, if the tree has it. */
  export async function reveal(id: string): Promise<TreeEntry | undefined> {
    const keys = await client.request<'path'>({ kind: 'path', id });
    if (!keys?.length) return undefined;
    let level = await fetchLevel(ROOT);
    let found: TreeEntry | undefined;
    for (const [i, key] of keys.entries()) {
      found = level.find((entry) => entry.key === key);
      if (!found) return undefined;
      if (i < keys.length - 1) {
        level = await fetchLevel(key);
        open.add(key);
      }
    }
    selected = found?.key ?? null;
    query = '';
    hits = null;
    await tick();
    list?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    return found;
  }

  /** The search answering, so that a slower earlier one does not overwrite it. */
  let asked = 0;
  async function search() {
    const mine = ++asked;
    const text = query.trim();
    if (!text) {
      hits = null;
      return;
    }
    const found = await client.request<'search'>({ kind: 'search', query: text });
    if (mine === asked) hits = found;
  }

  async function choose(hit: SearchHit) {
    const entry = await reveal(hit.id);
    if (entry) onpick(entry);
  }

  /** The equipment symbol, for what has one. A constant of ours, not the model's text. */
  const icon = (entry: TreeEntry) => {
    const symbol = entry.class ? symbolOf(entry.class) : undefined;
    return symbol ? symbolSvg(symbol, 'currentColor') : null;
  };
</script>

<nav aria-label="Objects" data-testid="tree">
  <input type="search" placeholder="Find an object by name or mRID" aria-label="Find an object" bind:value={query} oninput={search} />
  <div class="list" bind:this={list}>
    {#if hits}
      {#if !hits.length}
        <p>Nothing found.</p>
      {/if}
      <ul data-testid="hits">
        {#each hits as hit (hit.id)}
          <li>
            <button type="button" class="hit" onclick={() => choose(hit)}>
              <span>{hit.label}</span>
              <small>{hit.class}{hit.place ? ` · ${hit.place}` : ''}</small>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      {#each rows as { entry, depth } (entry.key)}
        <div class="row" style:--depth={depth} class:missing={entry.kind === 'missing'}>
          {#if entry.children}
            <button type="button" class="twisty" aria-expanded={open.has(entry.key)} aria-label={`${open.has(entry.key) ? 'Collapse' : 'Expand'} ${entry.label}`} onclick={() => toggle(entry)}>
              {open.has(entry.key) ? '▾' : '▸'}
            </button>
          {:else}
            <span class="twisty"></span>
          {/if}
          <button type="button" class="label" aria-current={selected === entry.key} onclick={() => pick(entry)}>
            {#if icon(entry)}<span class="icon">{@html icon(entry)}</span>{/if}
            <span class="name">{entry.label}</span>
            <small>{entry.id ? (entry.kind === 'missing' ? 'not in the set' : entry.class) : entry.children}</small>
          </button>
        </div>
      {/each}
    {/if}
  </div>
</nav>

<style>
  nav {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  input {
    margin: 0.5rem;
    padding: 0.25rem 0.5rem;
    font: inherit;
  }

  .list {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  p {
    margin: 0.5rem;
    color: var(--muted);
  }

  .row {
    display: flex;
    align-items: center;
    padding-left: calc(var(--depth) * 0.8rem);
  }

  button {
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .twisty {
    flex: none;
    width: 1.5rem;
    height: 1.75rem;
    padding: 0;
    text-align: center;
  }

  .label {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    min-height: 1.75rem;
    padding: 0 0.5rem 0 0;
    text-align: left;
  }

  .label[aria-current='true'] {
    background: var(--panel);
    font-weight: 600;
  }

  .label:hover,
  .hit:hover {
    background: var(--panel);
  }

  .icon {
    display: inline-flex;
    flex: none;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    flex: none;
    color: var(--muted);
  }

  .missing .name {
    font-style: italic;
  }

  .hit {
    display: block;
    width: 100%;
    padding: 0.25rem 0.5rem;
    text-align: left;
  }

  .hit span,
  .hit small {
    display: block;
    overflow-wrap: anywhere;
  }
</style>
