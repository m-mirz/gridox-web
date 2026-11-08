import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);
const EQ = fixture('small_EQ.xml');
const SSH = fixture('small_SSH.xml');
const GRID = fixture('grid_EQ.xml');
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
    await expect(summary(page)).toHaveText('2 substations, 0 boundary points, 1 connection');
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
    await expect(summary(page)).toHaveText('2 substations, 0 boundary points, 1 connection');
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

  test('a page wide as a phone does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
  });

  test('breaks none of the page\'s rules while drawing', async ({ context }) => {
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(String(error)));
    await page.goto('./');
    await page.getByRole('button', { name: 'Clear' }).waitFor({ timeout: 15_000 }).catch(() => {});
    await expect.poll(() => painted(page).catch(() => false)).toBe(true);
    expect(problems).toEqual([]);
  });
});

test('says so when the files hold no grid', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('no-grid')).toBeVisible();
});

test('a reload brings the files back, until they are cleared', async ({ page }) => {
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
});

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

// A real model, to measure with: RELICAPGRID_DIR=.../relicapgrid npm run e2e
const relicap = process.env.RELICAPGRID_DIR;
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
