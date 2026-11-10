import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);
const EQ = fixture('small_EQ.xml');
const SSH = fixture('small_SSH.xml');
const GRID = fixture('grid_EQ.xml');
const SECOND = fixture('second_EQ.xml');
const NC = fixture('nc_CO_AE.xml');
const RA = fixture('nc_RA.xml');
const input = (page: Page) => page.locator('input[type=file]');

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('loads a file and shows its classes', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
  await page.getByText('Classes', { exact: true }).click();
  const row = page.getByTestId('classes').getByRole('row', { name: 'ACLineSegment' });
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
    await expect(page.getByTestId('datasets-summary')).toBeVisible();
    await page.getByTestId('graph').scrollIntoViewIfNeeded();
    const graph = await page.getByTestId('graph').boundingBox();
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

test('says so when a drop holds nothing', async ({ page }) => {
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page.locator('header').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('notice')).toContainText('No files came through');
});

test('clears the model', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
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
    await expect(page.getByTestId('fields')).toContainText('Switch.normalOpen');
    await expect(page.getByTestId('fields')).toContainText('false');
  });

  test('an object picked in the tree is shown inside its substation', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('breaker a');
    await page.getByTestId('hits').getByRole('button', { name: /Breaker A/ }).click();
    await expect(summary(page)).toContainText('Anvil: 2 equipment, 2 nodes, 1 switch');
    await expect(details(page)).toContainText('Breaker · Anvil 110 · closed');
    await expect(tree(page).locator('[aria-current="true"]')).toContainText('Breaker A');
    await expect.poll(() => painted(page)).toBe(true);
    await page.getByRole('button', { name: '← Grid' }).click();
    await expect(summary(page)).toContainText('2 substations, 0 boundary points, 1 connection');
  });

  test('goes inside a substation from its details', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('birch');
    await page.getByTestId('hits').getByRole('button', { name: /^Birch Substation/ }).click();
    await details(page).getByRole('button', { name: 'Show inside' }).click();
    await expect(summary(page)).toContainText('Birch: 2 equipment');
    await page.keyboard.press('Escape');
    await expect(summary(page)).toContainText('2 substations');
  });

  test('follows a reference to what it names', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('breaker a');
    await page.getByTestId('hits').getByRole('button', { name: /Breaker A/ }).click();
    await page.getByTestId('fields').getByRole('button', { name: 'Anvil 110' }).click();
    await expect(details(page).getByRole('heading', { name: 'Anvil 110' })).toBeVisible();
    await expect(tree(page).locator('[aria-current="true"]')).toContainText('Anvil 110');
  });

  test('an object says what refers to it, and Back returns', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('anvil 110');
    await page.getByTestId('hits').getByRole('button', { name: /Anvil 110/ }).click();
    const referrers = page.getByTestId('referrers');
    await expect(details(page).getByRole('heading', { name: 'Referred to by 3' })).toBeVisible();
    await expect(referrers).toContainText('Equipment.EquipmentContainer');
    await referrers.getByRole('button', { name: 'Breaker A' }).click();
    await expect(details(page).getByRole('heading', { name: 'Breaker A' })).toBeVisible();
    await details(page).getByRole('button', { name: '← Back' }).click();
    await expect(details(page).getByRole('heading', { name: 'Anvil 110' })).toBeVisible();
  });

  test('a field can say what the vocabulary says of it', async ({ page }) => {
    await tree(page).getByRole('searchbox').fill('breaker a');
    await page.getByTestId('hits').getByRole('button', { name: /Breaker A/ }).click();
    const fields = page.getByTestId('fields');
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
    await expect(findings(page)).toContainText(/violation|warning|info/);
  });

  test('runs after loading, and lists each broken rule with its findings', async ({ page }) => {
    await expect(findings(page)).toContainText('in 1 file');
    await page.getByText(/rules? broken/).click();
    const rule = page.getByTestId('findings').locator('.rules > li').first();
    await rule.locator('summary').click();
    await expect(rule.getByTestId('found').locator('li').first()).toBeVisible();
  });

  test('a finding leads to its object, which lists it', async ({ page }) => {
    await page.getByText(/rules? broken/).click();
    const rule = page.getByTestId('findings').locator('.rules > li').first();
    await rule.locator('summary').click();
    const first = rule.getByTestId('found').getByRole('button').first();
    const name = (await first.textContent())!.trim();
    await first.click();
    await expect(page.getByTestId('details').getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByTestId('object-findings')).toBeVisible();
  });

  test('the tree counts findings and can show only what holds them', async ({ page }) => {
    const tree = page.getByTestId('tree');
    await expect(tree.locator('.badge').first()).toBeVisible();
    await tree.getByLabel('With findings only').check();
    await expect(tree.locator('.row').first()).toBeVisible();
    const sections = await tree.locator('.row').count();
    await expect(tree.locator('.row .badge')).toHaveCount(sections);
  });

  test('the grid says what was found on it', async ({ page }) => {
    await expect(page.getByTestId('grid-summary')).toContainText('not on the grid');
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
    await expect(page.getByTestId('datasets-summary')).toBeVisible();
  });

  test('say what is defined twice and which header references are not loaded', async ({ page }) => {
    const summary = page.getByTestId('datasets-summary');
    await expect(summary).toContainText('2 files');
    await expect(summary).toContainText('1 object defined more than once');
    await expect(summary).toContainText('1 header reference not loaded');
    await summary.click();
    await page.getByTestId('twice').getByRole('button', { name: 'Breaker A' }).click();
    await expect(page.getByTestId('defined-in')).toContainText('Defined by 2 files: grid_EQ.xml, second_EQ.xml');
  });

  test('a header shows where its references lead', async ({ page }) => {
    await page.getByTestId('datasets-summary').click();
    const files = page.getByTestId('dataset-files');
    await files.getByText('second_EQ.xml').click();
    await expect(files.locator('.missing')).toHaveText('urn:uuid:not-loaded not loaded');
    await files.getByRole('button', { name: 'urn:uuid:00000000-0000-4000-8000-000000000f01' }).click();
    await expect(page.getByTestId('details').getByRole('heading', { name: 'urn:uuid:00000000-0000-4000-8000-000000000f01' })).toBeVisible();
    await expect(page.getByTestId('referrers')).toContainText('Model.DependentOn');
  });

  test('reference data has a page of its own', async ({ page }) => {
    await page.getByTestId('tree').getByRole('searchbox').fill('breaker a');
    await page.getByTestId('hits').getByRole('button', { name: /Breaker A/ }).click();
    await page.getByTestId('fields').getByRole('button', { name: 'A concept' }).click();
    const details = page.getByTestId('details');
    await expect(details).toContainText('Reference data, outside the CIM class tables.');
    await expect(page.getByTestId('referrers')).toContainText('Switch.concept');
  });
});

