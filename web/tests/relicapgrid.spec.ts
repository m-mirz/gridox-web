/**
 * Acceptance: each use case of the report on ReliCapGrid, through the UI, seeing what cimoxide's
 * harness (`scripts/relicapgrid/test_use_cases.py`) and gridoxide's report record, data problems
 * included. They load whole models, so they run in Chromium only; the fixture tests cover the
 * browsers. Without the dataset (see `relicapgrid/files.ts`) they skip.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ALL_GRID, ALL_NC, AREAS, BOUNDARY, CGM, CO, COMMON, EVERYTHING, PRESENT, REFERENCE, ROOT, SUPPLIED_SAR, area, withBoundary } from './relicapgrid/files';
import { at, validated, view } from './views';

/** cimoxide's CLI, to validate what the app writes: `$CIMCLI`, else a release build beside this checkout. */
const CIMCLI = process.env.CIMCLI ?? join(import.meta.dirname, '../../../cimoxide/target/release/cimcli');

test.skip(!PRESENT, 'ReliCapGrid is not checked out: set RELICAPGRID_DIR, or fetch cimoxide/relicapgrid');
test.skip(({ browserName }) => browserName !== 'chromium', 'whole models: Chromium only');
test.describe.configure({ timeout: 300_000 });

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

/** Loads `files` and waits until every one is in. */
async function load(page: Page, files: string[]) {
  await page.getByLabel('Choose files').setInputFiles(files);
  await expect(page.getByTestId('totals')).toContainText(`from ${files.length} files`, { timeout: 200_000 });
}

/** Shows the object `mrid` (with its `_`), found by the tree's search; its Edit panel, opened. */
async function show(page: Page, mrid: string) {
  await (await at(page, 'tree')).getByRole('searchbox').fill(mrid);
  await (await at(page, 'hits')).getByRole('button').first().click();
  const details = (await at(page, 'details'));
  await expect(details).toContainText(mrid);
  return details;
}

async function solve(page: Page, qLimits = true) {
  const pf = (await at(page, 'power-flow'));
  const box = pf.getByLabel('Hold reactive limits');
  if ((await box.isChecked()) !== qLimits) await box.click();
  await pf.getByRole('button', { name: /^Solve/ }).click();
  await expect((await at(page, 'pf-verdict'))).toBeVisible({ timeout: 200_000 });
  return pf;
}

// PF_UC1: each IGM solved, set against its own SV. What each gives is what gridoxide's report
// records: Belgovia within 0.03 % of its SV, Svedala within 0.68 %, Espheim not converging with
// reactive limits held.
const PF: Record<string, { verdict: string; sv: string }> = {
  Belgovia: { verdict: '15 nodes solved, in 1 component.', sv: '0.03 %, 0.02° at most, over 15 nodes' },
  Britheim: { verdict: '6 nodes solved, in 2 components.', sv: '0.14 %, 0.21° at most, over 3 nodes' },
  'DC-Espheim-Svedala': { verdict: '6 nodes solved, in 2 components.', sv: '0.07 %, 0.12° at most, over 3 nodes' },
  'DC-Nordheim-Galia': { verdict: '8 nodes solved, in 2 components.', sv: '0.10 %, 7.05° at most, over 4 nodes' },
  Espheim: {
    verdict: '4 nodes solved, in 2 components; 128 nodes in 1 component that did not converge; 44 nodes with no angle reference, not solved.',
    sv: '0.00 %, 0.00° at most, over 3 nodes',
  },
  Galia: { verdict: '12 nodes solved, in 1 component.', sv: '0.09 %, 0.27° at most, over 12 nodes' },
  Nordheim: { verdict: '1 node solved, in 1 component.', sv: '0.00 %, 0.00° at most, over 1 node' },
  Portheim: { verdict: '8 nodes solved, in 1 component.', sv: '0.00 %, 0.00° at most, over 8 nodes' },
  Svedala: { verdict: '118 nodes solved, in 2 components; 119 nodes with no angle reference, not solved.', sv: '0.68 %, 0.14° at most, over 116 nodes' },
};

for (const a of AREAS) {
  test(`PF_UC1 ${a}: solved and set against its SV`, async ({ page }) => {
    await load(page, area(a));
    await solve(page);
    await expect((await at(page, 'pf-verdict'))).toHaveText(PF[a].verdict);
    await expect((await at(page, 'pf-components'))).toContainText(PF[a].sv);
  });
}

