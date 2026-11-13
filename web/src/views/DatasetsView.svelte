<script lang="ts">
  import { count } from '../grid/model';
  import type { WorkerClient } from '../worker/client';
  import type { Datasets } from '../worker/protocol';

  let {
    client,
    findingsVersion,
    onnavigate,
  }: {
    client: WorkerClient;
    /** Changes when validation has read the files again, which is when this is known. */
    findingsVersion: number;
    onnavigate: (id: string) => void;
  } = $props();

  let datasets = $state.raw<Datasets | null>(null);

  $effect(() => {
    if (!findingsVersion) {
      datasets = null;
      return;
    }
    let current = true;
    client.request<'datasets'>({ kind: 'datasets' }).then((found) => {
      if (current) datasets = found;
    });
    return () => {
      current = false;
    };
  });

  /** How many of a header's references lead nowhere in what is loaded. */
  const unresolved = (d: Datasets) =>
    d.files.reduce((n, f) => n + (f.header?.refs ?? []).reduce((m, r) => m + r.values.filter((v) => v.missing).length, 0), 0);
  /** The last part of a profile's IRI, which names it. */
  const profile = (iri: string) => iri.replace(/[/#]+$/, '').split('/').slice(-2).join('/');
</script>

{#if datasets}
  <section aria-label="Datasets" data-testid="datasets">
    <details>
      <summary>
        <h2>Datasets</h2>
        <span data-testid="datasets-summary">
          {count(datasets.files.length, 'file')} · {count(datasets.twice.count, 'object')} defined more than once ·
          {count(datasets.conflicts.count, 'object')} typed with unrelated classes · {count(unresolved(datasets), 'header reference')} not loaded ·
          {count(datasets.unresolved, 'reference')} to objects not loaded
        </span>
      </summary>

      {#if datasets.twice.count}
        <h3>Defined more than once</h3>
        <ul data-testid="twice">
          {#each datasets.twice.objects as o (o.id)}
            <li>
              <button type="button" class="link" onclick={() => onnavigate(o.id)}>{o.label ?? o.id}</button>
              <span class="sub">{o.class ?? ''} · {o.files.join(', ')}</span>
            </li>
          {/each}
        </ul>
        {#if datasets.twice.objects.length < datasets.twice.count}<p class="sub">The first {datasets.twice.objects.length}.</p>{/if}
      {/if}

      {#if datasets.conflicts.count}
        <h3>Typed with unrelated classes</h3>
        <ul data-testid="conflicts">
          {#each datasets.conflicts.objects as o (o.id)}
            <li>
              <button type="button" class="link" onclick={() => onnavigate(o.id)}>{o.label ?? o.id}</button>
              <span class="sub">{o.types.join(', ')}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <h3>Files</h3>
      <ul class="files" data-testid="dataset-files">
        {#each datasets.files as file (file.name)}
          <li>
            <details>
              <summary>
                <strong>{file.name}</strong>
                <span class="sub">
                  {count(file.objects, 'object')}{file.foreign ? `, ${file.foreign.toLocaleString('en')} of reference data` : ''}
                  {#if file.header}· {file.header.profiles.map(profile).join(', ')}{:else}· no header{/if}
                  {#if file.unresolved.count}· <span class="warn">{count(file.unresolved.count, 'reference')} to objects not loaded</span>{/if}
                </span>
              </summary>
              {#if file.unresolved.count}
                <ul class="unresolved" data-testid="unresolved">
                  {#each file.unresolved.references as r, i (i)}
                    <li>
                      <button type="button" class="link" onclick={() => onnavigate(r.id)}>{r.label ?? r.id}</button>
                      <span class="sub">{r.class ?? ''} {r.key} →</span> <span class="missing">{r.target}</span>
                    </li>
                  {/each}
                  {#if file.unresolved.references.length < file.unresolved.count}<li class="sub">The first {file.unresolved.references.length}.</li>{/if}
                </ul>
              {/if}
              {#if file.header}
                <button type="button" class="link" onclick={() => onnavigate(file.header!.id)}>{file.header.class} {file.header.id}</button>
                <dl>
                  {#each file.header.refs as ref (ref.key)}
                    <dt>{ref.key}</dt>
                    <dd>
                      {#each ref.values as value}
                        {#if value.missing}
                          <span class="missing">{value.text} <small>not loaded</small></span>
                        {:else if value.ref}
                          <button type="button" class="link" onclick={() => onnavigate(value.ref as string)}>{value.text}</button>
                        {:else}
                          <span>{value.text}</span>
                        {/if}
                      {/each}
                    </dd>
                  {/each}
                </dl>
              {:else}
                <p class="sub">Without a header, validation does not know its profiles and checks nothing in it.</p>
              {/if}
            </details>
          </li>
        {/each}
      </ul>
    </details>
  </section>
{/if}

<style>
  section {
    margin-top: 1rem;
  }

  summary {
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  summary h2 {
    display: inline;
    margin-right: 0.75rem;
  }

  h3 {
    margin: 0.75rem 0 0.25rem;
    font-size: 1rem;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    padding: 0.15rem 0;
    overflow-wrap: anywhere;
  }

  .files {
    max-height: 24rem;
    overflow: auto;
    border: 1px solid var(--line);
    padding: 0.25rem 0.5rem;
  }

  .sub {
    color: var(--muted);
  }

  .warn {
    color: var(--warn);
  }

  .unresolved {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1.25rem;
    overflow-wrap: anywhere;
  }

  .missing {
    display: block;
    color: var(--warn);
  }

  dl {
    margin: 0.25rem 0 0.5rem;
    font-size: 0.9rem;
  }

  dt {
    margin-top: 0.3rem;
    color: var(--muted);
  }

  dd {
    margin: 0;
  }

  dd > * {
    display: block;
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
</style>
