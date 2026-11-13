/**
 * The app shows one view at a time. `at` goes to the view a test id is in (its tab, when there are
 * tabs) and gives the locator, so a test reads as it did when every panel was on one page.
 */
import type { Page } from '@playwright/test';

const VIEWS: [string, string[]][] = [
  ['Explore', ['tree', 'hits', 'details', 'inspector', 'fields', 'edit', 'referrers', 'guided-elements', 'guided-points', 'grid-summary', 'graph', 'flow-legend', 'object-findings', 'no-grid', 'defined-in', 'delete-preview', 'missing']],
  ['Validation', ['findings', 'findings-summary', 'found']],
  ['Network codes', ['network-codes', 'no-network-codes', 'applied', 'assessed-elements', 'contingencies', 'exclusive', 'remedial-actions', 'schedules', 'timeline']],
  ['Power flow', ['power-flow']],
  ['Contingencies', ['security', 'no-contingencies']],
  ['Guide', ['guide', 'guide-step']],
  ['Data quality', ['datasets', 'datasets-summary', 'dataset-files', 'twice', 'conflicts', 'unresolved', 'classes', 'boundary-points']],
];

/** The view showing test id `id`: by name, or by its prefix (`pf-`, `sa-`). */
export function viewOf(id: string): string | null {
  if (id.startsWith('pf-')) return 'Power flow';
  if (id.startsWith('sa-')) return 'Contingencies';
  return VIEWS.find(([, ids]) => ids.includes(id))?.[0] ?? null;
}

/** Goes to view `name`, if the page has views yet. */
export async function view(page: Page, name: string) {
  const tab = page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name, exact: true });
  // The tabs come with the model: wait a while for them, then go on without if there is none.
  await tab.waitFor({ timeout: 15_000 }).catch(() => undefined);
  if (await tab.count()) await tab.click();
}

/** The element of test id `id`, its view shown. */
export async function at(page: Page, id: string) {
  const name = viewOf(id);
  if (name) await view(page, name);
  return page.getByTestId(id);
}

/** Waits for validation to have run: the top bar's status shows its counts. */
export async function validated(page: Page, timeout = 30_000) {
  await page.getByTestId('status').locator('.badge').first().waitFor({ timeout });
}