// The whole dataset loaded once, the model then chosen from it: Svedala's IGM ticked in alone
// gives what loading it alone gives.
test('the whole instance loaded once, one IGM chosen from it', async ({ page }) => {
  await page.getByLabel('Choose a folder').setInputFiles(ROOT);
  const tree = page.getByTestId('file-tree');
  await expect(tree.getByTestId('included')).toContainText('in the model', { timeout: 200_000 });
  await tree.getByRole('button', { name: 'None' }).click();
  // After the whole instance is validated, which the model's change waits for.
  await expect(tree.getByTestId('included')).toContainText(/^0 of /, { timeout: 200_000 });
  for (const folder of ['Svedala', 'commonData']) await tree.getByLabel(`Folder ${folder} in the model`).check();
  await expect(page.getByTestId('totals')).toContainText(`from ${area('Svedala').length} files`, { timeout: 200_000 });
  await solve(page);
  await expect(page.getByTestId('pf-verdict')).toHaveText(PF.Svedala.verdict);
  await expect(page.getByTestId('pf-components')).toContainText(PF.Svedala.sv);
});

// The same by the headers: the files Svedala made and the common data's, from the presets.
test('one maker and the common data chosen by their presets', async ({ page }) => {
  await page.getByLabel('Choose a folder').setInputFiles(ROOT);
  const tree = page.getByTestId('file-tree');
  await expect(tree.getByTestId('included')).toContainText('in the model', { timeout: 200_000 });
  await tree.getByRole('button', { name: 'None' }).click();
  await expect(tree.getByTestId('included')).toContainText(/^0 of /, { timeout: 200_000 });
  const presets = tree.getByTestId('presets');
  for (const maker of ['Svedala', 'NineRealms']) {
    await presets.getByRole('button', { name: new RegExp(`^${maker} \\d`) }).click();
    await expect(presets.getByRole('button', { name: new RegExp(`^${maker} \\d`) })).toHaveAttribute('aria-pressed', 'true', { timeout: 200_000 });
  }
  await solve(page);
  await expect(page.getByTestId('pf-verdict')).toHaveText(PF.Svedala.verdict);
  await expect(page.getByTestId('pf-components')).toContainText(PF.Svedala.sv);
});

test('PF_UC1 Espheim converges without reactive limits', async ({ page }) => {
  await load(page, area('Espheim'));
  await solve(page, false);
  await expect((await at(page, 'pf-verdict'))).not.toContainText('did not converge');
});

// CO_UC1: the twelve contingencies the docs name, each with its equipment of the class they say
// (check_co); then the first made an N-2 with a second tie-line, as test_edits.py does.
test('CO_UC1: the contingencies name their equipment, and one becomes an N-2', async ({ page }) => {
  await load(page, [...ALL_NC, ...ALL_GRID]);
  const contingencies: [string, string, string][] = [
    ['_7e31c67d-67ba-4592-8ac1-9e806d697c8e', '_d9622e7f-5bf0-4e7e-b766-b8596c6fe4ae', 'ACLineSegment'],
    ['_e9eab3fe-c328-4f78-9bc1-77adb59f6ba7', '_ed0c5d75-4a54-43c8-b782-b20d7431630b', 'ACLineSegment'],
    ['_8cdec4c6-10c3-40c1-9eeb-7f6ae8d9b3fe', '_b85e5fb8-7e2b-4264-a059-edab9a838116', 'ACLineSegment'],
    ['_e05bbe20-9d4a-40da-9777-8424d216785d', '_f1c13f90-6d89-4a37-a51c-94742ad2dd72', 'PowerTransformer'],
    ['_62eac668-82a1-4739-8cfc-de929b78ef7e', '_0489d903-c766-11e1-8775-005056c00008', 'LinearShuntCompensator'],
    ['_ab92defa-ef8e-4d13-a242-5b1a9fe956f6', '_8464a151-ec39-4e7a-8321-06c41e63958c', 'NonlinearShuntCompensator'],
    ['_66627b36-aecd-4141-ab99-4bd8a74d18a8', '_038ce404-30dc-4289-b9db-7076cb870b8e', 'CsConverter'],
    ['_504b48fb-de1f-4f7e-928f-8585daaf7b72', '_be09fc02-de3f-49e4-aa84-94803bcc5d76', 'DCLineSegment'],
    ['_37997e71-cb7d-4a8c-baa6-2a1594956da9', '_550ebe0d-f2b2-48c1-991f-cebea43a21aa', 'SynchronousMachine'],
    ['_f3a8c241-7b5e-4d92-b1c6-8e3f092a4d71', '_ebf0cd8b-a357-4e97-aa67-de5b263733d6', 'ConformLoad'],
    ['_9d17b84c-33b5-4a68-b8b9-ed5b31038d40', '_04566cf8-c766-11e1-8775-005056c00008', 'ACLineSegment'],
    ['_13334fdf-9cc2-4341-adb6-1281269040b4', '_0475dbd8-c766-11e1-8775-005056c00008', 'ACLineSegment'],
  ];
  for (const [contingency, equipment, cls] of contingencies) {
    const details = await show(page, contingency);
    const edit = details.getByTestId('edit');
    if ((await edit.getAttribute('open')) === null) await edit.getByText('Edit', { exact: true }).click();
    await expect(edit.getByTestId('guided-elements').locator(`li[data-id="${equipment}"]`)).toContainText(`(${cls})`);
  }
  const details = await show(page, contingencies[0][0]);
  const edit = details.getByTestId('edit');
  await edit.getByLabel('Equipment to add').fill(contingencies[1][1]);
  await edit.getByRole('button', { name: 'Add to the contingency' }).click();
  // The whole model decoded again: seconds, more while other tests run.
  await expect(edit.getByTestId('guided-elements').locator('li')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId('edited-files')).toContainText('Belgovia_CO.xml', { timeout: 60_000 });
});

