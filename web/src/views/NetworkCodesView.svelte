<script lang="ts">
  import type { Reveal } from '../grid/model';
  import { count } from '../grid/model';
  import type { WorkerClient } from '../worker/client';
  import type { AssessedElement, Contingency, ExclusiveActions, Linked, RemedialAction, ScheduleGroup, Schedules, SwitchState } from '../worker/protocol';
  import Links from './Links.svelte';
  import Timeline from './Timeline.svelte';

  let {
    client,
    version,
    onnavigate,
    onhighlight,
  }: {
    client: WorkerClient;
    /** Changes when the model does. */
    version: number;
    onnavigate: (id: string) => void;
    /** Shows what a row is about on the grid; how many of it the grid shows. */
    onhighlight: (at: Reveal[]) => number;
  } = $props();

  let contingencies = $state.raw<Contingency[]>([]);
  let assessed = $state.raw<AssessedElement[]>([]);
  let actions = $state.raw<RemedialAction[]>([]);
  let schedules = $state.raw<Schedules>({ groups: [], exclusive: [] });
  let tab = $state<'contingencies' | 'assessed' | 'actions' | 'schedules'>('contingencies');
  /** The schedule groups on the timeline, and the times marked across it. */
  let picked = $state<string[]>([]);
  let marks = $state.raw<{ at: string; label: string }[]>([]);
  let filter = $state('');
  /** What the last "Show on grid" came to, when the grid showed none of it. */
  let notOnGrid = $state<string | null>(null);

  $effect(() => {
    void version;
    let current = true;
    Promise.all([
      client.request<'contingencies'>({ kind: 'contingencies' }),
      client.request<'assessedElements'>({ kind: 'assessedElements' }),
      client.request<'remedialActions'>({ kind: 'remedialActions' }),
      client.request<'schedules'>({ kind: 'schedules' }),
    ]).then(([c, a, r, s]) => {
      if (!current) return;
      contingencies = c;
      assessed = a;
      actions = r;
      schedules = s;
      // The tab chosen stays while it has rows: a new file must not take it away.
      const rows = { contingencies: c.length, assessed: a.length, actions: r.length, schedules: s.groups.length };
      if (!rows[tab]) tab = c.length ? 'contingencies' : a.length ? 'assessed' : r.length ? 'actions' : 'schedules';
      const together = s.exclusive.find((e) => e.together.length);
      if (together) timeAlong(together);
      else {
        picked = s.groups.filter((g) => g.schedules.some((x) => x.points.length)).slice(0, 1).map((g) => g.id);
        marks = [];
      }
    });
    return () => {
      current = false;
    };
  });

  const matches = (row: { label: string | null; id: string }) => {
    const q = filter.trim().toLowerCase();
    return !q || (row.label ?? '').toLowerCase().includes(q) || row.id.toLowerCase().includes(q);
  };
  let shownContingencies = $derived(contingencies.filter(matches));
  let shownAssessed = $derived(assessed.filter(matches));
  let shownActions = $derived(actions.filter(matches));
  /** A schedule group matches by any of its schedules, or what they are about or referred to by. */
  let shownGroups = $derived(schedules.groups.filter((g) => [...g.schedules, ...g.about, ...g.referredBy].some(matches)));
  let shown = $derived(
    { contingencies: shownContingencies, assessed: shownAssessed, actions: shownActions, schedules: shownGroups }[tab].length,
  );

  /** The schedules the timeline draws: those of the groups picked with points or dates of their own. */
  let drawn = $derived(
    schedules.groups
      .filter((g) => picked.includes(g.id))
      .flatMap((g) => g.schedules.map((s) => ({ ...s, about: g.about.length ? g.about : g.referredBy })))
      .filter((s) => s.points.length || s.values.some((v) => v.time)),
  );
  const pointCount = (g: ScheduleGroup) => g.schedules.reduce((n, s) => n + s.points.length, 0);
  /** The first and last time point of a group, as written. */
  function between(g: ScheduleGroup): string {
    const times = g.schedules.flatMap((s) => s.points.map((p) => p.atTime ?? '')).filter(Boolean).sort();
    if (!times.length) return '';
    return times.length === 1 || times[0] === times[times.length - 1] ? times[0] : `${times[0]} – ${times[times.length - 1]}`;
  }
  const label = (link: Linked) => link.label ?? link.id;

  /** Puts the groups giving exclusive actions' activation on the timeline, and marks when they overlap. */
  function timeAlong(e: ExclusiveActions) {
    const ids = new Set(e.actions.flatMap((a) => a.schedules));
    picked = schedules.groups.filter((g) => g.schedules.some((s) => ids.has(s.id))).map((g) => g.id);
    marks = e.together.map((t) => ({ at: t.at, label: `${t.at}: ${t.actions.length} exclusive actions active` }));
  }

  function pick(id: string, on: boolean) {
    picked = on ? [...picked, id] : picked.filter((p) => p !== id);
    marks = [];
  }

  /** A switch's state as the model gives it, and as the action leaves it. */
  const position = (open: string | boolean | null) => (open === null ? 'not given' : open === true || open === 'true' ? 'open' : 'closed');
  function applying(s: SwitchState): string {
    if (s.openAfter === null) return 'no value for Switch.open';
    if (s.changes === false) return `stays ${position(s.openAfter)}`;
    return `${position(s.open)} → ${position(s.openAfter)}`;
  }

  function show(row: { label: string | null; id: string; grid: Reveal[] }) {
    notOnGrid = onhighlight(row.grid) ? null : `The grid shows none of what ${row.label ?? row.id} is about.`;
  }

  const one = (link: Linked | null) => (link ? [link] : []);
