<script lang="ts">
  import type { WorkerClient } from '../worker/client';
  import type { Candidate, EditForm, EditResult, Fixes, Linked, ObjectFields } from '../worker/protocol';

  /**
   * Edits to one object, in the files as written: the fixes for its findings, its fields set,
   * removed or added, an object added in it, its mRID renamed, and the object deleted. Each goes
   * to the worker, which changes the files and decodes them again; `onedited` then takes over.
   */
  let {
    client,
    object,
    onedited,
    open = $bindable(false),
  }: {
    client: WorkerClient;
    object: ObjectFields;
    /** Whether it is open: it stays so from one object to the next. */
    open?: boolean;
    /** After an edit: what it did, and the object to show then. */
    onedited: (result: EditResult, show: string | null) => void;
  } = $props();

  let form = $state.raw<EditForm | null>(null);
  let fixes = $state.raw<Fixes | null>(null);
  let addable = $state.raw<{ class: string; key: string; comment: string }[]>([]);
  let failed = $state<string | null>(null);
  let busy = $state(false);
  /** The value typed or chosen for each field. */
  let values = $state<Record<string, string>>({});
  let adding = $state('');
  let renamed = $state('');
  let newClass = $state('');
  let newName = $state('');
  let deleting = $state<{ objects: number; references: number; files: string[]; contained: number } | null>(null);
  let withContained = $state(false);
  let candidates = $state<Record<string, Candidate[]>>({});
  /** RA_UC4: who answers a remedial action schedule, and with whom. */
  let responders = $state.raw<Linked[]>([]);
  let responding = $state('');

  /** A field's value as the object writes it: a reference's mRID, an enumeration's value. */
  function current(key: string): string {
    const field = object.fields.find((f) => f.key === key);
    const value = field?.values[0];
    if (!value) return '';
    return value.ref ?? value.text;
  }

  // Asked again whenever the object is, as an edit changes it.
  $effect(() => {
    const id = object.id;
    void object.fields;
    let live = true;
    failed = null;
    deleting = null;
    renamed = id;
    Promise.all([
      client.request<'editForm'>({ kind: 'editForm', id }),
      client.request<'editFixes'>({ kind: 'editFixes', id }),
      client.request<'editAddable'>({ kind: 'editAddable', parent: id }),
      object.class === 'RemedialActionSchedule' ? client.request<'editResponders'>({ kind: 'editResponders' }) : Promise.resolve([]),
    ]).then(([f, x, a, r]) => {
      if (!live) return;
      responders = r;
      form = f;
      fixes = x;
      addable = a;
      values = Object.fromEntries((f?.fields ?? []).filter((field) => field.written).map((field) => [field.key, current(field.key)]));
      newClass = a[0]?.class ?? '';
    });
    return () => {
      live = false;
    };
  });

  let written = $derived((form?.fields ?? []).filter((f) => f.written));
  let unwritten = $derived((form?.fields ?? []).filter((f) => !f.written));
  let added = $derived(unwritten.find((f) => f.key === adding) ?? null);

  async function run(request: Promise<EditResult>, show: string | null = object.id) {
    busy = true;
    failed = null;
    try {
      const result = await request;
      if (result.error) failed = result.error;
      else onedited(result, result.id ?? show);
    } catch (error) {
      failed = String(error);
    } finally {
      busy = false;
    }
  }

  const set = (key: string) => run(client.request<'editSet'>({ kind: 'editSet', id: object.id, key, value: values[key] ?? '' }));
  const remove = (key: string) => run(client.request<'editRemove'>({ kind: 'editRemove', id: object.id, key }));
  const fix = (edits: unknown) =>
    run(client.request<'editApply'>({ kind: 'editApply', revision: fixes?.revision ?? -1, edits }));

  async function preview() {
    deleting = await client.request<'editDeletePreview'>({ kind: 'editDeletePreview', id: object.id, contained: withContained });
  }

  async function suggest(key: string) {
    if (candidates[key]) return;
    candidates = { ...candidates, [key]: await client.request<'editCandidates'>({ kind: 'editCandidates', id: object.id, key }) };
  }

  /** `PhaseCode.ABC` as `ABC`. */
  const short = (value: string) => value.split('.').pop() ?? value;
  const label = (key: string) => key.replace(/^IdentifiedObject\./, '');
</script>

