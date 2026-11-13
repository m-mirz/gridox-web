import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { zip } from './zipfile';
import { at, validated, view } from './views';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);
const EQ = fixture('small_EQ.xml');
const SSH = fixture('small_SSH.xml');
const GRID = fixture('grid_EQ.xml');
const SECOND = fixture('second_EQ.xml');
const NC = fixture('nc_CO_AE.xml');
const RA = fixture('nc_RA.xml');
const RAS = fixture('nc_RAS.xml');
const STATE = fixture('grid_state.xml');
const SV = fixture('grid_SV.xml');
const MORE = fixture('nc_CO_more.xml');
const SCHEDULE = fixture('nc_RA_schedule.xml');
const CURATIVE = fixture('nc_RA_curative.xml');
const input = (page: Page) => page.getByLabel('Choose files');
const folderInput = (page: Page) => page.getByLabel('Choose a folder');

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('loads a file and shows its classes', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
  const row = (await at(page, 'classes')).getByRole('row', { name: 'ACLineSegment' });
  await expect(row).toContainText('2');
});

test('merges the files of one model by object', async ({ page }) => {
  await input(page).setInputFiles([EQ, SSH]);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 2 files');
});

test('says which files it could not use, and keeps the rest', async ({ page }) => {
  await input(page).setInputFiles([
    { name: 'small_EQ.xml', mimeType: 'text/xml', buffer: readFileSync(EQ) },
    { name: 'notes.xml', mimeType: 'text/xml', buffer: Buffer.from('<not-a-model/>') },
  ]);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
  await expect(page.getByTestId('skipped')).toContainText('notes.xml');
});

test('takes dropped files', async ({ page }) => {
  const text = 'xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';
  const transfer = await page.evaluateHandle((attributes) => {
    const data = new DataTransfer();
    const xml = `<rdf:RDF ${attributes}><cim:BaseVoltage rdf:ID="_a"/></rdf:RDF>`;
    data.items.add(new File([xml], 'dropped.xml', { type: 'text/xml' }));
    return data;
  }, text);
  await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('totals')).toContainText('1 objects from 1 file');
});

test.describe('real drags', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'only Chromium lets a test drag from outside the page');

  /** Drags as the browser does, through `dragover`, which decides whether a drop is taken at all. */
  async function drag(page: Page, data: object, x: number, y: number) {
    const cdp = await page.context().newCDPSession(page);
    const payload = { items: [], files: [], dragOperationsMask: 1, ...data };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x, y, data: payload } as never);
    }
  }

  test('anywhere on the page', async ({ page }) => {
    await drag(page, { files: [EQ, SSH] }, 600, 600);
    await expect(page.getByTestId('totals')).toContainText('4 objects from 2 files');
  });

  test('onto the grid, adding to a model', async ({ page }) => {
    await input(page).setInputFiles(GRID);
    // Once validation's panels are in, which move the grid down, and with the grid in view.
    await expect((await at(page, 'datasets-summary'))).toBeVisible();
    await (await at(page, 'graph')).scrollIntoViewIfNeeded();
    const graph = await (await at(page, 'graph')).boundingBox();
    await drag(page, { files: [EQ] }, graph!.x + 50, graph!.y + 50);
    await expect(page.getByTestId('totals')).toContainText('from 2 files');
  });

  test('a folder, its XML in its subfolders too', async ({ page }) => {
    const folder = mkdtempSync(join(tmpdir(), 'gridox-'));
    mkdirSync(join(folder, 'Grid'));
    cpSync(EQ, join(folder, 'small_EQ.xml'));
    cpSync(SSH, join(folder, 'Grid', 'small_SSH.xml'));
    writeFileSync(join(folder, 'README.adoc'), 'not a model');
    await drag(page, { files: [folder] }, 600, 600);
    await expect(page.getByTestId('totals')).toContainText('4 objects from 2 files');
    await expect(page.getByTestId('skipped')).toBeHidden();
    await expect(page.getByTestId('error')).toBeHidden();
  });

  test('says so when a folder has no XML', async ({ page }) => {
    const folder = mkdtempSync(join(tmpdir(), 'gridox-'));
    writeFileSync(join(folder, 'README.adoc'), 'not a model');
    await drag(page, { files: [folder] }, 600, 600);
    await expect(page.getByTestId('notice')).toContainText('no XML files in that folder');
  });

  test('says so when what was dragged is not files', async ({ page }) => {
    await drag(page, { items: [{ mimeType: 'text/uri-list', data: 'file:///home/someone/a.xml' }] }, 600, 600);
    await expect(page.getByTestId('notice')).toContainText('No files came through');
    await expect(page.getByTestId('totals')).toBeHidden();
  });

  test('shows where a drag will land, until it leaves', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [EQ], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 600, y: 600, data } as never);
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: 600, y: 600, data } as never);
    await expect(page.getByTestId('drop-overlay')).toBeVisible();
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: 600, y: 600, data } as never);
    await expect(page.getByTestId('drop-overlay')).toBeHidden();
  });
});

test('a drop elsewhere on the page reads the files', async ({ page }) => {
  const transfer = await page.evaluateHandle((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], 'small_EQ.xml', { type: 'text/xml' }));
    return data;
  }, readFileSync(EQ, 'utf8'));
  await page.locator('header').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
});

test('offers a folder to save edits in place only where the browser can write to one', async ({ page, browserName }) => {
  const button = page.getByRole('button', { name: 'Open a folder to save edits in place' });
  if (browserName === 'chromium') await expect(button).toBeVisible();
  else await expect(button).toBeHidden();
  // The folder input reads a folder everywhere.
  await expect(page.getByLabel('Choose a folder')).toBeAttached();
});

test('says so when a drop holds nothing', async ({ page }) => {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator('header').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('notice')).toContainText('No files came through');
});

test('clears the model', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
  await expect(page.getByTestId('totals')).toBeHidden();
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
});

test('works offline after the first visit', async ({ page, context }) => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
});

test('asks nothing of any other site, and breaks none of its own rules', async ({ context }) => {
  // A page of its own, watched from before it loads.
  const page = await context.newPage();
  const elsewhere: string[] = [];
  const problems: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.host !== 'localhost:4173') elsewhere.push(request.url());
  });
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto('./');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
  expect(elsewhere).toEqual([]);
  expect(problems).toEqual([]);
});

test('the policy against other sites is in the page', async ({ page }) => {
  const policy = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(policy).toHaveAttribute('content', /default-src 'self'/);
});

