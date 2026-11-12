<script lang="ts">
  import type { Reveal } from '../grid/model';
  import { count } from '../grid/model';
  import type { WorkerClient } from '../worker/client';
  import type { Analysis, AnalysisViolation, SarHeader, SarResult, Sharing } from '../worker/protocol';
  import Links from './Links.svelte';

  /**
   * A security analysis of the model, by gridoxide: the base case and each loaded contingency
   * solved, currents held against their limits, and a SAR of what is found. It runs a batch of
   * contingencies per request, so it can say how far it has come and be stopped. What a SAR has no
   * place for is listed beside it: the contingencies that did not converge, and those naming
   * equipment the model lacks.
   */
  let {
    client,
    version,
    onnavigate,
    onhighlight,
  }: {
    client: WorkerClient;
    version: number;
    onnavigate: (id: string) => void;
    onhighlight: (at: Reveal[]) => number;
  } = $props();

  let contingencies = $state(0);
  let supplied = $state.raw<SarResult[]>([]);
  let sharing = $state<Sharing>('capability');
  let qLimits = $state(false);
  let running = $state(false);
  let stopping = false;
  let progress = $state<{ done: number; total: number } | null>(null);
  let failed = $state<string | null>(null);
  let stopped = $state<string | null>(null);
  let analysis = $state.raw<Analysis | null>(null);
  let elapsed = $state<number | null>(null);
  let tab = $state<'contingencies' | 'elements' | 'supplied'>('contingencies');
  let filter = $state('');
  /** The row opened to its violations: a contingency's id, `base`, or a terminal. */
  let open = $state<string | null>(null);
  let violations = $state.raw<AnalysisViolation[]>([]);
  let header = $state<SarHeader>({ title: '', description: '', publisher: '', isVersionOf: '', rightsHolder: '', generatedAt: '' });
  let sarFailed = $state<string | null>(null);

  $effect(() => {
    void version;
    stopping = true;
    analysis = null;
    progress = null;
    failed = null;
    stopped = null;
    open = null;
    let current = true;
    Promise.all([client.request<'contingencies'>({ kind: 'contingencies' }), client.request<'sarResults'>({ kind: 'sarResults' })]).then(
      ([c, s]) => {
        if (!current) return;
        contingencies = c.length;
        supplied = s;
        if (!c.length && s.length) tab = 'supplied';
      },
    );
    return () => {
      current = false;
    };
  });

  /** About a second per batch: each batch solves the base case again, so fewer is faster, and a second is still quick to stop. */
  const TARGET_MS = 1000;

  async function start() {
    running = true;
    stopping = false;
    failed = null;
    stopped = null;
    analysis = null;
    open = null;
    const started = performance.now();
    try {
      const first = await client.request<'analysisStart'>({ kind: 'analysisStart', sharing, qLimits });
      if (first.error) {
        failed = first.error;
        return;
      }
      progress = { done: 0, total: first.total };
      let batch = 2;
      while (progress.done < progress.total) {
        if (stopping) {
          stopped = `Stopped after ${progress.done.toLocaleString('en')} of ${count(progress.total, 'contingency', 'contingencies')}.`;
          return;
        }
        const before = performance.now();
        const step = await client.request<'analysisStep'>({ kind: 'analysisStep', count: batch });
        if (step.error) {
          failed = step.error;
          return;
        }
        progress = { done: step.done ?? 0, total: step.total };
        const took = Math.max(1, performance.now() - before);
        batch = Math.max(1, Math.min(200, Math.round((batch * TARGET_MS) / took)));
      }
      analysis = await client.request<'analysisResult'>({ kind: 'analysisResult' });
      elapsed = performance.now() - started;
      const defaults = await client.request<'sarDefaults'>({ kind: 'sarDefaults' });
      header = {
        title: defaults?.title ?? '',
        description: defaults?.description ?? '',
        publisher: defaults?.publisher ?? '',
        isVersionOf: defaults?.isVersionOf ?? '',
        rightsHolder: defaults?.rightsHolder ?? '',
        generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      };
      supplied = await client.request<'sarResults'>({ kind: 'sarResults' });
      tab = 'contingencies';
    } catch (error) {
      failed = String(error);
    } finally {
      running = false;
    }
  }

  async function toggle(key: string, contingency: string | null, terminal: string | null) {
    if (open === key) {
      open = null;
      return;
    }
    open = key;
    violations = [];
    violations = await client.request<'analysisViolations'>({ kind: 'analysisViolations', contingency, terminal });
  }

  const SHARING: Record<Sharing, string> = {
    capability: 'the machines, by capability',
    reference: 'the angle reference',
    equal: 'every generator alike',
  };

  const matches = (...links: (string | null | undefined)[]) => {
    const q = filter.trim().toLowerCase();
    return !q || links.some((l) => (l ?? '').toLowerCase().includes(q));
  };
  const LIMIT = 500;
  let shownContingencies = $derived(
    (analysis?.contingencies ?? []).filter((c) => matches(c.label, c.id, ...c.equipment.map((e) => e.label))),
  );
  let shownElements = $derived((analysis?.elements ?? []).filter((e) => matches(e.equipment?.label, e.equipment?.id, e.terminal)));
  let shownSupplied = $derived(supplied.filter((r) => matches(r.contingency?.label, r.equipment?.label, r.terminal?.id)));

  const fixed = (x: number | null | undefined, digits = 1) => (x === null || x === undefined ? '' : x.toFixed(digits));
  const iri = (s: string) => /^[a-z][a-z0-9+.-]*:\S+$/i.test(s.trim());
  let headerReady = $derived(
    !!header.title.trim() && iri(header.publisher) && iri(header.isVersionOf) && !!header.rightsHolder.trim() && !!header.generatedAt.trim(),
  );

  async function download() {
    sarFailed = null;
    try {
      const xml = await client.request<'sar'>({ kind: 'sar', header: { ...header } });
      const url = URL.createObjectURL(new Blob([xml], { type: 'application/rdf+xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${header.title.trim() || 'SAR'}.xml`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      sarFailed = String(error);
    }
  }
</script>

{#if contingencies || supplied.length}
  <section aria-label="Security analysis" data-testid="security">
    <details open>
      <summary><h2>Security analysis</h2></summary>
      {#if contingencies}
        <div class="bar">
          <label>
            Imbalance taken by
            <select bind:value={sharing} disabled={running}>
              {#each Object.entries(SHARING) as [value, text]}<option {value}>{text}</option>{/each}
            </select>
          </label>
          <label><input type="checkbox" bind:checked={qLimits} disabled={running} /> Hold reactive limits</label>
          {#if running}
            <button type="button" onclick={() => (stopping = true)}>Stop</button>
          {:else}
            <button type="button" onclick={start}>Run {count(contingencies, 'contingency', 'contingencies')}</button>
          {/if}
        </div>
        {#if running && progress}
          <p class="sub" role="status" data-testid="sa-progress">
            <progress max={progress.total} value={progress.done}></progress>
            {progress.done.toLocaleString('en')} of {count(progress.total, 'contingency', 'contingencies')}
          </p>
        {/if}
        {#if failed}<p role="alert" data-testid="sa-error">The analysis stopped: {failed}</p>{/if}
        {#if stopped}<p class="sub" role="status">{stopped}</p>{/if}
      {/if}

      {#if analysis}
        <p class="verdict" data-testid="sa-summary">
          {count(analysis.total, 'contingency', 'contingencies')}: {analysis.solved.toLocaleString('en')} solved{analysis.stalled.length
            ? `, ${analysis.stalled.length.toLocaleString('en')} did not converge`
            : ''}{analysis.absent.length ? `, ${analysis.absent.length.toLocaleString('en')} name equipment the model lacks` : ''}.
          {count(analysis.baseViolations, 'violation')} in the base case, {count(analysis.violations, 'violation')} after contingencies.
        </p>
        <p class="sub" data-testid="sa-options">
          Scenario {analysis.scenarioTime}; the imbalance taken by {SHARING[analysis.options.sharing]}, reactive limits {analysis.options.qLimits ? 'held' : 'not held'}.
          {#if elapsed !== null}{(elapsed / 1000).toFixed(1)} s in this browser.{/if}
          {#if analysis.pastLimits.length}Sharing took machines past their limits {count(analysis.pastLimits.length, 'time')}.{/if}
        </p>
        {#if analysis.stalled.length}
          <p class="note" data-testid="sa-stalled">
            Not in the SAR, which has no place for them: {count(analysis.stalled.length, 'contingency', 'contingencies')} that did not converge,
            <Links inline links={analysis.stalled} {onnavigate} />.
          </p>
        {/if}
        {#if analysis.absent.length}
          <p class="note">Naming equipment the model lacks, so not run: <Links inline links={analysis.absent} {onnavigate} />.</p>
        {/if}
      {/if}

      {#if analysis || supplied.length}
        <div class="bar" role="tablist">
          {#if analysis}
            <button type="button" role="tab" aria-selected={tab === 'contingencies'} onclick={() => (tab = 'contingencies')}>By contingency</button>
            <button type="button" role="tab" aria-selected={tab === 'elements'} onclick={() => (tab = 'elements')}>By element <span class="sub">{analysis.elements.length.toLocaleString('en')}</span></button>
          {/if}
          {#if supplied.length}
            <button type="button" role="tab" aria-selected={tab === 'supplied'} onclick={() => (tab = 'supplied')}>Supplied SAR <span class="sub">{supplied.length.toLocaleString('en')}</span></button>
          {/if}
          <input type="search" placeholder="Filter by name or mRID" aria-label="Filter the results" bind:value={filter} />
        </div>
      {/if}

      {#snippet details(key: string)}
        {#if open === key}
          <tr class="inner">
            <td colspan="7">
              {#if !violations.length}<span class="sub">No violation.</span>{/if}
              {#each violations as v (v.terminal + v.limit.id + (v.contingency?.id ?? ''))}
                <div class="violation">
                  {#if key.startsWith('t:')}
                    <span class="sub">{v.contingency ? 'after' : 'base case'}</span> {#if v.contingency}<Links inline links={[v.contingency]} {onnavigate} />{/if}:
                  {:else}
                    <Links inline links={v.equipment ? [v.equipment] : []} {onnavigate} />:
                  {/if}
                  {fixed(v.amps, 0)} A on <Links inline links={[v.limit]} {onnavigate} /> <small>({v.kind}, {fixed(v.limitAmps, 0)} A)</small>, <strong>{fixed(v.percent)} %</strong>
                </div>
              {/each}
            </td>
          </tr>
        {/if}
      {/snippet}

      {#if analysis && tab === 'contingencies'}
        <div class="scroll">
          <table data-testid="sa-contingencies">
            <thead>
              <tr><th>Contingency</th><th>Outcome</th><th>Equipment lost</th><th>Violations</th><th>Worst</th><th></th><th></th></tr>
            </thead>
            <tbody>
              <tr class="base">
                <td>Base case</td><td>solved</td><td></td><td>{analysis.baseViolations.toLocaleString('en')}</td><td></td>
                <td><button type="button" aria-expanded={open === 'base'} onclick={() => toggle('base', null, null)}>Violations</button></td><td></td>
              </tr>
              {@render details('base')}
              {#each shownContingencies.slice(0, LIMIT) as c (c.id)}
                <tr class:stalled={c.outcome === 'stalled'} class:absent={c.outcome === 'absent'}>
                  <td><Links links={[c]} {onnavigate} /></td>
                  <td>{c.outcome === 'stalled' ? 'did not converge' : c.outcome === 'absent' ? 'not in the model' : 'solved'}</td>
                  <td><Links links={c.equipment} {onnavigate} /></td>
                  <td>{c.outcome === 'solved' ? c.violations.toLocaleString('en') : ''}</td>
                  <td>{c.worst === null ? '' : `${fixed(c.worst)} %`}</td>
                  <td><button type="button" disabled={!c.violations} aria-expanded={open === c.id} onclick={() => toggle(c.id, c.id, null)}>Violations</button></td>
                  <td><button type="button" disabled={!c.grid.length} onclick={() => onhighlight(c.grid)}>Show on grid</button></td>
                </tr>
                {@render details(c.id)}
              {/each}
            </tbody>
          </table>
        </div>
        <p class="sub">{count(Math.min(shownContingencies.length, LIMIT), 'contingency', 'contingencies')} shown, the ones not converging first, then the worst.</p>
      {:else if analysis && tab === 'elements'}
        <div class="scroll">
          <table data-testid="sa-elements">
            <thead>
              <tr><th>Equipment</th><th>Base case</th><th>Contingencies past a limit</th><th>Worst</th><th>Worst after</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {#each shownElements.slice(0, LIMIT) as e (e.terminal)}
                <tr>
                  <td><Links links={e.equipment ? [e.equipment] : []} {onnavigate} /> <small>terminal {e.terminal}</small></td>
                  <td>{e.base === null ? '' : `${fixed(e.base)} %`}</td>
                  <td>{e.contingencies.toLocaleString('en')}</td>
                  <td>{e.worst === null ? '' : `${fixed(e.worst)} %`}</td>
                  <td><Links links={e.worstContingency ? [e.worstContingency] : []} {onnavigate} /></td>
                  <td><button type="button" aria-expanded={open === `t:${e.terminal}`} onclick={() => toggle(`t:${e.terminal}`, null, e.terminal)}>Violations</button></td>
                  <td><button type="button" disabled={!e.grid.length} onclick={() => onhighlight(e.grid)}>Show on grid</button></td>
                </tr>
                {@render details(`t:${e.terminal}`)}
              {/each}
            </tbody>
          </table>
        </div>
        <p class="sub">{count(Math.min(shownElements.length, LIMIT), 'element')} past a limit in the base case or after a contingency, the worst first.</p>
      {:else if tab === 'supplied' && supplied.length}
        <div class="scroll">
          <table data-testid="sa-supplied">
            <thead>
              <tr><th>Result</th><th>Contingency</th><th>Equipment, terminal</th><th>Limit</th><th>Violation</th><th>value, valueA</th><th>This analysis</th></tr>
            </thead>
            <tbody>
              {#each shownSupplied.slice(0, LIMIT) as r (r.id)}
                <tr>
                  <td><Links links={[{ id: r.id, label: r.atTime ?? r.id, class: r.contingency ? 'ContingencyPowerFlowResult' : 'BaseCasePowerFlowResult' }]} {onnavigate} /></td>
                  <td>{#if r.contingency}<Links links={[r.contingency]} {onnavigate} />{:else}base case{/if}</td>
                  <td><Links links={r.equipment ? [r.equipment] : []} {onnavigate} /><Links links={r.terminal ? [r.terminal] : []} {onnavigate} /></td>
                  <td><Links links={r.limit ? [r.limit] : []} {onnavigate} /></td>
                  <td>{r.isViolation ?? ''}</td>
                  <td>{r.value ?? ''}{r.valueA ? `, ${r.valueA} A` : ''}</td>
                  <td>{r.ours !== null ? `${fixed(r.ours)} %` : r.analysed ? 'no violation' : 'not run'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="sub">The SAR's values as written. A dashed link is to what the loaded model lacks.</p>
      {/if}

      {#if analysis}
        <details class="sar" data-testid="sa-download">
          <summary>Download the SAR</summary>
          <div class="form">
            <label>Title <input bind:value={header.title} /></label>
            <label>Description <input bind:value={header.description} /></label>
            <label>Publisher, a party's IRI <input bind:value={header.publisher} placeholder="https://energy.referencedata.eu/…" /></label>
            <label>Version of, a model collection's IRI <input bind:value={header.isVersionOf} placeholder="https://energy.referencedata.eu/…" /></label>
            <label>Rights holder <input bind:value={header.rightsHolder} /></label>
            <label>Generated at <input bind:value={header.generatedAt} /></label>
          </div>
          <button type="button" disabled={!headerReady} onclick={download}>Download SAR</button>
          {#if !headerReady}<span class="sub">The publisher and the model collection are IRIs; every field is needed.</span>{/if}
          {#if sarFailed}<p role="alert">The SAR could not be written: {sarFailed}</p>{/if}
          <p class="sub">It requires the CO datasets: {analysis.requires.join(', ')}.</p>
        </details>
      {/if}
    </details>
  </section>
{/if}

<style>
  section {
    margin-top: 1rem;
  }

  summary {
    cursor: pointer;
  }

  summary h2 {
    display: inline;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin: 0.5rem 0;
  }

  .bar button,
  .bar select,
  .bar input[type='search'],
  td button,
  .sar button {
    min-height: 2rem;
    padding: 0 0.6rem;
    font: inherit;
  }

  [role='tab'][aria-selected='true'] {
    border-color: var(--accent);
    font-weight: 600;
  }

  progress {
    vertical-align: middle;
  }

  .verdict {
    font-weight: 600;
  }

  .note {
    padding: 0.4rem 0.6rem;
    border-left: 4px solid var(--warn);
    background: var(--panel);
  }

  .scroll {
    max-height: 28rem;
    overflow: auto;
    border: 1px solid var(--line);
  }

  table {
    min-width: 44rem;
    font-size: 0.9rem;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--bg);
    white-space: nowrap;
    vertical-align: bottom;
  }

  td {
    vertical-align: top;
  }

  tr.stalled td:nth-child(2) {
    color: var(--violation);
    font-weight: 600;
  }

  tr.absent td,
  tr.base td {
    color: var(--muted);
  }

  tr.inner td {
    background: var(--panel);
  }

  .violation + .violation {
    margin-top: 0.2rem;
  }

  .sar {
    margin-top: 0.75rem;
  }

  .form {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
    gap: 0.5rem 1rem;
    margin: 0.5rem 0;
  }

  .form label {
    display: flex;
    flex-direction: column;
    font-size: 0.9rem;
  }

  .form input {
    min-height: 2rem;
    padding: 0 0.4rem;
    font: inherit;
  }

  small,
  .sub {
    color: var(--muted);
  }
</style>
