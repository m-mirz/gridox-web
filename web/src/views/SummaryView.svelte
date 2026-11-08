<script lang="ts">
  import type { Summary } from '../worker/protocol';

  let { summary }: { summary: Summary } = $props();
  let skipped = $derived(summary.files.filter((file) => file.status === 'skipped'));
  let loaded = $derived(summary.files.length - skipped.length);
</script>

<p data-testid="totals">
  {summary.objects.toLocaleString('en')} objects from {loaded}
  {loaded === 1 ? 'file' : 'files'}{#if summary.foreign}, and {summary.foreign.toLocaleString('en')} of classes outside
    CIM, such as reference data{/if}.
</p>

{#if skipped.length}
  <h2>Not loaded</h2>
  <ul data-testid="skipped">
    {#each skipped as file}
      {#if file.status === 'skipped'}
        <li><strong>{file.name}</strong>: {file.reason}</li>
      {/if}
    {/each}
  </ul>
{/if}

{#if summary.classes.length}
  <h2>Classes</h2>
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
  ul {
    color: var(--warn);
    padding-left: 1.25rem;
  }
</style>