test('says what software it carries, under which licences, and links to it', async ({ page }) => {
  const link = page.getByTestId('about').getByRole('link', { name: 'licences' });
  await expect(link).toHaveAttribute('href', './third-party-licenses.txt');
  const response = await page.request.get('third-party-licenses.txt');
  expect(response.ok()).toBe(true);
  const text = await response.text();
  // The LGPL code first, with where its source is, how to relink, and the licence.
  const lgpl = text.indexOf('1. Code under the GNU Lesser General Public License');
  expect(lgpl).toBeGreaterThan(0);
  expect(text).toMatch(/gridoxide-sparse \S+ \(licence: [^)]*LGPL-2\.1-or-later\)/);
  expect(text).toContain('SuiteSparse KLU');
  expect(text).toContain('[patch.crates-io]');
  expect(text).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
  expect(text).toContain('Version 2.1, February 1999');
  // Every library, each with its text.
  for (const name of ['cytoscape', 'svelte', 'workbox-core', 'faer', 'serde_json', 'quick-xml', 'cimoxide-model']) {
    expect(text, name).toContain(`--- ${name} `);
  }
  expect(text).not.toContain('carries no licence file; its licence is the one named above');
});

/** Whether anything has been painted on the graph's canvases. */
const painted = (page: Page) =>
  page.getByTestId('graph').evaluate((graph) =>
    [...graph.querySelectorAll('canvas')].some((canvas) => {
      const { width, height } = canvas;
      if (!width || !height) return false;
      const pixels = canvas.getContext('2d')?.getImageData(0, 0, width, height).data ?? [];
      return pixels.some((value, i) => i % 4 === 3 && value > 0);
    }),
  );

test.describe('browsing', () => {
  const tree = (page: Page) => page.getByTestId('tree');
  const details = (page: Page) => page.getByTestId('details');
  const summary = (page: Page) => page.getByTestId('grid-summary');

  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles(GRID);
    await expect(summary(page)).toContainText('2 substations, 0 boundary points, 1 connection');
  });

  test('draws the grid', async ({ page }) => {
    await expect.poll(() => painted(page)).toBe(true);
  });

  test('walks the tree a level at a time, and shows an object as written', async ({ page }) => {
    await page.getByRole('button', { name: 'Expand Geographical' }).click();
    await page.getByRole('button', { name: 'Expand South' }).click();
    await page.getByRole('button', { name: 'Expand Anvil', exact: true }).click();
    await page.getByRole('button', { name: 'Expand Anvil 110' }).click();
    await tree(page).getByRole('button', { name: /^Breaker A/ }).click();
    await expect(details(page).getByRole('heading', { name: 'Breaker A' })).toBeVisible();
    await expect((await at(page, 'fields'))).toContainText('Switch.normalOpen');
    await expect((await at(page, 'fields'))).toContainText('false');
  });

  test('an object picked in the tree is shown inside its substation', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('breaker a');
    await (await at(page, 'hits')).getByRole('button', { name: /Breaker A/ }).click();
    await expect(summary(page)).toContainText('Anvil: 2 equipment, 2 nodes, 1 switch');
    await expect(details(page)).toContainText('Breaker · Anvil 110 · closed');
    await expect(tree(page).locator('[aria-current="true"]')).toContainText('Breaker A');
    await expect.poll(() => painted(page)).toBe(true);
    await page.getByRole('button', { name: '← Grid' }).click();
    await expect(summary(page)).toContainText('2 substations, 0 boundary points, 1 connection');
  });

  test('goes inside a substation from its details', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('birch');
    await (await at(page, 'hits')).getByRole('button', { name: /^Birch Substation/ }).click();
    await details(page).getByRole('button', { name: 'Show inside' }).click();
    await expect(summary(page)).toContainText('Birch: 2 equipment');
    await page.keyboard.press('Escape');
    await expect(summary(page)).toContainText('2 substations');
  });

  test('follows a reference to what it names', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('breaker a');
    await (await at(page, 'hits')).getByRole('button', { name: /Breaker A/ }).click();
    await (await at(page, 'fields')).getByRole('button', { name: 'Anvil 110' }).click();
    await expect(details(page).getByRole('heading', { name: 'Anvil 110' })).toBeVisible();
    await expect(tree(page).locator('[aria-current="true"]')).toContainText('Anvil 110');
  });

  test('an object says what refers to it, and Back returns', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('anvil 110');
    await (await at(page, 'hits')).getByRole('button', { name: /Anvil 110/ }).click();
    const referrers = (await at(page, 'referrers'));
    await expect(details(page).getByRole('heading', { name: 'Referred to by 3' })).toBeVisible();
    await expect(referrers).toContainText('Equipment.EquipmentContainer');
    await referrers.getByRole('button', { name: 'Breaker A' }).click();
    await expect(details(page).getByRole('heading', { name: 'Breaker A' })).toBeVisible();
    await details(page).getByRole('button', { name: '← Back' }).click();
    await expect(details(page).getByRole('heading', { name: 'Anvil 110' })).toBeVisible();
  });

  test('a field can say what the vocabulary says of it', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('breaker a');
    await (await at(page, 'hits')).getByRole('button', { name: /Breaker A/ }).click();
    const fields = (await at(page, 'fields'));
    await expect(fields).toContainText('Switch.normalOpen');
    const before = (await fields.textContent())!.length;
    await details(page).getByLabel('Descriptions').check();
    await expect.poll(async () => (await fields.textContent())!.length).toBeGreaterThan(before);
  });

  test('a page wide as a phone does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
  });
});

test('breaks none of the page\'s rules while drawing', async ({ browser, baseURL }) => {
  // A context of its own, watched from before it loads, with nothing kept from another test.
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto('./');
  await input(page).setInputFiles(GRID);
  await expect.poll(() => painted(page).catch(() => false)).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
});

test.describe('validation', () => {
  const findings = (page: Page) => page.getByTestId('findings-summary');

  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles(GRID);
    await validated(page);
    await view(page, 'Validation');
    await expect(findings(page)).toContainText(/violation|warning|info/);
  });

  test('runs after loading, and lists each broken rule with its findings', async ({ page }) => {
    await expect(findings(page)).toContainText('in 1 file');
    await page.getByText(/rules? broken/).click();
    const rule = (await at(page, 'findings')).locator('.rules > li').first();
    await rule.locator('summary').click();
    await expect(rule.getByTestId('found').locator('li').first()).toBeVisible();
  });

  test('a finding leads to its object, which lists it', async ({ page }) => {
    await page.getByText(/rules? broken/).click();
    const rule = (await at(page, 'findings')).locator('.rules > li').first();
    await rule.locator('summary').click();
    const first = rule.getByTestId('found').getByRole('button').first();
    const name = (await first.textContent())!.trim();
    await first.click();
    await expect((await at(page, 'details')).getByRole('heading', { name, exact: true })).toBeVisible();
    await expect((await at(page, 'object-findings'))).toBeVisible();
  });

  test('the tree counts findings and can show only what holds them', async ({ page }) => {
    const tree = (await at(page, 'tree'));
    await expect(tree.locator('.badge').first()).toBeVisible();
    await tree.getByLabel('With findings only').check();
    await expect(tree.locator('.row').first()).toBeVisible();
    const sections = await tree.locator('.row').count();
    await expect(tree.locator('.row .badge')).toHaveCount(sections);
  });

  test('the findings are the tree’s to show, not the grid’s', async ({ page }) => {
    await view(page, 'Explore');
    await expect(page.getByTestId('grid-summary')).toContainText('substation');
    await expect(page.getByTestId('grid-summary')).not.toContainText(/violation|warning|info/);
    await expect(page.getByTestId('tree').locator('.badge').first()).toBeVisible();
  });

  test('more checks find more, and are remembered', async ({ page }) => {
    const before = await findings(page).textContent();
    await page.getByLabel('Common cross-profile checks').check();
    await page.getByLabel('Modelling-quality checks').check();
    await expect(findings(page)).not.toHaveText(before!);
    await page.reload();
    // Where the files were not kept (WebKit in a test), the checks show again once there is a model.
    await input(page).setInputFiles(GRID);
    await expect(page.getByLabel('Modelling-quality checks')).toBeChecked();
    await expect(page.getByLabel('Common cross-profile checks')).toBeChecked();
  });
});