</script>

{#if contingencies.length || assessed.length || actions.length || schedules.groups.length}
  <section aria-label="Network codes" data-testid="network-codes">
    <details open>
      <summary><h2>Network codes</h2></summary>
      <div class="bar" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'contingencies'} onclick={() => (tab = 'contingencies')}>
          Contingencies <span class="sub">{contingencies.length.toLocaleString('en')}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'assessed'} onclick={() => (tab = 'assessed')}>
          Assessed elements <span class="sub">{assessed.length.toLocaleString('en')}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'actions'} onclick={() => (tab = 'actions')}>
          Remedial actions <span class="sub">{actions.length.toLocaleString('en')}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'schedules'} onclick={() => (tab = 'schedules')}>
          Schedules <span class="sub">{schedules.groups.length.toLocaleString('en')}</span>
        </button>
        <input type="search" placeholder="Filter by name or mRID" aria-label="Filter the table" bind:value={filter} />
      </div>
      {#if notOnGrid}<p class="sub" role="status">{notOnGrid}</p>{/if}

      {#if tab === 'schedules'}
        {#each schedules.exclusive as e (e.group.id)}
          <div class="exclusive" class:clash={e.together.length} data-testid="exclusive">
            <Links inline links={[e.group]} {onnavigate} />:
            <Links inline links={e.actions} {onnavigate} /> <span class="sub">exclude one another;</span>
            {#if e.together.length}
              <strong>{e.together.length === 1 ? 'one time' : `${e.together.length} times`} more than one is active:</strong>
              {#each e.together as t, i}<time class="at" datetime={t.at}>{t.at}</time>{i < e.together.length - 1 ? ', ' : '.'}{/each}
            {:else}
              never active together.
            {/if}
            <button type="button" onclick={() => timeAlong(e)}>Show on timeline</button>
          </div>
        {/each}
        {#if picked.length}
          <Timeline schedules={drawn} {marks} {onnavigate} />
        {:else}
          <p class="sub">Tick schedules below to draw them on one time axis.</p>
        {/if}
      {/if}

      <div class="scroll">
        {#if tab === 'schedules'}
          <table data-testid="schedules">
            <thead>
              <tr><th>Draw</th><th>About</th><th>Schedules</th><th>Time points</th><th>Referred to by</th><th></th></tr>
            </thead>
            <tbody>
              {#each shownGroups as g (g.id)}
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Draw ${g.schedules.map(label).join(', ')} on the timeline`}
                      checked={picked.includes(g.id)}
                      onchange={(e) => pick(g.id, e.currentTarget.checked)}
                    />
                  </td>
                  <td><Links links={g.about} {onnavigate} /></td>
                  <td>
                    {#each g.schedules as s (s.id)}
                      <div class="part">
                        <Links inline links={[{ id: s.id, label: s.label ?? s.class, class: s.class }]} {onnavigate} />
                        <span class="sub">{s.class}{s.interpolation ? `, ${s.interpolation}` : ''}</span>
                        {#each s.values as v}
                          <small class="value" class:dated={v.time}>{v.key} = {v.value}</small>
                        {/each}
                      </div>
                    {/each}
                  </td>
                  <td>
                    {#if pointCount(g)}
                      {pointCount(g)} <small class="value">{between(g)}</small>
                    {:else}
                      <span class="sub">none</span>
                    {/if}
                  </td>
                  <td><Links links={g.referredBy} {onnavigate} /></td>
                  <td><button type="button" disabled={!g.grid.length} onclick={() => show({ id: g.id, label: g.schedules.map(label).join(', '), grid: g.grid })}>Show on grid</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'contingencies'}
          <table data-testid="contingencies">
            <thead>
              <tr><th>Contingency</th><th>Class</th><th>Must study</th><th>Equipment</th><th>Assessed elements</th><th></th></tr>
            </thead>
            <tbody>
              {#each shownContingencies as row (row.id)}
                <tr>
                  <td><Links links={[{ id: row.id, label: row.label, class: row.class }]} {onnavigate} /></td>
                  <td>{row.class}</td>
                  <td>{row.mustStudy ?? ''}</td>
                  <td><Links links={row.equipment} {onnavigate} /></td>
                  <td><Links links={row.assessed} {onnavigate} /></td>
                  <td><button type="button" disabled={!row.grid.length} onclick={() => show(row)}>Show on grid</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'actions'}
          <table data-testid="remedial-actions">
            <thead>
              <tr><th>Remedial action</th><th>Class, kind</th><th>Available</th><th>Alterations</th><th>Dependencies</th><th>Applied</th><th></th></tr>
            </thead>
            <tbody>
              {#each shownActions as row (row.id)}
                <tr>
                  <td><Links links={[{ id: row.id, label: row.label, class: row.class }]} {onnavigate} /></td>
                  <td>{row.class}{row.kind ? `, ${row.kind}` : ''}</td>
                  <td>{row.available ?? ''}</td>
                  <td>
                    {#each row.alterations as alteration (alteration.id)}
                      <div class="part">
                        <Links inline links={[{ id: alteration.id, label: alteration.label ?? alteration.class, class: alteration.class }]} {onnavigate} />
                        {#if alteration.target}<span class="sub">on</span> <Links inline links={[alteration.target]} {onnavigate} />{/if}
                        {#each alteration.values as v}
                          <small class="value">{v.property ?? '?'} = {v.value ?? '?'}{v.valueKind ? ` (${v.valueKind})` : ''}</small>
                        {/each}
                      </div>
                    {/each}
                  </td>
                  <td>
                    {#each row.dependencies as dependency (dependency.id)}
                      <div class="part">
                        {dependency.kind ?? ''} {#if dependency.group}<span class="sub">in</span> <Links inline links={[dependency.group]} {onnavigate} />{/if}
                        {#if dependency.with.length}<span class="sub">with</span> <Links inline links={dependency.with} {onnavigate} />{/if}
                      </div>
                    {/each}
                  </td>
                  <td data-testid="applied">
                    {#each row.applied as s (s.id)}
                      <div class="part" class:same={s.changes === false}>
                        <Links links={[s]} {onnavigate} />
                        <small>{applying(s)}</small>
                      </div>
                    {/each}
                  </td>
                  <td><button type="button" disabled={!row.grid.length} onclick={() => show(row)}>Show on grid</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <table data-testid="assessed-elements">
            <thead>
              <tr>
                <th>Assessed element</th><th>In base case</th><th>Secured for</th><th>Scanned for</th><th>Exclusion reason</th>
                <th>Combines with contingencies, remedial actions</th><th>Assesses</th><th>Schedules</th><th>Contingencies</th><th>Remedial actions</th><th></th>
              </tr>
            </thead>
            <tbody>
              {#each shownAssessed as row (row.id)}
                <tr>
                  <td><Links links={[{ id: row.id, label: row.label, class: 'AssessedElement' }]} {onnavigate} /></td>
                  <td>{row.inBaseCase ?? ''}</td>
                  <td><Links links={one(row.securedFor)} {onnavigate} /></td>
                  <td><Links links={one(row.scannedFor)} {onnavigate} /></td>
                  <td>{row.exclusionReason ?? ''}</td>
                  <td>{row.combinableWithContingency ?? '–'}, {row.combinableWithRemedialAction ?? '–'}</td>
                  <td><Links links={one(row.assesses)} {onnavigate} /></td>
                  <td><Links links={row.schedules} {onnavigate} /></td>
                  <td><Links links={row.contingencies} {onnavigate} /></td>
                  <td><Links links={row.remedialActions} {onnavigate} /></td>
                  <td><button type="button" disabled={!row.grid.length} onclick={() => show(row)}>Show on grid</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
      <p class="sub">{count(shown, 'row')} shown.{#if tab === 'actions'}{' '}Applied: the switch states its topology actions set, where a range gives <code>Switch.open</code> an absolute value; nothing is solved.{/if}</p>
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
    gap: 0.5rem;
    margin: 0.5rem 0;
  }

  .bar button,
  td button {
    min-height: 2rem;
    padding: 0 0.6rem;
    font: inherit;
  }

  [role='tab'][aria-selected='true'] {
    border-color: var(--accent);
    font-weight: 600;
  }

  .bar input {
    min-height: 2rem;
    padding: 0 0.5rem;
    font: inherit;
  }

  .scroll {
    max-height: 26rem;
    overflow: auto;
    border: 1px solid var(--line);
  }

  /* Narrower than this, a table scrolls in its box rather than squeezing its words apart. */
  table {
    min-width: 40rem;
    font-size: 0.9rem;
  }

  .at {
    white-space: nowrap;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--bg);
    vertical-align: bottom;
    white-space: nowrap;
  }

  td {
    vertical-align: top;
  }

  .sub {
    color: var(--muted);
  }

  .part + .part {
    margin-top: 0.4rem;
  }

  .value {
    display: block;
    color: var(--muted);
  }

  .same small {
    color: var(--warn);
  }

  .dated {
    color: var(--violation);
  }

  .exclusive {
    margin: 0.5rem 0;
    padding: 0.4rem 0.6rem;
    border-left: 4px solid var(--line);
    background: var(--panel);
  }

  .exclusive.clash {
    border-left-color: var(--warn);
  }

  .exclusive button {
    min-height: 2rem;
    margin-left: 0.25rem;
    padding: 0 0.6rem;
    font: inherit;
  }
</style>
