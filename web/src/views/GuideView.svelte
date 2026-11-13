<script lang="ts">
  import { STEPS, type Step } from '../guide';

  /**
   * The SV-IOP 2026 report's use cases on ReliCapGrid, a step each: what the report asks, what to
   * look at, what the data gives, and "Show me", which loads the example if need be, ticks in the
   * files the use case needs and goes where it is seen.
   */
  let { busy, onshow }: { busy: boolean; onshow: (step: Step) => Promise<void> } = $props();

  let chosen = $state<string>(STEPS[0].id);
  let step = $derived(STEPS.find((s) => s.id === chosen) ?? STEPS[0]);
  let showing = $state<string | null>(null);
  let failed = $state<string | null>(null);

  async function show() {
    showing = step.id;
    failed = null;
    try {
      await onshow(step);
    } catch (error) {
      failed = String(error);
    } finally {
      showing = null;
    }
  }
</script>

<section class="guide" aria-label="Guide" data-testid="guide">
  <div class="head">
    <h2>The SV-IOP 2026 use cases</h2>
    <p class="sub">
      ENTSO-E's 2026 interoperability report scores tools by what they do for each use case. Here each is a step on ReliCapGrid, the example:
      "Show me" ticks in the files it needs and goes where it is seen.
    </p>
  </div>
  <div class="body">
    <ol class="steps">
      {#each STEPS as s, i (s.id)}
        <li>
          <button type="button" class="ghost" aria-current={s.id === chosen ? 'step' : undefined} onclick={() => (chosen = s.id)}>
            <span class="n">{i + 1}</span>{s.title}
          </button>
        </li>
      {/each}
    </ol>
    <article class="step" data-testid="guide-step">
      <h3>{step.title}</h3>
      <dl>
        <dt>The report asks</dt>
        <dd>{step.asks}</dd>
        <dt>Look at</dt>
        <dd>{step.look}</dd>
        <dt>ReliCapGrid gives</dt>
        <dd>{step.finds}</dd>
      </dl>
      <button type="button" class="primary" disabled={busy || !!showing} onclick={show}>{showing ? 'Showing…' : 'Show me'}</button>
      {#if failed}<p role="alert">{failed}</p>{/if}
    </article>
  </div>
</section>

<style>
  .head p {
    max-width: 52rem;
    margin: 0 0 1rem;
  }

  .body {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: flex-start;
  }

  .steps {
    flex: 0 1 18rem;
    margin: 0;
    padding: 0.4rem;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-l);
  }

  .steps button {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    width: 100%;
    text-align: left;
  }

  .steps button[aria-current='step'] {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  .n {
    min-width: 1.4rem;
    color: var(--text-3);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }

  .step {
    flex: 999 1 26rem;
    min-width: 0;
    padding: 1rem 1.25rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-l);
  }

  .step h3 {
    margin: 0 0 0.75rem;
    font-size: 1.1rem;
  }

  dl {
    margin: 0 0 1rem;
  }

  dt {
    color: var(--text-3);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  dd {
    margin: 0.2rem 0 0.9rem;
    max-width: 52rem;
  }
</style>