test.describe('datasets', () => {
  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles([GRID, SECOND]);
    await expect((await at(page, 'datasets-summary'))).toBeVisible();
  });

  test('say what is defined twice and which header references are not loaded', async ({ page }) => {
    const summary = (await at(page, 'datasets-summary'));
    await expect(summary).toContainText('2 files');
    await expect(summary).toContainText('1 object defined more than once');
    await expect(summary).toContainText('1 header reference not loaded');
    await summary.click();
    await (await at(page, 'twice')).getByRole('button', { name: 'Breaker A' }).click();
    await expect((await at(page, 'defined-in'))).toContainText('Defined by 2 files: grid_EQ.xml, second_EQ.xml');
  });

  test('a header shows where its references lead', async ({ page }) => {
    await (await at(page, 'datasets-summary')).click();
    const files = (await at(page, 'dataset-files'));
    await files.getByText('second_EQ.xml').click();
    await expect(files.locator('.missing')).toHaveText('urn:uuid:not-loaded not loaded');
    await files.getByRole('button', { name: 'urn:uuid:00000000-0000-4000-8000-000000000f01' }).click();
    await expect((await at(page, 'details')).getByRole('heading', { name: 'urn:uuid:00000000-0000-4000-8000-000000000f01' })).toBeVisible();
    await expect((await at(page, 'referrers'))).toContainText('Model.DependentOn');
  });

  test('reference data has a page of its own', async ({ page }) => {
    await (await at(page, 'tree')).getByRole('searchbox').fill('breaker a');
    await (await at(page, 'hits')).getByRole('button', { name: /Breaker A/ }).click();
    await (await at(page, 'fields')).getByRole('button', { name: 'A concept' }).click();
    const details = (await at(page, 'details'));
    await expect(details).toContainText('Reference data, outside the CIM class tables.');
    await expect((await at(page, 'referrers'))).toContainText('Switch.concept');
  });
});

test.describe('network codes', () => {
  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles([GRID, NC]);
    await expect((await at(page, 'network-codes'))).toBeVisible();
  });

  test('a contingency shows its equipment, and where the grid has it', async ({ page }) => {
    const row = (await at(page, 'contingencies')).getByRole('row', { name: /Loss of Anvil-Birch/ });
    await expect(row).toContainText('Anvil-Birch');
    await expect(row).toContainText('outOfService');
    await expect(row).toContainText('Flow on Anvil-Birch');
    await expect(row).toContainText('excluded');
    await row.getByRole('button', { name: 'Show on grid' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear highlight' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeHidden();
  });

  test('assessed elements say how they are assessed', async ({ page }) => {
    await page.getByRole('tab', { name: /Assessed elements/ }).click();
    const table = (await at(page, 'assessed-elements'));
    const scanned = table.getByRole('row', { name: /Breaker A scanned/ });
    await expect(scanned).toContainText('nonNativeCapacityCalculationRegion');
    await expect(scanned).toContainText('_region');
    await scanned.getByRole('button', { name: 'Show on grid' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeVisible();
  });

  test('a table leads to an object\'s page', async ({ page }) => {
    await (await at(page, 'contingencies')).getByRole('button', { name: 'Loss of Anvil-Birch' }).click();
    await expect((await at(page, 'details')).getByRole('heading', { name: 'Loss of Anvil-Birch' })).toBeVisible();
    await expect((await at(page, 'referrers'))).toContainText('ContingencyElement.Contingency');
  });

  test('a remedial action says what it changes, and what applying it gives', async ({ page }) => {
    await input(page).setInputFiles(RA);
    await view(page, 'Network codes');
    await page.getByRole('tab', { name: /Remedial actions [1-9]/ }).click();
    const table = (await at(page, 'remedial-actions'));
    const open = table.getByRole('row', { name: /^Open Breaker A/ });
    await expect(open).toContainText('Switch.open = 1.0 (absolute)');
    await expect(open).toContainText('exclusive');
    await expect(open).toContainText('Keep Breaker A closed');
    await expect(open.getByTestId('applied')).toContainText('closed → open');
    await expect(table.getByRole('row', { name: /^Keep Breaker A closed/ }).getByTestId('applied')).toContainText('stays closed');
    await open.getByRole('button', { name: 'Show on grid' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeVisible();
  });

  test('schedules are drawn on one time axis, and exclusive actions active together are marked', async ({ page }) => {
    await input(page).setInputFiles([RA, RAS]);
    // Once the tables have the files' schedules.
    await page.getByRole('tab', { name: /Schedules [1-9]/ }).click();
    const exclusive = (await at(page, 'exclusive'));
    await expect(exclusive).toContainText('Breaker A either way');
    await expect(exclusive).toContainText('one time more than one is active: 2024-11-20T12:00:00Z');
    // Both actions' event schedules are on the timeline, with the overlap marked.
    const timeline = (await at(page, 'timeline'));
    await expect(timeline.getByRole('button', { name: 'Open A, when' })).toBeVisible();
    await expect(timeline.getByRole('button', { name: 'Keep A closed, when' })).toBeVisible();
    await expect(timeline).toContainText('2024-11-20T12:00:00+01:00 isActive true');
    await expect(timeline).toContainText('exclusive actions active together');
    // A time point leads to its page.
    await timeline.getByRole('button', { name: '2024-11-20 10:00 UTC: isActive true' }).click();
    await expect((await at(page, 'details')).getByRole('heading', { name: '_00000000-0000-4000-8000-000000000504' })).toBeVisible();
  });

  test('a cancelled schedule says when, and that it has no time points', async ({ page }) => {
    await input(page).setInputFiles([RA, RAS]);
    // Once the tables have the files' schedules.
    await page.getByRole('tab', { name: /Schedules [1-9]/ }).click();
    const row = (await at(page, 'schedules')).getByRole('row', { name: /Maintenance of Breaker A/ });
    await expect(row).toContainText('cancelledDateTime = 2024-11-19T08:34:00Z');
    await expect(row).toContainText('none');
    await row.getByRole('checkbox').check();
    await expect((await at(page, 'timeline'))).toContainText('cancelledDateTime 2024-11-19T08:34:00Z');
    const key = (await at(page, 'schedules')).getByRole('row', { name: /Shift key 1/ });
    await expect(key).toContainText('Distribution 1');
    await page.setViewportSize({ width: 375, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test('filters by name', async ({ page }) => {
    await page.getByLabel('Filter the table').fill('nothing like it');
    await expect((await at(page, 'contingencies')).getByRole('row')).toHaveCount(1);
  });
});

test.describe('power flow', () => {
  test('solves, says what it solved, and how far from the SV', async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV]);
    const pf = (await at(page, 'power-flow'));
    await pf.getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-verdict'))).toHaveText('2 nodes solved, in 1 component.');
    await expect((await at(page, 'pf-options'))).toContainText('the imbalance taken by the angle reference, reactive limits held');
    await expect((await at(page, 'pf-components'))).toContainText('Anvil 110');
    await expect((await at(page, 'pf-components'))).toContainText(/10\.5\d %, 0\.27° at most, over 2 nodes/);
    await expect((await at(page, 'pf-violations')).getByRole('row', { name: /Anvil-Birch/ })).toContainText('133.1 %');
    // Furthest from the SV first.
    await expect((await at(page, 'pf-nodes')).getByRole('row').nth(1)).toContainText('Birch 110');
    await expect((await at(page, 'pf-nodes')).getByRole('row').nth(1)).toContainText(/110\.5\d/);
  });

  test('colours the grid by it, and can go back to voltage levels', async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV]);
    await (await at(page, 'power-flow')).getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'flow-legend'))).toBeVisible();
    await page.getByLabel('Colour by').selectOption('voltage');
    await expect((await at(page, 'flow-legend'))).toBeHidden();
    await (await at(page, 'pf-nodes')).getByRole('row', { name: /Birch 110/ }).getByRole('button', { name: 'Show on grid' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeVisible();
  });

  test('the options chosen are the ones it says it used', async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV]);
    const pf = (await at(page, 'power-flow'));
    await pf.getByLabel('Imbalance taken by').selectOption('capability');
    await pf.getByLabel('Hold reactive limits').uncheck();
    await pf.getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-options'))).toContainText('taken by the machines, by capability');
    await expect((await at(page, 'pf-options'))).toContainText('reactive limits not held');
  });

  test('from the switches, it solves as from the TP', async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV]);
    const pf = (await at(page, 'power-flow'));
    await pf.getByLabel('Buses from').selectOption({ label: 'the switches' });
    await pf.getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-verdict'))).toHaveText('2 nodes solved, in 1 component.');
    await expect((await at(page, 'pf-options'))).toContainText('the buses from the switches');
  });

  test('a remedial action applied opens its switch, and says what that changed', async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV, RA]);
    const pf = (await at(page, 'power-flow'));
    await pf.getByLabel('Remedial action applied').selectOption({ label: 'Open Breaker A' });
    await expect(pf.getByLabel('Buses from')).toBeDisabled();
    await pf.getByRole('button', { name: 'Solve' }).click();
    const applied = (await at(page, 'pf-applied'));
    await expect(applied).toContainText('With Open Breaker A applied: Breaker A closed → open.');
    await expect(applied).toContainText('1 node solved, 2 without it.');
    await expect(applied).toContainText('Currents past their limits: 0, 1 without it.');
    // The files are as they were: no file is edited.
    await expect(page.getByTestId('edited-files')).toBeHidden();
    await pf.getByLabel('Remedial action applied').selectOption({ label: 'Keep Breaker A closed' });
    await pf.getByRole('button', { name: 'Solve again' }).click();
    await expect(applied).toContainText('No voltage changes');
  });

  test('an action takes its value from an intensity schedule at the scenario time', async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV, RA, SCHEDULE]);
    await view(page, 'Network codes');
    await page.getByRole('tab', { name: /Remedial actions [1-9]/ }).click();
    const row = (await at(page, 'remedial-actions')).getByRole('row', { name: /^Keep Breaker A closed/ });
    await expect(row.getByTestId('applied')).toContainText('closed → open');
    const pf = (await at(page, 'power-flow'));
    await pf.getByLabel('Remedial action applied').selectOption({ label: 'Keep Breaker A closed' });
    await pf.getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-applied'))).toContainText('Breaker A closed → open.');
  });

  test('says why nothing was solved, and a new file takes the result away', async ({ page }) => {
    await input(page).setInputFiles(GRID);
    const pf = (await at(page, 'power-flow'));
    await pf.getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-error'))).toContainText('Nothing was solved');
    await input(page).setInputFiles([STATE, SV]);
    await expect((await at(page, 'pf-error'))).toBeHidden();
    await pf.getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-verdict'))).toBeVisible();
  });
});

