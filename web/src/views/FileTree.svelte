<script lang="ts">
  import type { Summary } from '../worker/protocol';

  /**
   * The files loaded, in their folders, each ticked into the model or not. A folder ticks or
   * unticks all it holds, and says so when only some are in. Unticking reads nothing again: the
   * files stay loaded, and the model is made anew of those ticked.
   */
  let {
    summary,
    paths,
    busy,
    onexclude,
  }: {
    summary: Summary;
    /** Each file's path in the folder or archive it came from, by name. */
    paths: Record<string, string>;
    busy: boolean;
    /** The model to be made of all files but these. */
    onexclude: (excluded: string[]) => void;
  } = $props();

  interface Folder {
    key: string;
    name: string;
    folders: Folder[];
    files: { name: string; objects: number }[];
    /** Every file under it, in subfolders too. */
    all: string[];
  }

  /** The files' folders, the part every path shares left off, so a single folder's files start at its top. */
  let root = $derived.by((): Folder => {
    const loaded = summary.files.flatMap((f) => (f.status === 'loaded' ? [{ name: f.name, objects: f.objects }] : []));
    const split = loaded.map((f) => (paths[f.name] ?? f.name).split('/').slice(0, -1));
    let shared = 0;
    while (split.length && split.every((s) => s.length > shared && s[shared] === split[0][shared])) shared += 1;
    const top: Folder = { key: '', name: '', folders: [], files: [], all: [] };
    loaded.forEach((file, i) => {
      let at = top;
      at.all.push(file.name);
      for (const part of split[i].slice(shared)) {
        let next = at.folders.find((f) => f.name === part);
        if (!next) {
          next = { key: `${at.key}/${part}`, name: part, folders: [], files: [], all: [] };
          at.folders.push(next);
        }
        next.all.push(file.name);
        at = next;
      }
      at.files.push(file);
    });
    return top;
  });

  let excluded = $derived(new Set(summary.excluded));
  let included = $derived(root.all.length - excluded.size);

  /** Folders shown opened: the first level, unless there are many files. */
  let opened = $state<Set<string>>(new Set());
  let seeded = false;
  $effect(() => {
    if (seeded || !root.all.length) return;
    seeded = true;
    if (root.all.length <= 40) opened = new Set(root.folders.map((f) => f.key));
  });
  const toggleOpen = (key: string) => {
    const next = new Set(opened);
    if (!next.delete(key)) next.add(key);
    opened = next;
  };

  const ticked = (names: string[]) => {
    const out = names.filter((n) => excluded.has(n)).length;
    return out === 0 ? 'all' : out === names.length ? 'none' : 'some';
  };

  /** `names` in, or out; the rest as they are. */
  function set(names: string[], include: boolean) {
    const next = new Set(excluded);
    for (const n of names) {
      if (include) next.delete(n);
      else next.add(n);
    }
    onexclude(root.all.filter((n) => next.has(n)));
  }
</script>

<section class="tree" aria-label="Files in the model" data-testid="file-tree">
  <div class="head">
    <span class="sub" data-testid="included">{included.toLocaleString('en')} of {root.all.length.toLocaleString('en')} in the model</span>
    <span class="grow"></span>
    <button type="button" class="ghost small" disabled={busy || excluded.size === 0} onclick={() => set(root.all, true)}>All</button>
    <button type="button" class="ghost small" disabled={busy || excluded.size === root.all.length} onclick={() => set(root.all, false)}>None</button>
  </div>
  {@render folder(root, 0)}
</section>

{#snippet folder(f: Folder, depth: number)}
  <ul>
    {#each f.folders as sub (sub.key)}
      {@const s = ticked(sub.all)}
      <li>
        <div class="row folder" style:padding-left={`${depth * 0.9}rem`}>
          <button type="button" class="ghost caret" aria-expanded={opened.has(sub.key)} aria-label={`${opened.has(sub.key) ? 'Close' : 'Open'} ${sub.name}`} onclick={() => toggleOpen(sub.key)}>{opened.has(sub.key) ? '▾' : '▸'}</button>
          <label>
            <input
              type="checkbox"
              checked={s === 'all'}
              indeterminate={s === 'some'}
              disabled={busy}
              aria-label={`Folder ${sub.name} in the model`}
              onchange={() => set(sub.all, s !== 'all')}
            />
            <span class="name">{sub.name}</span>
          </label>
          <span class="sub count">{sub.all.length - sub.all.filter((n) => excluded.has(n)).length} / {sub.all.length}</span>
        </div>
        {#if opened.has(sub.key)}{@render folder(sub, depth + 1)}{/if}
      </li>
    {/each}
    {#each f.files as file (file.name)}
      <li>
        <label class="row file" class:out={excluded.has(file.name)} style:padding-left={`${depth * 0.9 + 1.4}rem`} title={paths[file.name] ?? file.name}>
          <input
            type="checkbox"
            checked={!excluded.has(file.name)}
            disabled={busy}
            aria-label={`${file.name} in the model`}
            onchange={() => set([file.name], excluded.has(file.name))}
          />
          <span class="name mono">{file.name}</span>
          <span class="sub count">{file.objects.toLocaleString('en')}</span>
        </label>
      </li>
    {/each}
  </ul>
{/snippet}

<style>
  .tree {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .grow {
    flex-grow: 1;
  }

  .small {
    min-height: 1.6rem;
    padding: 0 0.5rem;
    font-size: 0.8rem;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 1.75rem;
    border-radius: var(--radius);
  }

  .row:hover {
    background: var(--surface-2);
  }

  label {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    cursor: pointer;
  }

  .caret {
    width: 1.1rem;
    min-height: 1.5rem;
    padding: 0;
    color: var(--text-3);
    font-size: 0.75rem;
  }

  .folder .name {
    font-weight: 600;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--mono);
    font-size: 0.8rem;
  }

  .count {
    flex-shrink: 0;
    padding-right: 0.25rem;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .out .name {
    color: var(--text-3);
    text-decoration: line-through;
  }
</style>