test.describe('network codes', () => {
  test.beforeEach(async ({ page }) => {
    await input(page).setInputFiles([GRID, NC]);
    await expect(page.getByTestId('network-codes')).toBeVisible();
  });

  test('a contingency shows its equipment, and where the grid has it', async ({ page }) => {
    const row = page.getByTestId('contingencies').getByRole('row', { name: /Loss of Anvil-Birch/ });
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
    const table = page.getByTestId('assessed-elements');
    const scanned = table.getByRole('row', { name: /Breaker A scanned/ });
    await expect(scanned).toContainText('nonNativeCapacityCalculationRegion');
    await expect(scanned).toContainText('_region');
    await scanned.getByRole('button', { name: 'Show on grid' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeVisible();
  });

  test('a table leads to an object\'s page', async ({ page }) => {
    await page.getByTestId('contingencies').getByRole('button', { name: 'Loss of Anvil-Birch' }).click();
    await expect(page.getByTestId('details').getByRole('heading', { name: 'Loss of Anvil-Birch' })).toBeVisible();
    await expect(page.getByTestId('referrers')).toContainText('ContingencyElement.Contingency');
  });

  test('a remedial action says what it changes, and what applying it gives', async ({ page }) => {
    await input(page).setInputFiles(RA);
    await page.getByRole('tab', { name: /Remedial actions/ }).click();
    const table = page.getByTestId('remedial-actions');
    const open = table.getByRole('row', { name: /^Open Breaker A/ });
    await expect(open).toContainText('Switch.open = 1.0 (absolute)');
    await expect(open).toContainText('exclusive');
    await expect(open).toContainText('Keep Breaker A closed');
    await expect(open.getByTestId('applied')).toContainText('closed → open');
    await expect(table.getByRole('row', { name: /^Keep Breaker A closed/ }).getByTestId('applied')).toContainText('stays closed');
    await open.getByRole('button', { name: 'Show on grid' }).click();
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toBeVisible();
  });

  test('filters by name', async ({ page }) => {
    await page.getByLabel('Filter the table').fill('nothing like it');
    await expect(page.getByTestId('contingencies').getByRole('row')).toHaveCount(1);
  });
});

test('says so when the files hold no grid', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('no-grid')).toBeVisible();
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
  await expect(page.getByTestId('grid-summary')).toContainText('substations', { timeout: 120_000 });
  const laid = Date.now() - started;
  await expect.poll(() => painted(page), { timeout: 60_000 }).toBe(true);
  console.log(`${info.project.name}: read ${read} ms, laid out ${laid} ms, drawn ${Date.now() - started} ms`);
  console.log(await page.getByTestId('grid-summary').textContent());
  expect(problems).toEqual([]);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  await page.getByTestId('tree').getByRole('searchbox').fill('a');
  await expect(page.getByTestId('hits').getByRole('button').first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByTestId('grid-summary')).toContainText('substations', { timeout: 120_000 });
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
      await expect(page.getByTestId('findings-summary')).toBeHidden();
    }
    await input(page).setInputFiles(grid(area));
    await expect(page.getByTestId('findings-summary')).toContainText('in 4 files', { timeout: 60_000 });
    for (const label of ['Common cross-profile checks', 'Modelling-quality checks']) {
      const box = page.getByLabel(label);
      if (!(await box.isChecked())) {
        await box.check();
        await expect(page.getByTestId('findings-summary')).not.toHaveText('Validating…', { timeout: 60_000 });
      }
    }
    await expect(page.getByTestId('findings-summary')).toContainText('in 4 files', { timeout: 60_000 });
    const text = (await page.getByTestId('findings-summary').textContent())!;
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
