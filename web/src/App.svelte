<script lang="ts">
  import { onMount } from 'svelte';
  import { droppedFiles } from './drop';
  import { forget, remembered } from './folder.svelte';
  import { findingsText } from './grid/model';
  import type { Reveal } from './grid/model';
  import Browse from './views/Browse.svelte';
  import DatasetsView from './views/DatasetsView.svelte';
  import DropZone from './views/DropZone.svelte';
  import FindingsView from './views/FindingsView.svelte';
  import NetworkCodesView from './views/NetworkCodesView.svelte';
  import FilesPanel from './views/FilesPanel.svelte';
  import PowerFlowView from './views/PowerFlowView.svelte';
  import SecurityView from './views/SecurityView.svelte';
  import SummaryView from './views/SummaryView.svelte';
  import { WorkerClient } from './worker/client';
  import type { Checks, EditResult, FindingsSummary, PowerFlow, Summary } from './worker/protocol';
  import ModelWorker from './worker/worker?worker';

  const client = new WorkerClient(() => new ModelWorker());

  let summary = $state<Summary | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let elapsed = $state<number | null>(null);

  let kept = $state(false);
  /** Files are being dragged over the page. */
  let dragging = $state(false);
  /** What a drop came to, when that was nothing. */
  let notice = $state<string | null>(null);
  /** A drag that started on this page, such as of selected text, is not for us. */
  let dragFromPage = false;

  /** Whether a drag is one to take: from outside, and not onto a box that takes text. */
  function ours(event: DragEvent): boolean {
    return !dragFromPage && !(event.target instanceof Element && event.target.closest('input[type=search]'));
  }

  function over(event: DragEvent) {
    if (!ours(event)) return;
    event.preventDefault();
    dragging = true;
  }

  function left(event: DragEvent) {
    // Moving between the page's elements leaves each of them; only leaving the window has no next.
    if (!event.relatedTarget) dragging = false;
  }

  async function dropped(event: DragEvent) {
    if (!ours(event)) return;
    // Left alone, the browser would replace the page with the file.
    event.preventDefault();
    dragging = false;
    notice = null;
    if (!event.dataTransfer) return;
    // The browser's own word on what this holds; the drop is gone once anything waits.
    const heldFiles = event.dataTransfer.types.includes('Files');
    let files: File[];
    try {
      files = await droppedFiles(event.dataTransfer);
    } catch (failure) {
      notice = `That folder could not be read: ${failure}`;
      return;
    }
    if (files.length) await run({ kind: 'load', files });
    else if (heldFiles) notice = 'There are no XML files in that folder.';
    // Firefox's snap on Ubuntu 26.04 hands over an empty drop from the Files app, types and all.
    else notice = 'No files came through in that drop: the browser did not pass them on. Choose them with the button above instead.';
  }
  /** Counts the model's changes, for the views to ask again. */
  let version = $state(0);
  let objects = $derived((summary?.objects ?? 0) > 0);

  let findings = $state.raw<FindingsSummary | null>(null);
  let checking = $state(false);
  /** Counts validations, for the views to show the findings. */
  let findingsVersion = $state(0);
  const CHECKS = 'gridox.checks';
  let checks = $state<Checks>(storedChecks());
  let browse = $state<Browse>();
  /** The last power flow, until the model changes. */
  let flow = $state.raw<PowerFlow | null>(null);

  /** The checks chosen last time, in this browser. */
  function storedChecks(): Checks {
    try {
      const { common, quality } = JSON.parse(localStorage.getItem(CHECKS) ?? '{}');
      return { common: common === true, quality: quality === true };
    } catch {
      return { common: false, quality: false };
    }
  }

  function changeChecks(chosen: Checks) {
    checks = chosen;
    try {
      localStorage.setItem(CHECKS, JSON.stringify(chosen));
    } catch {
      // Remembering is a convenience.
    }
    void enqueue(validate);
  }

  type ModelRequest = { kind: 'load'; files: File[] } | { kind: 'restore' } | { kind: 'clear' };

  /** One at a time, in the order asked: a drop while kept files come back waits for them. */
  let queue: Promise<void> = Promise.resolve();
  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task);
    return queue;
  }

  function run(request: ModelRequest): Promise<void> {
    // The files a folder gave are gone with the model: nothing is to be saved into it.
    if (request.kind === 'clear') void forget();
    return enqueue(() => perform(request));
  }

  /** Validates the model as it is now, after whatever was asked before. */
  async function validate() {
    if (!objects) return;
    checking = true;
    try {
      findings = await client.request<'validate'>({ kind: 'validate', ...checks });
      findingsVersion += 1;
    } catch (failure) {
      findings = null;
      error = `Validation failed: ${failure}`;
    } finally {
      checking = false;
    }
  }

  async function perform(request: ModelRequest) {
    busy = true;
    error = null;
    notice = null;
    const started = performance.now();
    try {
      ({ summary, kept } = await client.request<typeof request.kind>(request as never));
      version += 1;
      findings = null;
      elapsed = performance.now() - started;
      // After this one, so that it reads every file loaded.
      if (objects) void enqueue(validate);
    } catch (failure) {
      // The worker, and the model it held, may be gone: nothing shown can still be trusted.
      summary = null;
      kept = false;
      elapsed = null;
      error = String(failure);
    } finally {
      busy = false;
    }
  }

  /** After an edit of the files: the model is new, validated again, and `show` shown in it. */
  function edited(_result: EditResult, show: string | null) {
    void enqueue(async () => {
      ({ summary, kept } = await client.request<'summary'>({ kind: 'summary' }));
      version += 1;
      findings = null;
      // The views ask the new model; the object shown once they have it.
      if (show) setTimeout(() => void browse?.navigate(show), 0);
      await validate();
    });
  }

  async function undo() {
    const result = await client.request<'editUndo'>({ kind: 'editUndo' });
    if (!result.error) edited(result, null);
  }

  /** The views, one shown at a time; the URL's hash names it, so Back and links work. */
  const VIEWS = [
    { id: 'explore', label: 'Explore' },
    { id: 'validation', label: 'Validation' },
    { id: 'codes', label: 'Network codes' },
    { id: 'power-flow', label: 'Power flow' },
    { id: 'contingencies', label: 'Contingencies' },
    { id: 'data', label: 'Data quality' },
  ] as const;
  type View = (typeof VIEWS)[number]['id'];
  const viewOf = (hash: string): View => (VIEWS.find((v) => `#${v.id}` === hash)?.id ?? 'explore') as View;
  let view = $state<View>(viewOf(location.hash));

  function go(to: View) {
    view = to;
    if (location.hash !== `#${to}`) history.pushState(null, '', `#${to}`);
  }

  /** An object, from any view: shown in Explore's tree, grid and inspector. */
  function navigate(id: string) {
    go('explore');
    void browse?.navigate(id);
  }

  /** Objects shown together on the grid, from any view; how many it could. */
  function highlight(at: Reveal[]): number {
    go('explore');
    return browse?.highlight(at) ?? 0;
  }

  /** The Files sidebar, collapsed or not, and the theme: kept in this browser. */
  const SIDEBAR = 'gridox.files-collapsed';
  const THEME = 'gridox.theme';
  const stored = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const store = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A convenience.
    }
  };
  // Open, but collapsed on a narrow screen unless opened there before.
  let collapsed = $state((stored(SIDEBAR) ?? String(matchMedia('(max-width: 48rem)').matches)) === 'true');
  $effect(() => store(SIDEBAR, String(collapsed)));
  type Theme = 'system' | 'light' | 'dark';
  let theme = $state<Theme>((['light', 'dark'].includes(stored(THEME) ?? '') ? stored(THEME) : 'system') as Theme);
  $effect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    store(THEME, theme);
  });
  const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

  let label = $derived.by(() => {
    const loaded = summary?.files.filter((f) => f.status === 'loaded') ?? [];
    return loaded.length === 1 ? loaded[0].name : `${loaded.length.toLocaleString('en')} files`;
  });

  onMount(() => {
    const popped = () => (view = viewOf(location.hash));
    addEventListener('popstate', popped);
    addEventListener('hashchange', popped);
    void remembered();
    void run({ kind: 'restore' });
    return () => {
      removeEventListener('popstate', popped);
      removeEventListener('hashchange', popped);
    };
  });
