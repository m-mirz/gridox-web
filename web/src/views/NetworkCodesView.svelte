<script lang="ts">
  import type { Reveal } from '../grid/model';
  import { count } from '../grid/model';
  import type { WorkerClient } from '../worker/client';
  import type { AssessedElement, Contingency, Linked } from '../worker/protocol';
  import Links from './Links.svelte';

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
  let tab = $state<'contingencies' | 'assessed'>('contingencies');
  let filter = $state('');
  /** What the last "Show on grid" came to, when the grid showed none of it. */
  let notOnGrid = $state<string | null>(null);

  $effect(() => {
    void version;
    let current = true;
    Promise.all([client.request<'contingencies'>({ kind: 'contingencies' }), client.request<'assessedElements'>({ kind: 'assessedElements' })]).then(
      ([c, a]) => {
        if (!current) return;
        contingencies = c;
        assessed = a;
        tab = c.length || !a.length ? 'contingencies' : 'assessed';
      },
    );
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

  function show(row: { label: string | null; id: string; grid: Reveal[] }) {
    notOnGrid = onhighlight(row.grid) ? null : `The grid shows none of what ${row.label ?? row.id} is about.`;
  }

  const one = (link: Linked | null) => (link ? [link] : []);
</script>

{#if contingencies.length || assessed.length}
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
        <input type="search" placeholder="Filter by name or mRID" aria-label="Filter the table" bind:value={filter} />
      </div>
      {#if notOnGrid}<p class="sub" role="status">{notOnGrid}</p>{/if}

      <div class="scroll">
        {#if tab === 'contingencies'}
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
      <p class="sub">{count(tab === 'contingencies' ? shownContingencies.length : shownAssessed.length, 'row')} shown.</p>
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

  table {
    font-size: 0.9rem;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--bg);
    vertical-align: bottom;
  }

  td {
    vertical-align: top;
  }

  .sub {
    color: var(--muted);
  }
</style>
