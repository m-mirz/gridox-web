<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { count, findingsText } from '../grid/model';
  import type { WorkerClient } from '../worker/client';
  import type { Checks, Finding, FindingsSummary } from '../worker/protocol';

  let {
    client,
    findings,
    checking,
    checks,
    onchecks,
    onnavigate,
  }: {
    client: WorkerClient;
    /** `null` before the model is first validated. */
    findings: FindingsSummary | null;
    checking: boolean;
    checks: Checks;
    onchecks: (checks: Checks) => void;
    onnavigate: (id: string) => void;
  } = $props();

  /** As many as the library lists of one rule. */
  const LIMIT = 500;
  /** Each rule's findings, once opened. */
  const listed = new SvelteMap<string, Finding[]>();

  $effect(() => {
    void findings;
    listed.clear();
  });

  async function open(event: Event, rule: string) {
    if (!(event.currentTarget as HTMLDetailsElement).open || listed.has(rule)) return;
    listed.set(rule, await client.request<'findings'>({ kind: 'findings', rule }));
  }

  const total = (f: FindingsSummary) => f.violation + f.warning + f.info;
</script>

<section aria-label="Findings" data-testid="findings">
  <div class="head">
    <h2>Validation</h2>
    <span data-testid="findings-summary">
      {#if checking}
        Validating…
      {:else if findings}
        {findingsText(findings)} in {count(findings.files.length, 'file')}
      {/if}
    </span>
    <label>
      <input type="checkbox" checked={checks.common} disabled={checking} onchange={(e) => onchecks({ ...checks, common: e.currentTarget.checked })} />
      Common cross-profile checks
    </label>
    <label>
      <input type="checkbox" checked={checks.quality} disabled={checking} onchange={(e) => onchecks({ ...checks, quality: e.currentTarget.checked })} />
      Modelling-quality checks
    </label>
  </div>
  <p class="sub">The ENTSO-E profiles' constraints, as <code>cimcli validate</code> checks them. Each file's profiles come from its header: a file without one is not checked.</p>

  {#if findings && total(findings)}
    <details>
      <summary>{count(findings.rules.length, 'rule')} broken</summary>
      <ul class="rules">
        {#each findings.rules as rule (rule.rule)}
          <li>
            <details ontoggle={(event) => open(event, rule.rule)}>
              <summary>
                <span class={rule.severity}>{rule.severity}</span>
                <strong>{rule.name || rule.rule}</strong>
                <span class="count">{rule.count.toLocaleString('en')}</span>
              </summary>
              {#if rule.description}<p class="sub">{rule.description}</p>{/if}
              <p class="sub rule-id">{rule.rule}</p>
              {#if listed.get(rule.rule)}
                <ul class="found" data-testid="found">
                  {#each listed.get(rule.rule) ?? [] as finding, i (i)}
                    <li>
                      <button type="button" class="link" onclick={() => onnavigate(finding.object)}>
                        {finding.label ?? finding.object}
                      </button>
                      <span class="sub">{finding.class}{finding.property ? ` · ${finding.property}` : ''}{finding.file ? ` · ${finding.file}` : ''}</span>
                      <span>{finding.message}</span>
                    </li>
                  {/each}
                </ul>
                {#if rule.count > LIMIT}<p class="sub">The first {LIMIT} of {rule.count.toLocaleString('en')}.</p>{/if}
              {/if}
            </details>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</section>

<style>
  section {
    margin-top: 1rem;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 1rem;
  }

  h2 {
    margin: 0;
  }

  label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .sub {
    margin: 0.25rem 0;
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .rule-id {
    font-size: 0.85rem;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rules {
    max-height: 24rem;
    overflow: auto;
    border: 1px solid var(--line);
  }

  .rules > li {
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--line);
  }

  .rules summary {
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  .count {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .violation {
    color: var(--violation);
  }

  .warning {
    color: var(--warning);
  }

  .info {
    color: var(--info);
  }

  .found li {
    display: flex;
    flex-direction: column;
    padding: 0.25rem 0 0.25rem 1rem;
    overflow-wrap: anywhere;
  }

  .link {
    align-self: flex-start;
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
