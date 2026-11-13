<script lang="ts">
  import type { WorkerClient } from '../worker/client';
  import type { BoundaryPoint } from '../worker/protocol';
  import Links from './Links.svelte';

  /**
   * The boundary points (BDS_UC1): each with the IGMs whose equipment reaches it, the topological
   * nodes its terminals lie on and whether they have a voltage, and what of that is amiss, first.
   * Two IGMs should meet at each, on one node of the topology, solved. Known once validated, as
   * validation reads which file defines what.
   */
  let { client, findingsVersion, onnavigate }: { client: WorkerClient; findingsVersion: number; onnavigate: (id: string) => void } = $props();

  let points = $state.raw<BoundaryPoint[] | null>(null);

  $effect(() => {
    void findingsVersion;
    let live = true;
    client.request<'boundaryPoints'>({ kind: 'boundaryPoints' }).then((found) => {
      if (live) points = found;
    });
    return () => {
      live = false;
    };
  });

  let amiss = $derived((points ?? []).filter((p) => p.amiss.length).length);
</script>

{#if points?.length}
  <section aria-label="Boundary points" data-testid="boundary-points">
    <div class="head">
      <h2>Boundary points</h2>
      <span class="sub">{points.length} · {amiss ? `${amiss} with something amiss, first` : 'two IGMs meet at each, on one solved node'}</span>
    </div>
    <div class="scroll">
      <table>
        <thead>
          <tr><th>Boundary point</th><th>IGMs reaching it</th><th class="number">Terminals</th><th>Topological node</th><th>Amiss</th></tr>
        </thead>
        <tbody>
          {#each points as p (p.point.id)}
            <tr class:amiss={p.amiss.length}>
              <td><Links links={[p.point]} {onnavigate} /></td>
              <td>{p.igms.join(', ') || '—'}</td>
              <td class="number">{p.terminals}{p.onNone ? `, ${p.onNone} on none` : ''}</td>
              <td>
                {#each p.topological as t (t.node.id)}
                  <div><Links inline links={[t.node]} {onnavigate} /> <span class="sub">{t.voltage ? 'solved' : 'no voltage'}</span></div>
                {/each}
              </td>
              <td class="warn">{p.amiss.join('; ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<style>
  section {
    margin-top: 1.5rem;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 0.75rem;
  }

  .head h2 {
    margin: 0 0 0.5rem;
  }

  .warn {
    color: var(--warning);
  }

  .scroll {
    overflow-x: auto;
  }
</style>