/** The Network codes panel on `tab`. */
async function codes(page: Page, tab: RegExp) {
  const panel = (await at(page, 'network-codes'));
  await panel.getByRole('tab', { name: tab }).click();
  return panel;
}

// RA_UC1: one topology action on one switch, closed in the SSH. The docs have it opened; the data's
// range sets it to 0.0, so it stays closed and applying it changes nothing (harness KNOWN).
test('RA_UC1: the action on its switch, which it leaves closed', async ({ page }) => {
  await load(page, area('Svedala'));
  const panel = await codes(page, /^Remedial actions/);
  const row = panel.getByTestId('remedial-actions').getByRole('row', { name: /^Topology RA one Switch/ });
  await expect(row).toContainText('Topology RA one Switch on RT133_RL8-B-S');
  await expect(row).toContainText('Switch.open = 0.0 (absolute)');
  await expect(row.getByTestId('applied')).toContainText('RT133_RL8-B-S stays closed');
  const pf = (await at(page, 'power-flow'));
  await pf.getByLabel('Remedial action applied').selectOption({ label: 'Topology RA one Switch' });
  await solve(page);
  await expect((await at(page, 'pf-applied'))).toContainText('RT133_RL8-B-S closed → closed.');
});

// RA_UC2: two remedial actions excluding one another, each opening four switches. The docs put
// both on the same four; the data's act on four different switches each (harness KNOWN). Applied,
// each moves the grid otherwise.
test('RA_UC2: two exclusive actions, each applied to the grid', async ({ page }) => {
  await load(page, area('Svedala'));
  const panel = await codes(page, /^Remedial actions/);
  const table = panel.getByTestId('remedial-actions');
  const changes: string[] = [];
  for (const [name, other] of [
    ['RA SubstationA_quarterbar1B', 'RA SubstationB_2N'],
    ['RA SubstationB_2N', 'RA SubstationA_quarterbar1B'],
  ]) {
    await view(page, 'Network codes');
    const row = table.getByRole('row', { name: new RegExp(`^${name} `) });
    await expect(row).toContainText(`exclusive in GroupSubstationA with ${other}`);
    await expect(row.getByTestId('applied')).toContainText('closed → open');
    await (await at(page, 'power-flow')).getByLabel('Remedial action applied').selectOption({ label: name });
    await solve(page);
    const applied = (await at(page, 'pf-applied'));
    await expect(applied).toContainText(`With ${name} applied:`);
    expect((await applied.innerText()).match(/closed → open/g)).toHaveLength(4);
    changes.push(await applied.innerText());
  }
  expect(changes[0]).not.toEqual(changes[1]);
});

// RA_UC3: an alteration's enabling schedule (SIS) with time points enabling and disabling it, and
// its state without a schedule (SSI); then disabled from a time of our own.
test('RA_UC3: an alteration enabled and disabled in time, and changed', async ({ page }) => {
  await load(page, area('Espheim'));
  const details = await show(page, '_f5205bd4-637a-4eb7-b0d8-e03638bc570b');
  const edit = details.getByTestId('edit');
  await edit.getByText('Edit', { exact: true }).click();
  const points = edit.getByTestId('guided-points').locator('li');
  await expect(points).toHaveText(['2022-06-15T22:30:00Z: enabled', '2022-06-15T23:30:00Z: disabled', '2022-06-16T00:30:00Z: enabled']);
  await edit.getByLabel('From', { exact: true }).fill('2022-06-16T01:30:00Z');
  await edit.getByLabel('Enabled from then').selectOption('disabled');
  await edit.getByRole('button', { name: 'Set from then' }).click();
  await expect(points).toHaveCount(4, { timeout: 60_000 });
  await expect(points.last()).toHaveText('2022-06-16T01:30:00Z: disabled');
  const alteration = await show(page, '_4d3757fd-b40a-4d7b-be47-6553935234ff');
  await expect(alteration).toContainText('GridStateAlteration.enabled');
});

