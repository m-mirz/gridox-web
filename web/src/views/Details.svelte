<script lang="ts">
  import type { WorkerClient } from '../worker/client';
  import type { EditResult, ObjectFields } from '../worker/protocol';
  import ObjectEditor from './ObjectEditor.svelte';

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
    findingsVersion,
    onnavigate,
    onback,
    onclose = null,
    onedited,
  }: {
    client: WorkerClient;
    id: string | null;
    info: Info | null;
    /** Changes when the findings do. */
    findingsVersion: number;
    onnavigate: (id: string) => void;
    /** Back to the object shown before, if there was one. */
    onback: (() => void) | null;
    /** Closes the inspector, where it is a drawer. */
    onclose?: (() => void) | null;
    /** After an edit of the files: what it did, and the object to show then. */
    onedited: (result: EditResult, show: string | null) => void;
  } = $props();

  let object = $state.raw<ObjectFields | null>(null);
  let descriptions = $state(false);
  /** Whether the editor is open, from one object to the next. */
  let editing = $state(false);

  $effect(() => {
    void findingsVersion;
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
  {#if onback || onclose}
    <div class="bar">
      {#if onback}<button type="button" class="back" onclick={onback}>← Back</button>{/if}
      <span class="grow"></span>
      {#if onclose}
        <button type="button" class="ghost close" aria-label="Close the inspector" onclick={onclose}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5"></path></svg>
        </button>
      {/if}
    </div>
  {/if}

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
    <p class="sub">{object.missing ? 'Not in these files' : object.class}</p>
  {:else}
    <p class="sub">Select an object in the tree, or a substation or a line in the grid.</p>
  {/if}

  {#if object}
    {#if object.missing}
      <p data-testid="missing">These files only refer to this object; another dataset, such as a boundary set, may define it.</p>
    {/if}
    {#if object.foreign}
      <p class="sub">Reference data, outside the CIM class tables.</p>
    {/if}
    {#if object.definedIn.length > 1}
      <p class="note" data-testid="defined-in">Defined by {object.definedIn.length} files: {object.definedIn.join(', ')}.</p>
    {:else if object.definedIn.length}
      <p class="sub" data-testid="defined-in">Defined by {object.definedIn[0]}.</p>
    {/if}
    {#if object.types.length}
      <p class="note">Written as {object.types.join(', ')}, by different files.</p>
    {/if}
    {#if !object.missing && !object.defined}
      <p class="note">These files only describe it (<code>rdf:about</code>); none defines it (<code>rdf:ID</code>).</p>
    {/if}
    {#if object.comment}
      <details class="about">
        <summary>About {object.class}</summary>
        <p>{object.comment}</p>
      </details>
    {/if}
  {/if}

  {#if object?.findings.length}
    <h3>Findings</h3>
    <ul class="findings" data-testid="object-findings">
      {#each object.findings as finding, i (i)}
        <li>
          <span class="rule"><span class="badge {finding.severity}">{finding.severity}</span> <span class="mono">{finding.name || finding.rule}</span></span>
          {#if finding.property}<span class="sub">{short(finding.property)}</span>{/if}
          <span>{finding.message}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if object && !object.missing}
    <div class="heading">
      <h3>As written</h3>
      <label><input type="checkbox" bind:checked={descriptions} /> Descriptions</label>
    </div>
    <dl data-testid="fields">
      <dt title="As the file writes it, in rdf:ID or rdf:about: not always IdentifiedObject.mRID">Identifier</dt>
      <dd>{object.id}</dd>
      {#each object.fields as field (field.key)}
        <dt title={field.comment || undefined}>
          {short(field.key)}
          {#if !field.declared && !object.foreign}<span class="note">not in the class tables</span>{/if}
        </dt>
        {#if descriptions && field.comment}<dd class="comment">{field.comment}</dd>{/if}
        <dd>
          {#each field.values as value}
            {#if value.ref}
              <button type="button" class="link" class:missing={value.missing} onclick={() => onnavigate(value.ref as string)}>{value.text}</button>
            {:else}
              <span>{value.text}</span>
            {/if}
          {/each}
        </dd>
      {/each}
    </dl>
  {/if}

  {#if object && !object.missing && !object.foreign}
    {#key object.id}
      <ObjectEditor {client} {object} {onedited} bind:open={editing} />
    {/key}
  {/if}

  {#if object?.referrers.total}
    <h3>Referred to by {object.referrers.total.toLocaleString('en')}</h3>
    <div data-testid="referrers">
      {#each object.referrers.by as group (group.key)}
        <details open={object.referrers.by.length === 1 || group.count <= 5}>
          <summary>{group.key} <span class="sub">{group.count.toLocaleString('en')}</span></summary>
          <ul>
            {#each group.objects as referrer (referrer.id)}
              <li>
                <button type="button" class="link" onclick={() => onnavigate(referrer.id)}>{referrer.label ?? referrer.id}</button>
                <span class="sub">{referrer.class}</span>
              </li>
            {/each}
          </ul>
          {#if group.objects.length < group.count}<p class="sub">The first {group.objects.length} of them.</p>{/if}
        </details>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .grow {
    flex-grow: 1;
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    padding: 0;
  }

  aside {
    overflow: auto;
    padding: 0.75rem 1rem 1rem;
    min-width: 0;
  }

  h2 {
    margin: 0;
    overflow-wrap: anywhere;
  }

  h3 {
    margin: 1.25rem 0 0.4rem;
    color: var(--text-3);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  p {
    margin: 0.25rem 0;
    overflow-wrap: anywhere;
  }

  .sub {
    color: var(--muted);
  }

  .note {
    color: var(--warn);
    font-size: 0.85rem;
  }

  dt .note {
    margin-left: 0.35rem;
  }

  button {
    margin: 0.5rem 0.25rem 0 0;
    min-height: 2rem;
    padding: 0 0.5rem;
    font: inherit;
  }

  .back {
    margin: 0 0 0.5rem;
  }

  .about summary {
    color: var(--muted);
    cursor: pointer;
  }

  .heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .heading label {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .findings,
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.9rem;
  }

  .findings li {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-bottom: 0.5rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    overflow-wrap: anywhere;
  }

  .rule {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
  }

  .rule .mono {
    color: var(--text-2);
    font-size: 0.8rem;
  }

  [data-testid='referrers'] li {
    overflow-wrap: anywhere;
  }

  [data-testid='referrers'] summary {
    cursor: pointer;
    overflow-wrap: anywhere;
    font-size: 0.9rem;
  }

  dl {
    margin: 0;
    font-size: 0.9rem;
  }

  dt {
    margin-top: 0.5rem;
    color: var(--text-3);
    font-family: var(--mono);
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  dd > * {
    display: block;
  }

  dd.comment {
    color: var(--muted);
    font-size: 0.85rem;
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

  .link.missing {
    text-decoration-style: dashed;
  }
</style>