</script>

<svelte:window
  ondragstart={() => (dragFromPage = true)}
  ondragend={() => (dragFromPage = false)}
  ondragover={over}
  ondragleave={left}
  ondrop={dropped}
/>

{#if dragging}
  <div class="drop" data-testid="drop-overlay">Drop to read them here. Nothing is uploaded.</div>
{/if}

<div class="app">
  <header class="top">
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="5" cy="11" r="3" fill="none" stroke="currentColor" stroke-width="2"></circle><circle cx="17" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="2"></circle><circle cx="17" cy="17" r="3" fill="none" stroke="currentColor" stroke-width="2"></circle><path d="M8 10l6-4M8 12l6 4" stroke="currentColor" stroke-width="2"></path></svg>
      <h1>gridox</h1>
    </div>
    {#if objects}
      <span class="model" title={label}>{label}</span>
    {:else}
      <span class="model sub">Power system models in your browser</span>
    {/if}
    <span class="grow"></span>
    {#if objects}
      <button type="button" class="status" data-testid="status" onclick={() => go('validation')} title={findings ? findingsText(findings) : ''}>
        {#if checking}
          Validating…
        {:else if findings}
          <span class="badge violation" aria-label={`${findings.violation} violations`}>{findings.violation.toLocaleString('en')}</span>
          <span class="badge warning" aria-label={`${findings.warning} warnings`}>{findings.warning.toLocaleString('en')}</span>
          <span class="badge info" aria-label={`${findings.info} info`}>{findings.info.toLocaleString('en')}</span>
        {:else}
          Not validated
        {/if}
      </button>
    {/if}
    <button type="button" class="ghost" aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`} onclick={() => (theme = NEXT[theme])}>
      {#if theme === 'dark'}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.5"></path></svg>
      {:else if theme === 'light'}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" stroke-width="1.5"></path></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M8 2a6 6 0 010 12z" fill="currentColor"></path></svg>
      {/if}
    </button>
  </header>

  {#if error}
    <div class="banner" role="alert" data-testid="error">
      Something went wrong, and the model was lost: {error}
      <!-- A kept file that brings the worker down would do so at every visit. -->
      <button type="button" disabled={busy} onclick={() => run({ kind: 'clear' })}>Clear the kept files</button>
    </div>
  {/if}
  {#if notice}
    <p role="status" class="banner notice" data-testid="notice">{notice}</p>
  {/if}

  {#if summary && summary.files.length}
    <div class="body">
      <FilesPanel
        {client}
        {version}
        {summary}
        {busy}
        {kept}
        {elapsed}
        {findings}
        {checking}
        bind:collapsed
        onfiles={(files) => run({ kind: 'load', files })}
        onclear={() => run({ kind: 'clear' })}
        onundo={undo}
      />
      <main>
        {#if objects}
          <nav class="tabs" aria-label="Views">
            {#each VIEWS as v (v.id)}
              <a href={`#${v.id}`} aria-current={view === v.id ? 'page' : undefined} onclick={(e) => { e.preventDefault(); go(v.id); }}>{v.label}</a>
            {/each}
          </nav>
          <div class="view explore" hidden={view !== 'explore'}>
            <Browse bind:this={browse} {client} {version} {findingsVersion} validated={findings !== null} flow={flow?.overlay ?? null} onedited={edited} />
          </div>
          <div class="view page" hidden={view !== 'validation'}>
            <FindingsView {client} {findings} {checking} {checks} onchecks={changeChecks} onnavigate={navigate} />
          </div>
          <div class="view page" hidden={view !== 'codes'}>
            <NetworkCodesView {client} {version} onnavigate={navigate} onhighlight={highlight} />
          </div>
          <div class="view page" hidden={view !== 'power-flow'}>
            <PowerFlowView {client} {version} onresult={(f) => (flow = f)} onnavigate={navigate} onhighlight={highlight} />
          </div>
          <div class="view page" hidden={view !== 'contingencies'}>
            <SecurityView {client} {version} onnavigate={navigate} onhighlight={highlight} />
          </div>
          <div class="view page" hidden={view !== 'data'}>
            <DatasetsView {client} {findingsVersion} onnavigate={navigate} />
            <SummaryView {summary} part="classes" />
          </div>
        {:else}
          <div class="view page"><p class="sub">No objects in the files loaded.</p></div>
        {/if}
      </main>
    </div>
  {:else}
    <div class="welcome">
      <h2>Open a model</h2>
      <p class="sub">CGMES and Network Code files, a zip of them or their folder: read on this machine, never uploaded.</p>
      <DropZone {busy} compact={false} onfiles={(files) => run({ kind: 'load', files })} />
    </div>
  {/if}
</div>

<style>
  .drop {
    position: fixed;
    inset: 0.5rem;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    border: 3px dashed var(--accent);
    border-radius: var(--radius-l);
    background: var(--surface-2);
    font-weight: 600;
    text-align: center;
    opacity: 0.92;
    /* The drop goes to what is under it, and on up to the window. */
    pointer-events: none;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }

  .top {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.75rem;
    min-height: 3.25rem;
    padding: 0 0.75rem 0 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--accent);
  }

  .brand h1 {
    color: var(--text);
    font-size: 1.05rem;
  }

  .model {
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grow {
    flex-grow: 1;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 1rem;
    color: var(--text-2);
    white-space: nowrap;
  }

  .banner {
    margin: 0;
    padding: 0.5rem 1rem;
    background: var(--warning-soft);
    color: var(--warning);
  }

  .body {
    display: flex;
    flex-grow: 1;
    min-height: 0;
  }

  main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
  }

  .tabs {
    display: flex;
    flex-shrink: 0;
    gap: 1.25rem;
    padding: 0 1.25rem;
    overflow-x: auto;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .tabs a {
    padding: 0.65rem 0.15rem;
    border-bottom: 2px solid transparent;
    color: var(--text-2);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
  }

  .tabs a[aria-current='page'] {
    border-bottom-color: var(--accent);
    color: var(--text);
  }

  .view {
    flex-grow: 1;
    min-height: 0;
  }

  .view[hidden] {
    display: none;
  }

  .view.page {
    padding: 1.25rem;
    overflow-y: auto;
  }

  .view.explore {
    display: flex;
  }

  .view.explore[hidden] {
    display: none;
  }

  .welcome {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: min(40rem, 100% - 2rem);
    margin: 3rem auto;
  }

  .welcome h2 {
    margin: 0;
    font-size: 1.5rem;
  }

  .welcome p {
    margin: 0 0 0.5rem;
  }

  @media (max-width: 48rem) {
    .body {
      position: relative;
    }

    .top .model {
      display: none;
    }
  }
</style>