// RA_UC4: Svedala's answer to the RAO: a response refusing a schedule, and a dependency from its
// proposal to the refused one, which carries no kind (the docs say none; harness KNOWN). Then our
// own counter-proposal, as test_edits.py builds it.
test('RA_UC4: a refused schedule and its counter-proposal', async ({ page }) => {
  await load(page, area('Svedala'));
  const response = await show(page, '_96f93b71-420f-456f-932e-9ac3f724b683');
  await expect(response).toContainText('refused');
  const dependency = await show(page, '_f7231aa5-d497-41f3-a5d5-9d4af74444f0');
  const edit0 = dependency.getByTestId('edit');
  if ((await edit0.getAttribute('open')) === null) await edit0.getByText('Edit', { exact: true }).click();
  // No kind written: it is among the fields to add.
  await expect(edit0.getByLabel('Field to add').locator('option', { hasText: 'RemedialActionScheduleDependency.kind' })).toHaveCount(1);
  // Its proposal, the first schedule it names.
  await dependency.getByRole('button', { name: 'TP RA One Switch' }).first().click();
  await expect((await at(page, 'details'))).toContainText('_51361821-0a40-4e5a-a49d-29c266ea2ecc');
  const refused = await show(page, '_17527637-6099-4ee6-8b21-fea8dfec4c75');
  const edit = refused.getByTestId('edit');
  if ((await edit.getAttribute('open')) === null) await edit.getByText('Edit', { exact: true }).click();
  await edit.getByRole('button', { name: 'Counter-propose' }).click();
  await expect(page.getByTestId('edited-files')).toContainText('counter-proposal', { timeout: 60_000 });
});

// RA_UC5: exclusive actions' schedules on one time axis. Both are active at the same three times
// (harness KNOWN), which the panel marks.
test('RA_UC5: exclusive actions active together are marked', async ({ page }) => {
  await load(page, area('Svedala'));
  const panel = await codes(page, /^Schedules/);
  const clash = panel.getByTestId('exclusive').filter({ hasText: 'more than one is active' });
  await expect(clash).toContainText('3 times more than one is active: 2024-11-20T00:30:00Z, 2024-11-20T01:30:00Z, 2024-11-20T02:30:00Z.');
});

interface Finding {
  object_id: string;
  rule_id: string;
  property: string;
}
const validate = (files: string[]): Finding[] =>
  JSON.parse(execFileSync(CIMCLI, ['validate', '--common', '--quality', '--format', 'json', ...files], { maxBuffer: 1 << 30 }).toString());

