<script lang="ts">
  import type { WorkerClient } from '../worker/client';
  import type { ObjectFields } from '../worker/protocol';

  /** What a view says of what is selected in it. */
  export interface Info {
    heading: string;
    sub: string;
    lines?: string[];
    table?: [string, number][];
    actions?: { label: string; run: () => void }[];
  }

  let {
    client,
    id,
    info,
    onnavigate,
  }: {
    client: WorkerClient;
    id: string | null;
    info: Info | null;
    onnavigate: (id: string) => void;
  } = $props();

  let object = $state.raw<ObjectFields | null>(null);

  $effect(() => {
    const asked = id;
    if (!asked) {
      object = null;
      return;
    }
    let current = true;
    client.request<'object'>({ kind: 'object', id: asked }).then(
      (found) => {
        if (current) object = found;
      },
      () => {
        if (current) object = null;
      },
    );
    return () => {
      current = false;
    };
  });

  /** `Class.attr`, without what the heading says. */
  const short = (key: string) => key.replace(/^IdentifiedObject\./, '');
</script>

<aside data-testid="details">
  {#if info}
    <h2>{info.heading}</h2>
    <p class="sub">{info.sub}</p>
    {#each info.lines ?? [] as line}
      <p>{line}</p>
    {/each}
    {#if info.table?.length}
      <table>
        <tbody>
          {#each info.table as [name, number]}
            <tr><td>{name}</td><td class="number">{number}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#each info.actions ?? [] as action}
      <button type="button" onclick={action.run}>{action.label}</button>
    {/each}
  {:else if object}
    <h2>{object.label ?? object.id}</h2>
    <p class="sub">{object.class}</p>
  {:else}
    <p class="sub">Select an object in the tree, or a substation or a line in the grid.</p>
  {/if}

  {#if object}
    <h3>As written</h3>
    <dl data-testid="fields">
      <dt>mRID</dt>
      <dd>{object.id}</dd>
      {#each object.fields as field (field.key)}
        <dt>{short(field.key)}</dt>
        <dd>
          {#each field.values as value}
            {#if value.ref}
              <button type="button" class="link" onclick={() => onnavigate(value.ref as string)}>{value.text}</button>
            {:else}
              <span>{value.text}</span>
            {/if}
          {/each}
        </dd>
      {/each}
    </dl>
  {/if}
</aside>

<style>
  aside {
    overflow: auto;
    padding: 0.5rem 0.75rem;
    min-width: 0;
  }

  h2 {
    margin: 0;
    overflow-wrap: anywhere;
  }

  h3 {
    margin: 1rem 0 0.25rem;
    font-size: 0.95rem;
  }

  p {
    margin: 0.25rem 0;
  }

  .sub {
    color: var(--muted);
  }

  button {
    margin: 0.5rem 0.25rem 0 0;
    min-height: 2rem;
    padding: 0 0.5rem;
    font: inherit;
  }

  dl {
    margin: 0;
    font-size: 0.9rem;
  }

  dt {
    margin-top: 0.4rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  dd > * {
    display: block;
  }

  .link {
    margin: 0;
    padding: 0;
    min-height: 0;
    border: none;
    background: none;
    color: var(--accent);
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
</style>