test.describe('security analysis', () => {
  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV, NC, MORE]);
    await expect((await at(page, 'security'))).toBeVisible();
  });

  test('runs every contingency, and says what each gave', async ({ page }) => {
    const sa = (await at(page, 'security'));
    await sa.getByRole('button', { name: 'Run 4 contingencies' }).click();
    await expect((await at(page, 'sa-summary'))).toContainText('4 contingencies: 3 solved, 1 name equipment the model lacks.');
    await expect((await at(page, 'sa-summary'))).toContainText('1 violation in the base case, 1 violation after contingencies.');
    await expect((await at(page, 'sa-options'))).toContainText('the imbalance taken by the machines, by capability, reactive limits not held');
    await expect(sa).toContainText('Naming equipment the model lacks, so not run: Loss of Unit X');
    const nothing = (await at(page, 'sa-contingencies')).getByRole('row', { name: /Nothing lost/ });
    await expect(nothing).toContainText('133.1 %');
    await nothing.getByRole('button', { name: 'Violations' }).click();
    await expect((await at(page, 'sa-contingencies'))).toContainText('266 A on Anvil-Birch PATL (PATL, 200 A), 133.1 %');
    await (await at(page, 'sa-contingencies')).getByRole('row', { name: /Loss of Anvil-Birch/ }).getByRole('button', { name: 'Show on grid' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeVisible();
  });

  test('lists the elements past a limit, and their violations', async ({ page }) => {
    const sa = (await at(page, 'security'));
    await sa.getByRole('button', { name: /^Run/ }).click();
    await sa.getByRole('tab', { name: /By element/ }).click();
    const line = (await at(page, 'sa-elements')).getByRole('row', { name: /Anvil-Birch/ });
    await expect(line).toContainText('Nothing lost');
    await line.getByRole('button', { name: 'Violations' }).click();
    await expect((await at(page, 'sa-elements'))).toContainText('base case');
    await expect((await at(page, 'sa-elements'))).toContainText('after Nothing lost');
  });

  test('downloads a SAR once its header is given, and reads one back beside its own', async ({ page }) => {
    const sa = (await at(page, 'security'));
    await sa.getByRole('button', { name: /^Run/ }).click();
    const form = (await at(page, 'sa-download'));
    await form.getByText('Download the SAR').click();
    await expect(form.getByLabel(/Publisher/)).toHaveValue('https://energy.referencedata.eu/test/party/South');
    await expect(form.getByRole('button', { name: 'Download SAR' })).toBeDisabled();
    await form.getByLabel(/Version of/).fill('https://energy.referencedata.eu/Test/Model/South-SAR');
    const [download] = await Promise.all([page.waitForEvent('download'), form.getByRole('button', { name: 'Download SAR' }).click()]);
    expect(download.suggestedFilename()).toBe('20260101_SAR.xml');
    const path = await download.path();
    expect(readFileSync(path, 'utf8')).toContain('SecurityAnalysisResult');
    // The SAR, loaded with its model: its results, and the analysis's own beside them.
    const copy = join(mkdtempSync(join(tmpdir(), 'gridox-')), 'sar.xml');
    cpSync(path, copy);
    await input(page).setInputFiles(copy);
    await sa.getByRole('tab', { name: /Supplied SAR/ }).click();
    await expect((await at(page, 'sa-supplied'))).toContainText('Anvil-Birch');
    await expect((await at(page, 'sa-supplied'))).toContainText('not run');
  });

  test('is shared with other workers when there are many contingencies, and gives the same', async ({ page }) => {
    // 45 more contingencies losing nothing, each keeping the base case's overload.
    const many = Array.from({ length: 45 }, (_, i) => {
      const id = `_00000000-0000-4000-8000-0000000071${i.toString().padStart(2, '0')}`;
      return `<nc:OrdinaryContingency rdf:ID="${id}"><cim:IdentifiedObject.name>Nothing lost ${i}</cim:IdentifiedObject.name></nc:OrdinaryContingency>`;
    }).join('\n');
    const file = join(mkdtempSync(join(tmpdir(), 'gridox-')), 'nc_CO_many.xml');
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:nc="https://cim4.eu/ns/nc#" xmlns:cim="https://cim.ucaiug.io/ns#">
${many}
</rdf:RDF>`,
    );
    await input(page).setInputFiles(file);
    const sa = (await at(page, 'security'));
    await sa.getByRole('button', { name: 'Run 49 contingencies' }).click();
    await expect((await at(page, 'sa-summary'))).toContainText('49 contingencies: 48 solved, 1 name equipment the model lacks.');
    await expect((await at(page, 'sa-summary'))).toContainText('1 violation in the base case, 46 violations after contingencies.');
    if ((await page.evaluate(() => navigator.hardwareConcurrency)) > 1) {
      await expect((await at(page, 'sa-options'))).toContainText(/in [2-4] workers/);
    }
  });

  test('solves a contingency again after its curative actions, schedules read at the time chosen', async ({ page }) => {
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
    await input(page).setInputFiles([GRID, STATE, SV, NC, MORE, RA, CURATIVE, SCHEDULE]);
    await expect(page.getByTestId('totals')).toContainText('from 8 files');
    const sa = (await at(page, 'security'));
    await expect(sa.getByRole('button', { name: 'Run 4 contingencies' })).toBeVisible();
    await sa.getByLabel('Curative actions').check();
    await expect(sa.getByLabel('Buses from')).toBeDisabled();
    await sa.getByRole('button', { name: 'Run 4 contingencies' }).click();
    const curative = (await at(page, 'sa-curative'));
    await expect(curative).toContainText('Curative actions after 1 contingency, schedules read at the scenario time: 1 solved again; 0 violations after them.');
    const nothing = (await at(page, 'sa-contingencies')).getByRole('row', { name: /Nothing lost/ });
    await expect(nothing.getByTestId('sa-after')).toContainText('0 violations');
    await expect(nothing.getByTestId('sa-after')).toContainText('Open Breaker A');
    // The times to read schedules at: the scenario time, and the schedule's one point.
    await expect(sa.getByTestId('sa-at').locator('option')).toHaveText(['the scenario time, 2026-01-01T12:00:00Z', '2026-01-01T10:00:00Z']);
    // Without the schedule, "Keep Breaker A closed" takes its range's value and, applied after
    // "Open Breaker A", closes the breaker again: the violation stays.
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
    await input(page).setInputFiles([GRID, STATE, SV, NC, MORE, RA, CURATIVE]);
    await expect(page.getByTestId('totals')).toContainText('from 7 files');
    await expect(sa.getByRole('button', { name: 'Run 4 contingencies' })).toBeVisible();
    await sa.getByLabel('Curative actions').check();
    await sa.getByRole('button', { name: 'Run 4 contingencies' }).click();
    await expect(curative).toContainText('1 violation after them.');
    await expect(nothing.getByTestId('sa-after')).toContainText('1 violation, worst 133.1 %');
  });

  test('a model without contingencies has no analysis', async ({ page }) => {
    await input(page).setInputFiles(fixture('second_EQ.xml'));
    await expect((await at(page, 'security'))).toBeVisible();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
    await input(page).setInputFiles([GRID, STATE, SV]);
    await expect((await at(page, 'power-flow'))).toBeVisible();
    await expect((await at(page, 'security'))).toBeHidden();
  });
});

test.describe('the shell', () => {
  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV]);
    await validated(page);
  });

  test('keys: a number for each view, / to search, Escape to close the inspector', async ({ page }) => {
    await page.locator('body').press('2');
    await expect(page.getByRole('link', { name: 'Validation', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(/#validation$/);
    await page.locator('body').press('/');
    await expect(page.getByTestId('tree').getByRole('searchbox')).toBeFocused();
    await page.getByTestId('tree').getByRole('searchbox').fill('load b');
    await page.getByTestId('hits').getByRole('button', { name: /^Load B/ }).click();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await page.locator('body').press('Escape');
    await expect(page.getByTestId('inspector')).toBeHidden();
  });

  test('the files panel is as wide as dragged or keyed, and stays so', async ({ page }) => {
    const panel = page.getByTestId('files-panel');
    const edge = page.getByRole('separator', { name: 'Width of the files' });
    const before = (await panel.boundingBox())!.width;
    const at = (await edge.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + 200);
    await page.mouse.down();
    await page.mouse.move(at.x + at.width / 2 + 120, at.y + 200, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 100);
    const dragged = Number(await edge.getAttribute('aria-valuenow'));
    await edge.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(edge).toHaveAttribute('aria-valuenow', String(dragged - 16));
    await page.keyboard.press('Home');
    await expect(edge).toHaveAttribute('aria-valuenow', '220');
    // After a reload, where the browser keeps the files and so shows them again.
    if (await page.getByTestId('kept').isVisible()) {
      await page.reload();
      await expect(page.getByRole('separator', { name: 'Width of the files' })).toHaveAttribute('aria-valuenow', '220');
    }
  });

  test('the top bar says what is edited, and undoes it', async ({ page }) => {
    const undo = page.getByRole('banner').getByRole('button', { name: 'Undo' });
    await expect(undo).toBeDisabled();
    await page.getByTestId('tree').getByRole('searchbox').fill('load b');
    await page.getByTestId('hits').getByRole('button', { name: /^Load B/ }).click();
    const edit = page.getByTestId('details').getByTestId('edit');
    await edit.getByText('Edit', { exact: true }).click();
    await edit.getByLabel('Value of EnergyConsumer.p').fill('80');
    await edit.locator('.row', { hasText: 'EnergyConsumer.p' }).getByRole('button', { name: 'Set' }).click();
    await expect(page.getByTestId('edited-count')).toHaveText('1 file edited');
    await expect(undo).toBeEnabled();
    // Ctrl+Z, away from any field.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('edited-count')).toBeHidden();
    await expect(undo).toBeDisabled();
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the files lie over the view, closed at first, and a tap beside them closes them', async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV]);
    await expect(page.getByRole('button', { name: 'Show the files' })).toBeVisible();
    await page.getByRole('button', { name: 'Show the files' }).click();
    await expect(page.getByTestId('totals')).toBeVisible();
    await page.getByRole('button', { name: 'Close the files' }).click({ position: { x: 370, y: 400 } });
    await expect(page.getByTestId('totals')).toBeHidden();
  });
});

test.describe('editing', () => {
  const details = (page: Page) => page.getByTestId('details');
  const open = async (page: Page, name: RegExp, hit = name) => {
    await (await at(page, 'tree')).getByRole('searchbox').fill(name.source.replace(/[\^$]/g, '').toLowerCase());
    await (await at(page, 'hits')).getByRole('button', { name: hit }).click();
    await expect(details(page).getByRole('heading', { name })).toBeVisible();
    const edit = details(page).getByTestId('edit');
    await edit.getByText('Edit', { exact: true }).click();
    return edit;
  };

  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles([GRID, STATE, SV]);
    await validated(page, 30_000);
  });

  test('CO_UC1: equipment is added to a contingency, shaped like its first', async ({ page }) => {
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
    await input(page).setInputFiles([GRID, STATE, SV, NC]);
    await expect(page.getByTestId('totals')).toContainText('from 4 files');
    const edit = await open(page, /^Loss of Anvil-Birch/);
    await expect(edit.getByTestId('guided-elements')).toHaveText('Anvil-Birch (ACLineSegment)');
    await edit.getByLabel('Equipment to add').fill('_00000000-0000-4000-8000-000000000a31');
    await edit.getByRole('button', { name: 'Add to the contingency' }).click();
    await expect(edit.getByTestId('guided-elements').locator('li')).toHaveCount(2);
    await expect(edit.getByTestId('guided-elements')).toContainText('Load B (ConformLoad)');
    await expect(page.getByTestId('edited-files')).toContainText('nc_CO_AE.xml');
  });

  test('RA_UC3: a schedule is disabled from a time, and enabled again', async ({ page }) => {
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
    await input(page).setInputFiles([GRID, STATE, SV, RA, fixture('nc_SIS_enabling.xml')]);
    await expect(page.getByTestId('totals')).toContainText('from 5 files');
    const edit = await open(page, /^TA open enabling/);
    const points = edit.getByTestId('guided-points').locator('li');
    await expect(points).toHaveText(['2026-01-01T00:00:00Z: enabled']);
    await edit.getByLabel('From', { exact: true }).fill('2026-01-01T10:00:00Z');
    await edit.getByLabel('Enabled from then').selectOption('disabled');
    await edit.getByRole('button', { name: 'Set from then' }).click();
    await expect(points).toHaveText(['2026-01-01T00:00:00Z: enabled', '2026-01-01T10:00:00Z: disabled']);
    await edit.getByLabel('Enabled from then').selectOption('enabled');
    await edit.getByRole('button', { name: 'Set from then' }).click();
    await expect(points).toHaveText(['2026-01-01T00:00:00Z: enabled', '2026-01-01T10:00:00Z: enabled']);
  });

  test('a value set changes the files and the model, is validated, and can be undone', async ({ page }) => {
    const edit = await open(page, /^Load B/);
    await edit.getByLabel('Value of EnergyConsumer.p').fill('80');
    await edit.locator('.row', { hasText: 'EnergyConsumer.p' }).getByRole('button', { name: 'Set' }).click();
    const bar = page.getByTestId('edited-files');
    await expect(bar).toContainText('1 file edited');
    await expect(bar).not.toContainText('validating', { timeout: 30_000 });
    await expect(details(page).getByTestId('fields')).toContainText('80');
    // The power flow solves the model as edited.
    await (await at(page, 'power-flow')).getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-violations'))).toContainText(/2\d\d\.\d %/);
    const [download] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download grid_state.xml' }).click()]);
    expect(readFileSync(await download.path(), 'utf8')).toContain('<cim:EnergyConsumer.p>80</cim:EnergyConsumer.p>');
    await bar.getByRole('button', { name: 'Undo' }).click();
    await expect(bar).toBeHidden();
    await expect(details(page).getByTestId('fields')).toContainText('50');
  });

  test('an edit is kept in the browser with the files, and comes back after a reload', async ({ page }) => {
    test.skip(!(await page.getByTestId('kept').isVisible()), 'this browser keeps no files');
    const edit = await open(page, /^Load B/);
    await edit.getByLabel('Value of EnergyConsumer.p').fill('80');
    await edit.locator('.row', { hasText: 'EnergyConsumer.p' }).getByRole('button', { name: 'Set' }).click();
    await expect(page.getByTestId('edited-files')).toContainText('1 file edited');
    await page.reload();
    await validated(page, 30_000);
    await (await at(page, 'tree')).getByRole('searchbox').fill('load b');
    await (await at(page, 'hits')).getByRole('button', { name: /^Load B/ }).click();
    await expect(details(page).getByTestId('fields')).toContainText('80');
  });

  test('a field is added, and removed', async ({ page }) => {
    const edit = await open(page, /^Load B/);
    await edit.getByLabel('Field to add').selectOption('IdentifiedObject.description');
    await edit.getByLabel('Value of IdentifiedObject.description').fill('the mill');
    await edit.getByRole('button', { name: 'Add field' }).click();
    await expect(details(page).getByTestId('fields')).toContainText('the mill');
    // The editor stays open, and knows the field is written now.
    await details(page).getByTestId('edit').getByRole('button', { name: 'Remove IdentifiedObject.description' }).click();
    await expect(details(page).getByTestId('fields')).not.toContainText('the mill');
  });

  test('an mRID is renamed in every file, and the object shown under it', async ({ page }) => {
    const edit = await open(page, /^Breaker A/);
    await edit.getByLabel('New mRID').fill('_breaker-a');
    await edit.getByRole('button', { name: 'Rename' }).click();
    await expect(details(page).getByTestId('fields')).toContainText('_breaker-a');
    await expect(page.getByTestId('edited-files')).toContainText('2 files edited');
  });

  test('RA_UC4: a schedule refused with a counter-proposal in a file of its own, undone as one', async ({ page }) => {
    await input(page).setInputFiles([RA, RAS]);
    // The tree has the new files once the summary counts them.
    await expect(page.getByTestId('totals')).toContainText('from 5 files');
    const edit = await open(page, /^Open A, proposed/);
    await edit.getByRole('button', { name: 'Counter-propose' }).click();
    const bar = page.getByTestId('edited-files');
    await expect(bar).toContainText('1 file edited');
    await expect(bar.getByRole('button', { name: 'Download nc_RAS_counter-proposal.xml' })).toBeVisible();
    // The copy is shown: proposed, its points not active, replacing the one refused.
    await expect(details(page).getByRole('heading', { name: 'Open A, proposed' })).toBeVisible();
    await expect((await at(page, 'referrers'))).toContainText('RemedialActionScheduleDependency.ProposedRemedialActionSchedule');
    await expect(page.getByTestId('totals')).toContainText('from 6 files');
    await bar.getByRole('button', { name: 'Undo' }).click();
    await expect(bar).toBeHidden();
    await expect(page.getByTestId('totals')).toContainText('from 5 files');
  });

  test('an object is added in its container, and one deleted after saying what goes', async ({ page }) => {
    let edit = await open(page, /^Anvil 110$/, /^Anvil 110 VoltageLevel/);
    await edit.getByLabel('Class to add').selectOption('Breaker');
    await edit.getByLabel('Name of the object to add').fill('Breaker C');
    await edit.getByRole('button', { name: 'Add object' }).click();
    await expect(details(page).getByRole('heading', { name: 'Breaker C' })).toBeVisible();
    edit = details(page).getByTestId('edit');
    await edit.getByRole('button', { name: 'Delete…' }).click();
    await expect(edit.getByTestId('delete-preview')).toContainText('Deletes 1 object and 0 references to it, in grid_EQ.xml.');
    await edit.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('edited-files')).toContainText('1 file edited');
    await (await at(page, 'tree')).getByRole('searchbox').fill('breaker c');
    await expect((await at(page, 'hits')).getByRole('button', { name: /Breaker C/ })).toHaveCount(0);
  });
});

test.describe('choosing many files at once', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'gridox-'));

  test('a zip archive, with one in it, is read as the files it holds', async ({ page }) => {
    const inner = zip([{ path: 'state/grid_SV.xml', data: readFileSync(SV), deflate: true }]);
    const archive = zip([
      { path: 'grid/grid_EQ.xml', data: readFileSync(GRID), deflate: true },
      { path: 'grid/grid_state.xml', data: readFileSync(STATE) },
      { path: 'sv.zip', data: inner },
      { path: 'README.txt', data: 'not a model' },
    ]);
    const path = join(scratch(), 'model.zip');
    writeFileSync(path, archive);
    await input(page).setInputFiles(path);
    await expect(page.getByTestId('totals')).toContainText('from 3 files');
    await (await at(page, 'power-flow')).getByRole('button', { name: 'Solve' }).click();
    await expect((await at(page, 'pf-verdict'))).toHaveText('2 nodes solved, in 1 component.');
  });

  test('an archive that cannot be read is said so, and the rest is read', async ({ page }) => {
    const path = join(scratch(), 'broken.zip');
    writeFileSync(path, 'PK, but no more');
    await input(page).setInputFiles([path, GRID]);
    await expect(page.getByTestId('skipped')).toContainText('broken.zip: the archive could not be read (not a zip archive)');
    await expect(page.getByTestId('totals')).toContainText('from 1 file');
  });

  test('a folder: its XML files and zip archives, in its subfolders too', async ({ page }) => {
    const dir = scratch();
    mkdirSync(join(dir, 'igm', 'state'), { recursive: true });
    cpSync(GRID, join(dir, 'igm', 'grid_EQ.xml'));
    cpSync(STATE, join(dir, 'igm', 'state', 'grid_state.xml'));
    writeFileSync(join(dir, 'sv.zip'), zip([{ path: 'grid_SV.xml', data: readFileSync(SV), deflate: true }]));
    writeFileSync(join(dir, 'notes.txt'), 'not a model');
    await folderInput(page).setInputFiles(dir);
    await expect(page.getByTestId('totals')).toContainText('from 3 files');
  });

  test('the files stay loaded in their folders, and each is ticked into the model or not', async ({ page }) => {
    const dir = scratch();
    for (const sub of ['grid', 'nc']) mkdirSync(join(dir, 'model', sub), { recursive: true });
    for (const f of [GRID, STATE, SV]) cpSync(f, join(dir, 'model', 'grid', f.split('/').pop()!));
    cpSync(NC, join(dir, 'model', 'nc', 'nc_CO_AE.xml'));
    writeFileSync(join(dir, 'model', 'nc', 'sv.zip'), zip([{ path: 'inner/extra_SV.xml', data: readFileSync(SV) }]));
    await folderInput(page).setInputFiles(dir);
    await expect(page.getByTestId('totals')).toContainText('from 5 files');
    const tree = page.getByTestId('file-tree');
    await expect(tree.getByTestId('included')).toHaveText('5 of 5 in the model');
    // The folders as they are, the zip's file under the archive.
    await expect(tree.getByLabel('Folder grid in the model')).toBeChecked();
    await expect(tree.getByRole('button', { name: 'Close nc' })).toBeVisible();
    await expect(tree.getByLabel('Folder sv.zip in the model')).toBeVisible();
    // The network codes out: the model without them, nothing read again.
    await tree.getByLabel('Folder nc in the model').uncheck();
    await expect(tree.getByTestId('included')).toHaveText('3 of 5 in the model');
    await expect(page.getByTestId('totals')).toContainText('from 3 files');
    await expect(await at(page, 'no-network-codes')).toBeVisible();
    // One back: the folder only partly in.
    await tree.getByLabel('nc_CO_AE.xml in the model').check();
    await expect(tree.getByTestId('included')).toHaveText('4 of 5 in the model');
    expect(await tree.getByLabel('Folder nc in the model').evaluate((box) => (box as HTMLInputElement).indeterminate)).toBe(true);
    await expect(await at(page, 'network-codes')).toBeVisible();
    // Kept so after a reload, when the browser keeps the files.
    if (await page.getByTestId('kept').isVisible()) {
      await page.reload();
      await expect(page.getByTestId('file-tree').getByTestId('included')).toHaveText('4 of 5 in the model');
      await expect(page.getByTestId('totals')).toContainText('from 4 files');
    }
    await page.getByTestId('file-tree').getByRole('button', { name: 'None' }).click();
    await expect(page.getByTestId('file-tree').getByTestId('included')).toHaveText('0 of 5 in the model');
    await page.getByTestId('file-tree').getByRole('button', { name: 'All' }).click();
    await expect(page.getByTestId('file-tree').getByTestId('included')).toHaveText('5 of 5 in the model');
  });

  test('presets by what the headers say tick files in and out', async ({ page }) => {
    await input(page).setInputFiles([GRID, NC, MORE]);
    const tree = page.getByTestId('file-tree');
    await expect(tree.getByTestId('included')).toHaveText('3 of 3 in the model');
    const presets = tree.getByTestId('presets');
    // Two kinds, one maker only: no maker to choose between.
    await expect(presets.getByRole('button')).toHaveText(['CGMES 1', 'Network codes 2']);
    await presets.getByRole('button', { name: /^Network codes/ }).click();
    await expect(tree.getByTestId('included')).toHaveText('1 of 3 in the model');
    await expect(presets.getByRole('button', { name: /^Network codes/ })).toHaveAttribute('aria-pressed', 'false');
    await tree.getByLabel('nc_CO_AE.xml in the model').check();
    await expect(presets.getByRole('button', { name: /^Network codes/ })).toHaveAttribute('aria-pressed', 'mixed');
    await presets.getByRole('button', { name: /^Network codes/ }).click();
    await expect(tree.getByTestId('included')).toHaveText('3 of 3 in the model');
  });

  test('files of one name in two folders are both loaded, each named by its folder', async ({ page }) => {
    const dir = scratch();
    for (const sub of ['east', 'west']) {
      mkdirSync(join(dir, sub), { recursive: true });
      cpSync(GRID, join(dir, sub, 'grid_EQ.xml'));
    }
    await folderInput(page).setInputFiles(dir);
    await expect(page.getByTestId('totals')).toContainText('from 2 files');
    const tree = page.getByTestId('file-tree');
    await expect(tree.getByLabel('grid_EQ.xml in the model', { exact: true })).toBeVisible();
    await expect(tree.getByLabel('west-grid_EQ.xml in the model')).toBeVisible();
    // The same folder again: its files are the ones loaded.
    await folderInput(page).setInputFiles(dir);
    await expect(page.getByTestId('skipped')).toContainText('a file of this name is already loaded');
    await expect(page.getByTestId('totals')).toContainText('from 2 files');
  });

  test('a folder with nothing to read is said so', async ({ page }) => {
    const dir = scratch();
    writeFileSync(join(dir, 'notes.txt'), 'not a model');
    await folderInput(page).setInputFiles(dir);
    await expect(page.getByTestId('folder-empty')).toContainText('There are no XML files or zip archives in that folder.');
  });
});

test('says so when the files hold no grid', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect((await at(page, 'no-grid'))).toBeVisible();
});

test('a reload brings the files back, until they are cleared', async ({ playwright, browserName, baseURL }) => {
  // On disk, as a browser is used: WebKit gives Playwright's usual contexts no private file system.
  const context = await playwright[browserName].launchPersistentContext(mkdtempSync(join(tmpdir(), 'gridox-')), { baseURL });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('./');
  await input(page).setInputFiles([EQ, SSH]);
  await expect(page.getByTestId('kept')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('totals')).toContainText('4 objects from 2 files');
  await expect(page.getByTestId('kept')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
  await expect(page.getByTestId('totals')).toBeHidden();
  await page.reload();
  await expect(input(page)).toBeAttached();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('totals')).toBeHidden();
  await context.close();
});

test('where files cannot be kept, it still reads them and does not say they are kept', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'only WebKit refuses in a test, as it may in a private window');
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
  await expect(page.getByTestId('kept')).toBeHidden();
  await page.reload();
  await expect(input(page)).toBeAttached();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('totals')).toBeHidden();
});

const relicap = process.env.RELICAPGRID_DIR;

// The largest test model, to measure with: REALGRID_DIR=.../RealGrid/RealGrid-Merged npm run e2e
const realGrid = process.env.REALGRID_DIR;
test('draws RealGrid', async ({ page }, info) => {
  test.skip(!realGrid, 'REALGRID_DIR is not set');
  test.setTimeout(240_000);
  const files = readdirSync(realGrid!).filter((name) => name.endsWith('.xml')).map((name) => join(realGrid!, name));
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  const started = Date.now();
  await input(page).setInputFiles(files);
  await expect(page.getByTestId('totals')).toContainText('objects from', { timeout: 120_000 });
  const read = Date.now() - started;
  await expect((await at(page, 'grid-summary'))).toContainText('substations', { timeout: 120_000 });
  const laid = Date.now() - started;
  await expect.poll(() => painted(page), { timeout: 60_000 }).toBe(true);
  console.log(`${info.project.name}: read ${read} ms, laid out ${laid} ms, drawn ${Date.now() - started} ms`);
  console.log(await (await at(page, 'grid-summary')).textContent());
  expect(problems).toEqual([]);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await (await at(page, 'tree')).getByRole('searchbox').fill('a');
  await expect((await at(page, 'hits')).getByRole('button').first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect((await at(page, 'grid-summary'))).toContainText('substations', { timeout: 120_000 });
  console.log(`${info.project.name}: back after a reload`);
});

// cimoxide's report, scripts/relicapgrid, counts what `cimoxide.validate_files` finds with both checks on.
test('finds on ReliCapGrid what cimoxide finds', async ({ page }) => {
  test.skip(!relicap, 'RELICAPGRID_DIR is not set');
  test.setTimeout(120_000);
  const grid = (area: string) =>
    readdirSync(join(relicap!, 'Instance', area, 'Grid', 'cimxml')).sort().map((n) => join(relicap!, 'Instance', area, 'Grid', 'cimxml', n));
  for (const [area, expected] of [['Svedala', 572], ['Belgovia', 82]] as const) {
    if (await page.getByRole('button', { name: 'Clear' }).isVisible()) {
      await page.getByRole('button', { name: 'Clear' }).click();
      await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
      await expect((await at(page, 'findings-summary'))).toBeHidden();
    }
    await input(page).setInputFiles(grid(area));
    await expect((await at(page, 'findings-summary'))).toContainText('in 4 files', { timeout: 60_000 });
    for (const label of ['Common cross-profile checks', 'Modelling-quality checks']) {
      const box = page.getByLabel(label);
      if (!(await box.isChecked())) {
        await box.check();
        await expect((await at(page, 'findings-summary'))).not.toHaveText('Validating…', { timeout: 60_000 });
      }
    }
    await expect((await at(page, 'findings-summary'))).toContainText('in 4 files', { timeout: 60_000 });
    const text = (await (await at(page, 'findings-summary')).textContent())!;
    const total = [...text.matchAll(/([\d,]+) (violation|warning|info)/g)].reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0);
    expect(total, `${area}: ${text}`).toBe(expected);
  }
});

// A real model, to measure with: RELICAPGRID_DIR=.../relicapgrid npm run e2e
test('decodes ReliCapGrid common grid model', async ({ page }, info) => {
  test.skip(!relicap, 'RELICAPGRID_DIR is not set');
  const dir = (path: string, pattern: RegExp = /./) =>
    readdirSync(join(relicap!, 'Instance', path))
      .filter((name) => pattern.test(name))
      .sort()
      .map((name) => join(relicap!, 'Instance', path, name));
  const areas = ['Belgovia', 'Britheim', 'DC-Espheim-Svedala', 'DC-Nordheim-Galia', 'Espheim', 'Galia', 'Nordheim', 'Portheim', 'Svedala'];
  await input(page).setInputFiles([
    ...dir('Jotunheim/ChangeSet/cimxml'),
    ...dir('Jotunheim/Grid/cimxml', /_SV_|_TP_/),
    ...areas.flatMap((area) => dir(`${area}/Grid/cimxml`, /_EQ_/)),
    ...dir('boundaryData/Grid/cimxml'),
    ...dir('commonData/Grid/cimxml'),
  ]);
  await expect(page.getByTestId('totals')).toContainText('from 27 files', { timeout: 60_000 });
  await expect(page.getByTestId('totals')).toContainText('31,412 objects');
  console.log(`${info.project.name}: ${await page.getByTestId('elapsed').textContent()}`);
});