// SAR_UC1: the CGM's security analysis, the supplied SAR beside it, and the SAR downloaded, which
// cimoxide validates in the company of the model and the CO files: nothing on a result, nothing
// on the header that the supplied SAR's header does not have.
test('SAR_UC1: the analysis, the supplied SAR beside it, and a SAR cimoxide validates', async ({ page }) => {
  test.setTimeout(600_000);
  const files = [...CGM, ...CO, SUPPLIED_SAR];
  await load(page, files);
  const sa = (await at(page, 'security'));
  await sa.getByRole('button', { name: /^Run \d/ }).click();
  const summary = (await at(page, 'sa-summary'));
  await expect(summary).toBeVisible({ timeout: 500_000 });
  // As gridoxide's tests pin, by capability.
  await expect(summary).toHaveText(
    '325 contingencies: 304 solved, 21 did not converge. 13 violations in the base case, 4,003 violations after contingencies.',
  );
  // The supplied SAR's one violation, on TieLine_SD_BO3 after CO2, is none in this analysis.
  await sa.getByRole('tab', { name: /Supplied SAR/ }).click();
  const supplied = (await at(page, 'sa-supplied'));
  await expect(supplied.locator('tbody tr')).toHaveCount(2);
  await expect(supplied.getByRole('row', { name: /CO2/ })).toContainText('TieLine_SD_BO3');
  await expect(supplied.getByRole('row', { name: /CO2/ })).toContainText('no violation');

  const form = (await at(page, 'sa-download'));
  await form.getByText('Download the SAR').click();
  for (const [label, value] of [
    [/Publisher/, 'https://energy.referencedata.eu/Party/RCC-Jotunheim'],
    [/Version of/, 'https://energy.referencedata.eu/Model/CGM-SAR'],
  ] as const) {
    if (!(await form.getByLabel(label).inputValue())) await form.getByLabel(label).fill(value);
  }
  if (!(await form.getByLabel('Rights holder').inputValue())) await form.getByLabel('Rights holder').fill('RCC Jotunheim');
  if (!(await form.getByLabel('Title').inputValue())) await form.getByLabel('Title').fill('SAR');
  const [download] = await Promise.all([page.waitForEvent('download'), form.getByRole('button', { name: 'Download SAR' }).click()]);
  const ours = join(mkdtempSync(join(tmpdir(), 'gridox-sar-')), 'SAR_gridox.xml');
  cpSync(await download.path(), ours);

  test.skip(!existsSync(CIMCLI), `no cimcli at ${CIMCLI}: set CIMCLI to validate the SAR`);
  const bare = (id: string) => id.replace(/^urn:uuid:/, '').replace(/^#?_?/, '');
  const ids = (path: string) => {
    const text = readFileSync(path, 'utf8');
    const header = bare(/<dcat:Dataset rdf:about="([^"]+)"/.exec(text)![1]);
    const all = new Set([...text.matchAll(/rdf:(?:ID|about)="([^"]+)"/g)].map((m) => bare(m[1])));
    return { header, all };
  };
  const context = [...CGM, ...CO];
  const mine = ids(ours);
  const found = validate([...context, ours]).filter((f) => mine.all.has(bare(f.object_id)));
  // Nothing on a result.
  expect(found.filter((f) => bare(f.object_id) !== mine.header)).toEqual([]);
  // Nothing on the header that the supplied SAR's header does not have.
  const theirs = ids(SUPPLIED_SAR);
  const known = new Set(validate([...context, SUPPLIED_SAR]).filter((f) => bare(f.object_id) === theirs.header).map((f) => f.rule_id));
  expect(found.filter((f) => !known.has(f.rule_id))).toEqual([]);
});

/** The Datasets panel, open. */
async function datasets(page: Page) {
  const panel = (await at(page, 'datasets'));
  await panel.locator('summary').first().click();
  return panel;
}

/** Each object defined more than once: its label, class and files, as the page writes them. */
const twice = async (page: Page) => (await (await at(page, 'twice')).locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());

// BDS_UC1: the boundary merged with every IGM into the CGM. The objects defined by more than one
// dataset are those the harness records (KNOWN): the boundary's containers and one node, again in
// Espheim's, Portheim's and Nordheim's EQ, and one region in Nordheim's EQ and the common data.
test('BDS_UC1: how the IGMs meet at the boundary points', async ({ page }) => {
  await load(page, CGM);
  const table = await at(page, 'boundary-points');
  const row = (name: string) => table.locator('tbody tr').filter({ has: page.getByRole('button', { name, exact: true }) });
  // As the harness records: Portheim's side not in the CGM's topology, the Espheim–Portheim
  // border's lines reached from Espheim only, and the HVDC's from its own IGM only.
  await expect(row('BP Portheim-Espheim')).toContainText('1 topological node, 9 of 11 terminals on none');
  for (const name of ['Madgar1-Lysaborg1', 'Madgar2-Lysaborg2', 'Madgar3-Lysaborg3']) {
    await expect(row(name)).toContainText('reached from Espheim only');
  }
  await expect(row('Madgar4-Leyva1')).toContainText('reached from Espheim-Svedala only');
  await expect(table.locator('tbody tr.amiss')).toHaveCount(5);
  await expect(row('Bouchala-Mastania')).toContainText('Belgovia, Svedala');
});

test('BDS_UC1: what the boundary and the IGMs define twice', async ({ page }) => {
  await load(page, CGM);
  const panel = await datasets(page);
  await expect(panel.getByTestId('datasets-summary')).toContainText('8 objects defined more than once · 0 objects typed with unrelated classes');
  expect((await twice(page)).sort()).toEqual(
    [
      'Portheim-Espheim Voltage Level 400kV VoltageLevel · 20220615T2230Z__Espheim_EQ_1.xml, 20241223T0642Z_2D_Portheim_EQ_1.xml, Boundary_Border-Espheim-Portheim.xml',
      'Substation Portheim-Espheim Substation · 20220615T2230Z__Espheim_EQ_1.xml, 20241223T0642Z_2D_Portheim_EQ_1.xml, Boundary_Border-Espheim-Portheim.xml',
      'Nordheim SubGeographicalRegion · 20220615T2230Z__Nordheim_EQ_1.xml, Boundary_Border-Galia-Nordheim.xml',
      'BP HVDC GA-NH NH side ConnectivityNode · 20220615T2230Z__Nordheim_EQ_1.xml, Boundary_Border-Galia-Nordheim.xml',
      'Nordheim GeographicalRegion · 20220615T2230Z__Nordheim_EQ_1.xml, Grid_CommonData_CGM-CD.xml',
      'HVDV Station Substation · 20220615T2230Z__Nordheim_EQ_1.xml, Boundary_Border-Galia-Nordheim.xml',
      'VL 220 kV VoltageLevel · 20220615T2230Z__Nordheim_EQ_1.xml, Boundary_Border-Galia-Nordheim.xml',
      'Portheim-TSO SubGeographicalRegion · 20220615T2230Z__Espheim_EQ_1.xml, 20241223T0642Z_2D_Portheim_EQ_1.xml, Boundary_Border-Espheim-Portheim.xml',
    ].sort(),
  );
});

// CD_UC1: the classes the report lists, and common data defined once. It is not (harness KNOWN):
// Belgovia_ER.xml defines the common data's SchedulingArea and BiddingZone again, Nordheim's EQ
// its GeographicalRegion.
test('CD_UC1: the common data, and what other datasets define again', async ({ page }) => {
  await load(page, EVERYTHING);
  const classes = (await at(page, 'classes'));
  for (const c of [
    'BiddingZone', 'BiddingZoneBorder', 'CapacityCalculationRegion', 'CoordinatedCapacityCalculator', 'Organisation',
    'TransmissionSystemOperator', 'SecurityCoordinator', 'LoadFrequencyControlArea', 'SynchronousArea', 'SchedulingArea',
    'LoadFrequencyControlBlock', 'TieCorridor',
  ]) {
    await expect(classes.locator('td', { hasText: new RegExp(`^(nc:)?${c}$`) })).toHaveCount(1);
  }
  await datasets(page);
  const found = await twice(page);
  for (const line of [
    'SA-Belgovia SchedulingArea · Org-NineRealms_CD.xml, Belgovia_ER.xml',
    'BZ-Belgovia BiddingZone · Org-NineRealms_CD.xml, Belgovia_ER.xml',
    'Nordheim GeographicalRegion · Grid_CommonData_CGM-CD.xml, 20220615T2230Z__Nordheim_EQ_1.xml',
  ]) {
    expect(found).toContain(line);
  }
});

// RD_UC1: the headers' references to reference data, against the referenceData files. As the
// harness records (KNOWN): every licence, model collection, frame and activity named is missing
// from them, 37 publishers too, while the access rights all resolve. The page counts each file's
// header, the harness each Dataset object once, so the totals differ by up to two.
test('RD_UC1: which header references the reference data defines', async ({ page }) => {
  await load(page, REFERENCE);
  await datasets(page);
  const counts = await (await at(page, 'dataset-files')).evaluate((ul) => {
    const out: Record<string, { missing: number; all: number }> = {};
    for (const dl of ul.querySelectorAll('dl')) {
      const kids = [...dl.children];
      for (let i = 0; i < kids.length; i += 2) {
        const key = kids[i].textContent!.trim();
        const found = (out[key] ??= { missing: 0, all: 0 });
        found.missing += kids[i + 1].querySelectorAll('.missing').length;
        found.all += kids[i + 1].children.length;
      }
    }
    return out;
  });
  expect(counts.publisher.missing).toBe(37);
  expect(counts.accessRights.missing).toBe(0);
  for (const key of ['isVersionOf', 'spatial', 'wasGeneratedBy', 'license']) {
    expect(counts[key].missing, key).toBe(counts[key].all);
  }
});

/** Each file's references to objects no file loaded defines, by file name, from the Datasets panel. */
async function leadingNowhere(page: Page): Promise<Record<string, number>> {
  const panel = await datasets(page);
  const lines = await panel.getByTestId('dataset-files').locator(':scope > li > details > summary').allInnerTexts();
  return Object.fromEntries(
    lines.map((l) => {
      const [name] = l.trim().split(/\s/);
      const n = /([\d,]+) references? to objects not loaded/.exec(l);
      return [name, n ? Number(n[1].replace(/,/g, '')) : 0];
    }),
  );
}

// ER_UC1: the ER dataset's objects, with every association resolving in the area's grid, its
// network codes, the common data and the boundary.
for (const a of ['Belgovia', 'Britheim', 'Espheim', 'Galia', 'Svedala']) {
  test(`ER_UC1 ${a}: every reference of the ER dataset resolves`, async ({ page }) => {
    await load(page, withBoundary(a));
    const found = await leadingNowhere(page);
    expect(found[`${a}_ER.xml`]).toBe(0);
  });
}

// OR_UC1: the object registry's designations and what they name, all resolving.
test('OR_UC1: the designations resolve', async ({ page }) => {
  await load(page, area('Espheim'));
  for (const c of ['Designation', 'DesignationType', 'DesignationAuthority']) {
    await expect((await at(page, 'classes')).locator('td', { hasText: new RegExp(`^(nc:)?${c}$`) })).toHaveCount(1);
  }
  const found = await leadingNowhere(page);
  expect([found['Espheim_OR.xml'], found['Org-NineRealms_CD_OR.xml']]).toEqual([0, 0]);
});

// SIPS: the special protection schemes' objects, resolving.
for (const [a, files, classes] of [
  ['Belgovia', ['Belgovia_RA.xml'], ['RemedialActionScheme', 'Stage', 'StageTrigger', 'Gate', 'PinTerminal']],
  ['Svedala', ['Svedala_RA.xml', 'Svedala_ER.xml'], ['SchemeRemedialAction', 'RemedialActionScheme', 'Stage', 'StageTrigger', 'Gate', 'PinTerminal', 'TriggerCondition']],
] as const) {
  test(`SIPS ${a}: the scheme's objects resolve`, async ({ page }) => {
    await load(page, [...area(a), ...BOUNDARY]);
    for (const c of classes) {
      await expect((await at(page, 'classes')).locator('td', { hasText: new RegExp(`^(nc:)?${c}$`) }), c).toHaveCount(1);
    }
    const found = await leadingNowhere(page);
    for (const f of files) expect(found[f], f).toBe(0);
  });
}

/** The cells of the assessed elements table's row for `name` (the first such row matching `also`). */
async function assessed(page: Page, name: string, also?: string) {
  const panel = await codes(page, /^Assessed elements/);
  let row = panel.getByTestId('assessed-elements').getByRole('row', { name: new RegExp(`^${name} `) });
  if (also) row = row.filter({ hasText: also });
  await expect(row).toHaveCount(1);
  return {
    row,
    cell: async (column: string) => {
      // The text as written: headers are upper case only in their style.
      const headers = await panel.getByTestId('assessed-elements').locator('thead th').allTextContents();
      return (await row.locator('td').nth(headers.findIndex((h) => h.trim() === column)).innerText()).replace(/\s+/g, ' ').trim();
    },
  };
}

// AE_UC1: a secured element in the base case.
test('AE_UC1: an assessed element secured in the base case', async ({ page }) => {
  await load(page, area('Belgovia'));
  const ae1 = await assessed(page, 'AE1');
  expect(await ae1.cell('In base case')).toBe('true');
  expect(await ae1.cell('Secured for')).toBe('CCR-NineRealms');
});

// AE_UC2 and AE_UC4: one excluded from the base case, scanned and secured, with its reason; one
// scanned only.
test('AE_UC2, AE_UC4: excluded, scanned and secured, or scanned only', async ({ page }) => {
  await load(page, area('Belgovia'));
  const ae3 = await assessed(page, 'AE3');
  expect(await ae3.cell('In base case')).toBe('false');
  expect(await ae3.cell('Secured for')).toBe('CCR-NineRealms');
  expect(await ae3.cell('Scanned for')).toBe('CCR-NineRealms');
  expect(await ae3.cell('Exclusion reason')).toBe('nonNativeCapacityCalculationRegion');
  const ae2 = await show(page, '_d463cbba-c89c-4199-bbb9-1a33d90cae2c');
  await expect(ae2).toContainText('AssessedElement.ScannedForRegion');
  await expect(ae2.locator('dl, table').first()).not.toContainText('AssessedElement.SecuredForRegion');
});

// AE_UC3: an assessed element's schedule disabling it from a time.
test('AE_UC3: an assessed element disabled in time', async ({ page }) => {
  await load(page, area('Belgovia'));
  const ae1 = await assessed(page, 'AE1');
  expect(await ae1.cell('Schedules')).toBe('Schedule-AE1');
  const schedule = await show(page, '_7221ae31-f736-4ae2-8ce1-f3dd605cefd6');
  const edit = schedule.getByTestId('edit');
  if ((await edit.getAttribute('open')) === null) await edit.getByText('Edit', { exact: true }).click();
  await expect(edit.getByTestId('guided-points').locator('li')).toHaveText(['2023-07-22T16:00:00Z: disabled']);
});

// AE_UC5: combinations with contingencies: one combinable in the base case, one excluded with its
// contingency, one included and not combinable otherwise. Over every area's network codes names
// repeat, so each is read by its mRID.
test('AE_UC5: assessed elements combined with contingencies', async ({ page }) => {
  await load(page, [...ALL_NC, ...COMMON]);
  const field = (key: string, value: string) => new RegExp(`${key.replace('.', '\\.')}\\s+${value}`);
  const full = await show(page, '_d17943b5-9d10-4f8b-bb07-18c3a3822348');
  await expect(full).toContainText(field('AssessedElement.inBaseCase', 'true'));
  await expect(full).toContainText(field('AssessedElement.isCombinableWithContingency', 'true'));
  const co3 = await show(page, '_663c6c3c-1777-4eb7-98b0-c23233ce0f71');
  await expect(co3).toContainText(field('AssessedElement.isCombinableWithContingency', 'false'));
  for (const [link, kind] of [
    ['_1f38d403-a822-4c24-93c0-0f18ac699ef1', 'excluded'],
    ['_deb4c65f-c3fc-414e-baa3-692829e3eec2', 'included'],
  ]) {
    const details = await show(page, link);
    await expect(details).toContainText(field('AssessedElementWithContingency.combinationConstraintKind', `(ElementCombinationConstraintKind\\.)?${kind}`));
    await expect(details.locator('.missing')).toHaveCount(0);
  }
});

// AE_UC6: an assessed element combined with a remedial action.
test('AE_UC6: an assessed element combined with a remedial action', async ({ page }) => {
  await load(page, area('Belgovia'));
  const ae4 = await assessed(page, 'AE4', 'TapRA2');
  expect(await ae4.cell('Remedial actions')).toBe('TapRA2 included');
  const link = await show(page, '_66f786ce-5e2a-427d-9eb8-4e1462045c27');
  await expect(link).toContainText('TapRA2');
});

/** The schedules table's rows naming `text`. */
async function schedules(page: Page, text: string) {
  const panel = await codes(page, /^Schedules/);
  return panel.getByTestId('schedules').locator('tbody tr').filter({ hasText: text });
}

// RA_UC6: a countertrade action with its power schedule on a generating unit and its bids, each
// with time points.
test('RA_UC6: a countertrade with its power schedule and bids', async ({ page }) => {
  await load(page, area('Belgovia'));
  const power = (await schedules(page, 'Gen-1229753060')).filter({ hasText: 'RA18' });
  await expect(power).toHaveCount(1);
  await expect(power).toContainText('PowerSchedule');
  await expect(power).toContainText('2024-02-22T14:30:00Z');
  const bids = (await schedules(page, 'PBS1')).filter({ hasText: 'RA18' });
  await expect(bids).toHaveCount(1);
  await expect(bids).toContainText('PowerBidSchedule');
});

// RA_UC7: redispatch in two variants. Variant 1's bids lead to the shift key distribution;
// variant 2 is linked to no shift key object, as the harness records (KNOWN).
test('RA_UC7: redispatch, and the variant its shift keys miss', async ({ page }) => {
  await load(page, area('Belgovia'));
  const rows = await schedules(page, 'RD RA1');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('PSKD1');
  const variant1 = await show(page, '_fa73cfee-ff54-43cd-816b-51394cd76f0f');
  await expect(variant1).toContainText('PBS1');
  const variant2 = await show(page, '_9d72d12a-f135-437a-83fa-ef3e5b23f41f');
  await expect(variant2).not.toContainText('PBS1');
  await expect(variant2).not.toContainText('PSKD1');
});

// AS_UC1: an availability action's schedule, cancelled. It has no AvailabilityTimePoint, so the
// window it cancels is only in its description (harness KNOWN).
test('AS_UC1: a cancelled availability schedule, with no window', async ({ page }) => {
  await load(page, area('Svedala'));
  const schedule = await show(page, '_d394295f-9d18-4d9f-9808-bd23282bf60f');
  await expect(schedule).toContainText('AvailabilitySchedule.cancelledDateTime');
  await expect(schedule).toContainText('ARA1');
  await expect(schedule).not.toContainText('AvailabilityTimePoint');
});