{#snippet control(field: EditForm['fields'][number])}
  {#if field.kind === 'enumeration'}
    <select aria-label={`Value of ${field.key}`} bind:value={values[field.key]}>
      {#each field.values as v}<option value={v}>{short(v)}</option>{/each}
    </select>
  {:else if field.kind === 'literal' && field.xsd === 'boolean'}
    <select aria-label={`Value of ${field.key}`} bind:value={values[field.key]}>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  {:else if field.kind === 'reference'}
    <input aria-label={`Value of ${field.key}`} list={`c-${field.key}`} placeholder="mRID" bind:value={values[field.key]} onfocus={() => suggest(field.key)} />
    <datalist id={`c-${field.key}`}>
      {#each candidates[field.key] ?? [] as c (c.id)}<option value={c.id}>{c.class} {c.label}{c.place ? ` in ${c.place}` : ''}</option>{/each}
    </datalist>
  {:else}
    <input aria-label={`Value of ${field.key}`} bind:value={values[field.key]} />
  {/if}
{/snippet}

<details class="edit" data-testid="edit" bind:open>
  <summary>Edit</summary>
  {#if failed}<p role="alert" data-testid="edit-error">{failed}</p>{/if}

  {#if object.class === 'RemedialActionSchedule'}
    <h4>Refuse with a counter-proposal (RA_UC4)</h4>
    <p class="sub">
      A dataset of its own: a response refusing this schedule, a copy of it with its event schedules and time points, not active, under new
      mRIDs, and a dependency from the copy to this one.
    </p>
    <div class="row">
      <select aria-label="Responding entity" bind:value={responding}>
        <option value="">No responding entity</option>
        {#each responders as r (r.id)}<option value={r.id}>{r.label ?? r.id}</option>{/each}
      </select>
      <button
        type="button"
        disabled={busy}
        onclick={() => run(client.request<'editCounterProposal'>({ kind: 'editCounterProposal', refused: object.id, responding: responding || null }))}
      >Counter-propose</button>
    </div>
  {/if}

  {#if fixes?.fixes.length}
    <h4>Fixes</h4>
    {#each fixes.fixes as f, i (i)}
      <button type="button" class="fix" disabled={busy} onclick={() => fix(f.edits)}>{f.title}</button>
    {/each}
  {/if}

  {#if written.length}
    <h4>Fields</h4>
    {#each written as field (field.key)}
      <div class="row">
        <span class="key" title={field.comment || undefined}>{label(field.key)}</span>
        {@render control(field)}
        <button type="button" disabled={busy || values[field.key] === current(field.key)} onclick={() => set(field.key)}>Set</button>
        <button type="button" disabled={busy} aria-label={`Remove ${field.key}`} onclick={() => remove(field.key)}>Remove</button>
      </div>
    {/each}
  {/if}

  {#if unwritten.length}
    <h4>Add a field</h4>
    <div class="row">
      <select aria-label="Field to add" bind:value={adding}>
        <option value="">Choose…</option>
        {#each unwritten as f (f.key)}<option value={f.key}>{label(f.key)}</option>{/each}
      </select>
      {#if added}
        {@render control(added)}
        <button type="button" disabled={busy || !(values[added.key] ?? '').trim()} onclick={() => set(added!.key)}>Add field</button>
      {/if}
    </div>
  {/if}

  {#if addable.length}
    <h4>Add an object in it</h4>
    <div class="row">
      <select aria-label="Class to add" bind:value={newClass}>
        {#each addable as a (a.class)}<option value={a.class} title={a.comment}>{a.class}</option>{/each}
      </select>
      <input aria-label="Name of the object to add" placeholder="Name" bind:value={newName} />
      <button
        type="button"
        disabled={busy || !newClass}
        onclick={() => run(client.request<'editAdd'>({ kind: 'editAdd', parent: object.id, class: newClass, name: newName.trim() || null }))}
      >Add object</button>
    </div>
  {/if}

  <h4>Rename the mRID</h4>
  <div class="row">
    <input aria-label="New mRID" bind:value={renamed} />
    <button
      type="button"
      disabled={busy || !renamed.trim() || renamed.trim() === object.id}
      onclick={() => run(client.request<'editRename'>({ kind: 'editRename', old: object.id, new: renamed.trim() }), renamed.trim())}
    >Rename</button>
  </div>

  <h4>Delete</h4>
  {#if deleting}
    <p class="warn" data-testid="delete-preview">
      Deletes {deleting.objects} {deleting.objects === 1 ? 'object' : 'objects'} and {deleting.references}
      {deleting.references === 1 ? 'reference' : 'references'} to {deleting.objects === 1 ? 'it' : 'them'}, in {deleting.files.join(', ')}.
    </p>
    <button type="button" disabled={busy} onclick={() => run(client.request<'editDelete'>({ kind: 'editDelete', id: object.id, contained: withContained }), null)}>Delete</button>
    <button type="button" onclick={() => (deleting = null)}>Cancel</button>
  {:else}
    <label><input type="checkbox" bind:checked={withContained} /> With what it contains</label>
    <button type="button" onclick={preview}>Delete…</button>
  {/if}
</details>

<style>
  .edit {
    margin-top: 1rem;
    font-size: 0.9rem;
  }

  summary {
    cursor: pointer;
    font-weight: 600;
  }

  h4 {
    margin: 0.75rem 0 0.25rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.4rem;
    margin-bottom: 0.3rem;
  }

  .key {
    flex: 1 1 100%;
    overflow-wrap: anywhere;
  }

  input,
  select,
  button {
    min-height: 2rem;
    max-width: 100%;
    font: inherit;
  }

  input {
    flex: 1 1 8rem;
    min-width: 0;
    padding: 0 0.4rem;
  }

  .fix {
    display: block;
    margin: 0 0 0.3rem;
    text-align: left;
  }

  .warn {
    color: var(--warn);
  }

  .sub {
    margin: 0 0 0.3rem;
    color: var(--muted);
  }
</style>
