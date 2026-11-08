import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);
const EQ = fixture('small_EQ.xml');
const SSH = fixture('small_SSH.xml');
const input = (page: Page) => page.locator('input[type=file]');

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('loads a file and shows its classes', async ({ page }) => {
  await input(page).setInputFiles(EQ);
  await expect(page.getByTestId('totals')).toContainText('4 objects from 1 file');
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
