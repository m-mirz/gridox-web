<script lang="ts">
  import type { Linked } from '../worker/protocol';

  /** Objects linked to from a table cell, each a link to its page, with what the link says of it. */
  let { links, onnavigate }: { links: Linked[]; onnavigate: (id: string) => void } = $props();
</script>

{#each links as link (link.id)}
  <span class="link-cell">
    <button type="button" class="link" class:missing={link.missing} title={link.missing ? 'Not in the files loaded' : (link.class ?? undefined)} onclick={() => onnavigate(link.id)}>{link.label ?? link.id}</button>
    {#if link.status ?? link.kind}<small>{link.status ?? link.kind}</small>{/if}
  </span>
{/each}

<style>
  .link-cell {
    display: block;
    overflow-wrap: anywhere;
  }

  .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  .link.missing {
    text-decoration-style: dashed;
  }

  small {
    margin-left: 0.25rem;
    color: var(--muted);
  }
</style>
