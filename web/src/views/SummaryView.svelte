<script lang="ts">
  import type { Summary } from '../worker/protocol';

  /**
   * What the files loaded came to. `files`: the totals, the files and those not loaded, for the
   * Files sidebar; `classes`: the objects by class, for the Data quality view.
   */
  let { summary, part }: { summary: Summary; part: 'files' | 'classes' } = $props();
  let skipped = $derived(summary.files.filter((file) => file.status === 'skipped'));
  let loaded = $derived(summary.files.filter((file) => file.status === 'loaded'));
  /** The files the model is made of: those loaded, less those left out. */
  let inModel = $derived(loaded.length - summary.excluded.length);
</script>

{#if part === 'files'}
  <p data-testid="totals" class="totals">
    {summary.objects.toLocaleString('en')} objects from {inModel}
    {inModel === 1 ? 'file' : 'files'}{#if summary.foreign}, and {summary.foreign.toLocaleString('en')} of classes outside
      CIM, such as reference data{/if}.
  </p>

  {#if skipped.length}
    <details class="not-loaded" open={skipped.length <= 3}>
      <summary>{skipped.length === 1 ? '1 file' : `${skipped.length} files`} not loaded</summary>
      <ul class="skipped" data-testid="skipped">
        {#each skipped as file}
          {#if file.status === 'skipped'}
            <li><strong>{file.name}</strong>: {file.reason}</li>
          {/if}
        {/each}
      </ul>
    </details>
  {/if}
{:else if summary.classes.length}
  <h3>Objects by class</h3>
  <table data-testid="classes">
    <thead>
      <tr><th scope="col">Class</th><th scope="col" class="number">Objects</th></tr>
    </thead>
    <tbody>
      {#each summary.classes as row (row.class)}
        <tr><td>{row.class}</td><td class="number">{row.objects.toLocaleString('en')}</td></tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .totals {
    margin: 0;
    color: var(--text-2);
  }

  .not-loaded summary {
    color: var(--warning);
    font-weight: 600;
  }

  .skipped {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--warning);
    overflow-wrap: anywhere;
  }
</style>
