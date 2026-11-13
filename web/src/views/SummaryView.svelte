<script lang="ts">
  import type { Summary } from '../worker/protocol';

  /**
   * What the files loaded came to. `files`: the totals, the files and those not loaded, for the
   * Files sidebar; `classes`: the objects by class, for the Data quality view.
   */
  let { summary, part }: { summary: Summary; part: 'files' | 'classes' } = $props();
  let skipped = $derived(summary.files.filter((file) => file.status === 'skipped'));
  let loaded = $derived(summary.files.filter((file) => file.status === 'loaded'));
</script>

{#if part === 'files'}
  <p data-testid="totals" class="totals">
    {summary.objects.toLocaleString('en')} objects from {loaded.length}
    {loaded.length === 1 ? 'file' : 'files'}{#if summary.foreign}, and {summary.foreign.toLocaleString('en')} of classes outside
      CIM, such as reference data{/if}.
  </p>

  <ul class="files" data-testid="loaded-files">
    {#each loaded as file (file.name)}
      {#if file.status === 'loaded'}
        <li title={file.name}><span class="name">{file.name}</span><span class="sub">{file.objects.toLocaleString('en')}</span></li>
      {/if}
    {/each}
  </ul>

  {#if skipped.length}
    <h3>Not loaded</h3>
    <ul class="skipped" data-testid="skipped">
      {#each skipped as file}
        {#if file.status === 'skipped'}
          <li><strong>{file.name}</strong>: {file.reason}</li>
        {/if}
      {/each}
    </ul>
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

  .files {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .files li {
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
    padding: 0.2rem 0;
    font-family: var(--mono);
    font-size: 0.8rem;
  }

  .files .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skipped {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--warning);
    overflow-wrap: anywhere;
  }
</style>
