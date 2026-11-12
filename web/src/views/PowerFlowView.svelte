<script lang="ts">
  import type { Reveal } from '../grid/model';
  import { count } from '../grid/model';
  import type { WorkerClient } from '../worker/client';
  import type { ComponentStatus, Linked, PowerFlow, Sharing } from '../worker/protocol';
  import Links from './Links.svelte';

  /**
   * A power flow of the model, by gridoxide, on request. What decides the answer is chosen here and
   * shown with it: who takes the imbalance, and whether reactive limits hold. Converging is not the
   * verdict: components left unsolved, with no angle reference or several, are counted beside it.
   */
  let {
    client,
    version,
    onresult,
    onnavigate,
    onhighlight,
  }: {
    client: WorkerClient;
    /** Changes when the model does, which takes the result away. */
    version: number;
    onresult: (flow: PowerFlow | null) => void;
    onnavigate: (id: string) => void;
    onhighlight: (at: Reveal[]) => number;
  } = $props();

  let sharing = $state<Sharing>('reference');
  let qLimits = $state(true);
  /** The buses from the switches as the SSH sets them, rather than from the TP. */
  let switches = $state(false);
  /** A remedial action to apply, by mRID: the switch states it sets, solved from the switches. */
  let action = $state('');
  let actions = $state.raw<Linked[]>([]);
  let solving = $state(false);
  let flow = $state.raw<PowerFlow | null>(null);
  let failed = $state<string | null>(null);
  let filter = $state('');
  let elapsed = $state<number | null>(null);

  $effect(() => {
    void version;
    flow = null;
    failed = null;
    action = '';
    onresult(null);
    let live = true;
    // The actions that set a switch: those a solve from the switches can apply.
    client.request<'remedialActions'>({ kind: 'remedialActions' }).then((found) => {
      if (live) actions = found.filter((a) => a.applied.length).map((a) => ({ id: a.id, label: a.label, class: a.class }));
    });
    return () => {
      live = false;
    };
  });

  async function solve() {
    solving = true;
    failed = null;
    const started = performance.now();
    try {
      flow = await client.request<'powerFlow'>({ kind: 'powerFlow', sharing, qLimits, switches: switches || !!action, action: action || null });
      elapsed = performance.now() - started;
      onresult(flow.error ? null : flow);
    } catch (error) {
      failed = String(error);
      flow = null;
      onresult(null);
    } finally {
      solving = false;
    }
  }

  const SHARING: Record<Sharing, string> = {
    reference: 'the angle reference',
    capability: 'the machines, by capability',
    equal: 'every generator alike',
  };

  const STATUS: Record<ComponentStatus, string> = {
    converged: 'converged',
    maxIterations: 'did not converge',
    singular: 'singular Jacobian',
    noReference: 'not solved: no angle reference',
    ambiguousReference: 'not solved: more than one reference',
  };

  type Row = PowerFlow['components'][number] & { many?: number };

  /** The components, largest first; single nodes with no reference, often many, in one row. */
  let rows = $derived.by((): Row[] => {
    if (!flow) return [];
    const lone = flow.components.filter((c) => c.status === 'noReference' && c.nodes <= 1);
    const rest = flow.components.filter((c) => !lone.includes(c)).sort((a, b) => b.nodes - a.nodes);
    return lone.length ? [...rest, { ...lone[0], nodes: lone.length, references: [], many: lone.length }] : rest;
  });

  /** What was solved and what was not, in one line: never a tick for converging alone. */
  let verdict = $derived.by(() => {
    if (!flow) return '';
    const by = (s: ComponentStatus[]) => flow!.components.filter((c) => s.includes(c.status));
    const nodes = (cs: PowerFlow['components']) => cs.reduce((n, c) => n + c.nodes, 0);
    const parts: string[] = [];
    const solved = by(['converged']);
    parts.push(`${count(nodes(solved), 'node')} solved, in ${count(solved.length, 'component')}`);
    const stalled = by(['maxIterations', 'singular']);
    if (stalled.length) parts.push(`${count(nodes(stalled), 'node')} in ${count(stalled.length, 'component')} that did not converge`);
    const none = by(['noReference']);
    if (none.length) parts.push(`${count(nodes(none), 'node')} with no angle reference, not solved`);
    const several = by(['ambiguousReference']);
    if (several.length) parts.push(`${count(nodes(several), 'node')} with more than one reference, not solved`);
    return parts.join('; ') + '.';
  });

  let stalled = $derived(!!flow?.components.some((c) => c.status === 'maxIterations' || c.status === 'singular'));

  const matches = (n: PowerFlow['nodes'][number]) => {
    const q = filter.trim().toLowerCase();
    return !q || (n.label ?? '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q);
  };
  /** The nodes furthest from their SV first, then by name; a large model shows its first 500. */
  let shown = $derived.by(() => {
    if (!flow) return [];
    const found = flow.nodes.filter(matches);
    const off = (n: PowerFlow['nodes'][number]) => (n.dvPercent === undefined ? -1 : Math.abs(n.dvPercent));
    return [...found].sort((a, b) => off(b) - off(a));
  });
  const LIMIT = 500;

  const fixed = (x: number | null | undefined, digits: number) => (x === null || x === undefined ? '' : x.toFixed(digits));
</script>

<section aria-label="Power flow" data-testid="power-flow">
  <details open>
    <summary><h2>Power flow</h2></summary>
    <div class="bar">
      <label>
        Imbalance taken by
        <select bind:value={sharing} disabled={solving}>
          {#each Object.entries(SHARING) as [value, text]}<option {value}>{text}</option>{/each}
        </select>
      </label>
      <label><input type="checkbox" bind:checked={qLimits} disabled={solving} /> Hold reactive limits</label>
      <label>
        Buses from
        <select bind:value={switches} disabled={solving || !!action}>
          <option value={false}>the TP files</option>
          <option value={true}>the switches</option>
        </select>
      </label>
      {#if actions.length}
        <label>
          Remedial action applied
          <select bind:value={action} disabled={solving}>
            <option value="">none</option>
            {#each actions as a (a.id)}<option value={a.id}>{a.label ?? a.id}</option>{/each}
          </select>
        </label>
      {/if}
      <button type="button" onclick={solve} disabled={solving}>{solving ? 'Solving…' : flow ? 'Solve again' : 'Solve'}</button>
      {#if flow && elapsed !== null && !solving}<span class="sub">{Math.round(elapsed).toLocaleString('en')} ms, by gridoxide, in this browser</span>{/if}
    </div>

    {#if failed}
      <p role="alert">The solve failed: {failed}</p>
    {:else if flow?.error}
      <p role="alert" data-testid="pf-error">Nothing was solved: {flow.error}</p>
    {:else if flow}
      <p class="verdict" class:stalled data-testid="pf-verdict">{verdict}</p>
      {#if flow.action && flow.actionSwitches && flow.compared}
        {@const c = flow.compared}
        <div class="applied" data-testid="pf-applied">
          <p>
            With <Links inline links={[flow.action]} {onnavigate} /> applied:
            {#each flow.actionSwitches as s, i (s.id)}<Links inline links={[s]} {onnavigate} />
              {s.open === null ? '' : s.open === 'true' ? 'open' : 'closed'} → {s.openAfter ? 'open' : 'closed'}{i < flow.actionSwitches.length - 1 ? ', ' : '.'}{/each}
          </p>
          <p>
            {#if c.changed}
              The voltages of {count(c.changed, 'node')} change, by up to {fixed(c.largestChange, 4)} p.u.
            {:else}
              No voltage changes: the switches were as it sets them, or the network does not part.
            {/if}
            {c.solvedBefore === c.solvedAfter ? `${count(c.solvedAfter, 'node')} solved, as without it.` : `${count(c.solvedAfter, 'node')} solved, ${c.solvedBefore.toLocaleString('en')} without it.`}
            Currents past their limits: {c.violationsAfter.toLocaleString('en')}, {c.violationsBefore.toLocaleString('en')} without it.
          </p>
          {#if c.most.length}
            <p class="sub">Most changed: {#each c.most as m, i (m.id)}<Links inline links={[m]} {onnavigate} /> {fixed(m.change, 4)}{i < c.most.length - 1 ? ', ' : '.'}{/each}</p>
          {/if}
        </div>
      {/if}
      <p class="sub" data-testid="pf-options">
        With the imbalance taken by {SHARING[flow.options.sharing]}{flow.sharedMW !== null ? ` (${fixed(flow.sharedMW, 1)} MW in all)` : ''},
        reactive limits {flow.options.qLimits ? 'held' : 'not held'}, the buses from {flow.options.switches ? 'the switches' : 'the TP files'}.
        {#if flow.options.qLimits}
          {flow.switched.length ? `They took ${count(flow.switched.length, 'node')} off voltage control:` : 'They took no machine off voltage control.'}
          <Links inline links={flow.switched} {onnavigate} />
        {/if}
        {#if flow.pastLimits.length}
          Sharing took {count(flow.pastLimits.length, 'machine')} past its limits:
          {#each flow.pastLimits as m, i}<Links inline links={[m]} {onnavigate} /> {fixed(m.mw, 1)} MW of {fixed(m.limit, 1)}{i < flow.pastLimits.length - 1 ? ', ' : '.'}{/each}
        {/if}
      </p>

      <div class="scroll short">
        <table data-testid="pf-components">
          <thead>
            <tr><th>Component</th><th>Nodes</th><th>Reference</th><th>Largest mismatch, p.u.</th><th>From the SV</th></tr>
          </thead>
          <tbody>
            {#each rows as c, i (i)}
              <tr class:bad={c.status === 'maxIterations' || c.status === 'singular'} class:unsolved={c.status === 'noReference' || c.status === 'ambiguousReference'}>
                <td>{c.many ? `${c.many} single nodes` : ''} {STATUS[c.status]}</td>
                <td>{c.nodes.toLocaleString('en')}</td>
                <td><Links links={c.references} {onnavigate} /></td>
                <td>{c.maxMismatch === null ? '' : c.maxMismatch.toExponential(1)}</td>
                <td>{c.sv ? `${fixed(c.sv.dvPercent, 2)} %, ${fixed(c.sv.dDeg, 2)}° at most, over ${count(c.sv.nodes, 'node')}` : ''}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if flow.violations.length}
        <h3>Currents past their limits</h3>
        <div class="scroll short">
          <table data-testid="pf-violations">
            <thead><tr><th>Equipment</th><th>Limit</th><th>Current, A</th><th>Of the limit</th></tr></thead>
            <tbody>
              {#each flow.violations as v (v.terminal + v.limit.id)}
                <tr>
                  <td><Links links={v.equipment ? [v.equipment] : []} {onnavigate} /></td>
                  <td><Links inline links={[v.limit]} {onnavigate} /> <small>{v.kind}, {fixed(v.limitAmps, 0)} A</small></td>
                  <td>{fixed(v.amps, 0)}</td>
                  <td>{fixed(v.percent, 1)} %</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if !stalled}
        <p class="sub">No current past a limit{flow.components.some((c) => c.status === 'converged') ? '' : ': nothing was solved'}.</p>
      {/if}

      <h3>Voltages</h3>
      <div class="bar">
        <input type="search" placeholder="Filter by name or mRID" aria-label="Filter the voltages" bind:value={filter} />
        <span class="sub">Furthest from the SV first. Angles are aligned with the SV's at each component's reference.</span>
      </div>
      <div class="scroll">
        <table data-testid="pf-nodes">
          <thead>
            <tr><th>Node</th><th>kV</th><th>p.u.</th><th>Angle</th><th>SV kV</th><th>SV angle</th><th>ΔV</th><th>Δθ</th><th></th></tr>
          </thead>
          <tbody>
            {#each shown.slice(0, LIMIT) as n (n.id)}
              <tr class:unsolved={n.pu === null}>
                <td><Links links={[{ id: n.id, label: n.label, class: 'TopologicalNode' }]} {onnavigate} /> <small>{fixed(n.nominalKV, 0)} kV</small></td>
                <td>{fixed(n.kV, 2)}</td>
                <td>{n.pu === null ? 'not solved' : fixed(n.pu, 4)}</td>
                <td>{n.deg === null ? '' : `${fixed(n.deg, 2)}°`}</td>
                <td>{fixed(n.sv?.kV, 2)}</td>
                <td>{n.sv ? `${fixed(n.sv.deg, 2)}°` : ''}</td>
                <td>{n.dvPercent === undefined ? '' : `${fixed(n.dvPercent, 2)} %`}</td>
                <td>{n.dDeg === undefined ? '' : `${fixed(n.dDeg, 2)}°`}</td>
                <td><button type="button" disabled={!n.at} onclick={() => onhighlight([{ select: n.at }])}>Show on grid</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="sub">{count(Math.min(shown.length, LIMIT), 'node')} shown{shown.length > LIMIT ? ` of ${shown.length.toLocaleString('en')}: filter to find the rest` : ''}.</p>
    {:else}
      <p class="sub">Solves the loaded model as it stands: its EQ, SSH and TP, with the SV to compare with. Nothing leaves this browser.</p>
    {/if}
  </details>
</section>

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

  h3 {
    margin: 1rem 0 0.25rem;
    font-size: 1rem;
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
  td button {
    min-height: 2rem;
    padding: 0 0.6rem;
    font: inherit;
  }

  .verdict {
    font-weight: 600;
  }

  .verdict.stalled {
    color: var(--violation);
  }

  .applied {
    margin: 0.5rem 0;
    padding: 0.4rem 0.6rem;
    border-left: 4px solid var(--accent);
    background: var(--panel);
  }

  .applied p {
    margin: 0.2rem 0;
  }

  .scroll {
    max-height: 26rem;
    overflow: auto;
    border: 1px solid var(--line);
  }

  .scroll.short {
    max-height: 14rem;
  }

  table {
    min-width: 40rem;
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

  tr.bad td:first-child {
    color: var(--violation);
    font-weight: 600;
  }

  tr.unsolved td {
    color: var(--muted);
  }

  small,
  .sub {
    color: var(--muted);
  }
</style>
