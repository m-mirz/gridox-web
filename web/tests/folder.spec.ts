/**
 * Saving edits back into the folder the model was opened from, with the File System Access API.
 * Playwright cannot drive the folder picker, so `showDirectoryPicker` hands over a folder of the
 * page's origin private file system instead: a real directory handle, read, asked for permission
 * and written to as one on disk is. Chromium alone has the API; elsewhere the button is not there.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { at, validated, view } from './views';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);
const FILES = ['grid_EQ.xml', 'grid_state.xml', 'grid_SV.xml'];
const FOLDER = 'a-model';

/** The folder's files, as on disk. */
const onDisk = (page: Page, name: string) =>
  page.evaluate(
    async ([folder, name]) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
      return (await (await dir.getFileHandle(name)).getFile()).text();
    },
    [FOLDER, name],
  );

/** Writes `text` to the folder's file `name`, as another program would. */
const writeOnDisk = (page: Page, name: string, text: string) =>
  page.evaluate(
    async ([folder, name, text]) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    },
    [FOLDER, name, text],
  );

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the File System Access API is Chromium’s');
  await page.addInitScript((folder) => {
    // @ts-expect-error The picker, standing in for the user's choice.
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
  }, FOLDER);
  await page.goto('./');
  // The folder, with the model in a subfolder, as a model folder often has it.
  const texts = FILES.map((name) => [name, readFileSync(fixture(name), 'utf8')]);
  await page.evaluate(
    async ([folder, texts]) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(folder, { recursive: true }).catch(() => undefined);
      const dir = await (await root.getDirectoryHandle(folder, { create: true })).getDirectoryHandle('grid', { create: true });
      for (const [name, text] of texts as string[][]) {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      }
    },
    [FOLDER, texts] as const,
  );
  await page.getByRole('button', { name: 'Open a folder to save edits in place' }).click();
  await expect(page.getByTestId('totals')).toContainText('from 3 files');
  await expect(page.getByTestId('folder')).toContainText('3 files of the model from this folder');
  await validated(page, 30_000);
});

/** Sets Load B's active power to `p`, through its Edit panel. */
async function setLoad(page: Page, p: string) {
  await (await at(page, 'tree')).getByRole('searchbox').fill('load b');
  await (await at(page, 'hits')).getByRole('button', { name: /^Load B/ }).click();
  const edit = (await at(page, 'details')).getByTestId('edit');
  if ((await edit.getAttribute('open')) === null) await edit.getByText('Edit', { exact: true }).click();
  await edit.getByLabel('Value of EnergyConsumer.p').fill(p);
  await edit.locator('.row', { hasText: 'EnergyConsumer.p' }).getByRole('button', { name: 'Set' }).click();
  await expect(page.getByTestId('edited-files')).not.toContainText('validating', { timeout: 30_000 });
}

/** Opens the folder subfolder `grid` holds; reads a file of it. */
const inGrid = (page: Page, name: string) =>
  page.evaluate(
    async ([folder, name]) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
      return (await (await (await root.getDirectoryHandle('grid')).getFileHandle(name)).getFile()).text();
    },
    [FOLDER, name],
  );

test('an edit is saved into the file it was made to, after saying what it will write', async ({ page }) => {
  const bar = page.getByTestId('folder');
  await setLoad(page, '80');
  // No other folder is asked for.
  await expect(page.getByRole('button', { name: 'Save all to a folder…' })).toBeHidden();
  await bar.getByRole('button', { name: 'Save in place…' }).click();
  await expect(bar.getByTestId('folder-plan')).toHaveText('grid_state.xml: overwritten');
  await bar.getByRole('button', { name: 'Write 1 file' }).click();
  await expect(bar).toContainText('Saved 1 file into a-model.');
  expect(await inGrid(page, 'grid_state.xml')).toContain('<cim:EnergyConsumer.p>80</cim:EnergyConsumer.p>');
  expect(await inGrid(page, 'grid_EQ.xml')).toBe(readFileSync(fixture('grid_EQ.xml'), 'utf8'));
  // Saved, the folder has the model as it is.
  await bar.getByRole('button', { name: 'Save in place…' }).click();
  await expect(bar).toContainText('nothing to save');
});

test('a file changed on disk since it was read is left alone', async ({ page }) => {
  const bar = page.getByTestId('folder');
  await setLoad(page, '80');
  // Another program changes the file the edit was made to.
  await page.evaluate(
    async ([folder]) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
      const handle = await (await root.getDirectoryHandle('grid')).getFileHandle('grid_state.xml');
      const text = (await (await handle.getFile()).text()).replace('</rdf:RDF>', '<!-- theirs --></rdf:RDF>');
      await new Promise((r) => setTimeout(r, 20));
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
    [FOLDER],
  );
  await bar.getByRole('button', { name: 'Save in place…' }).click();
  await expect(bar.getByTestId('folder-plan')).toHaveText('grid_state.xml: left alone: changed on disk since it was read');
  await expect(bar.getByRole('button', { name: 'Write 0 files' })).toBeDisabled();
  expect(await inGrid(page, 'grid_state.xml')).toContain('<!-- theirs -->');
});

test('the folder is remembered: after a reload, an edit kept in the browser is still saved into it', async ({ page }) => {
  await setLoad(page, '70');
  await page.reload();
  const bar = page.getByTestId('folder');
  await expect(bar).toContainText('a-model');
  await validated(page, 30_000);
  // The edit came back with the kept files, though its history did not: the folder is compared.
  await bar.getByRole('button', { name: 'Save in place…' }).click();
  await expect(bar.getByTestId('folder-plan')).toHaveText('grid_state.xml: overwritten');
  await bar.getByRole('button', { name: 'Write 1 file' }).click();
  await expect(bar).toContainText('Saved 1 file into a-model.');
  expect(await inGrid(page, 'grid_state.xml')).toContain('<cim:EnergyConsumer.p>70</cim:EnergyConsumer.p>');
});

test('a file an edit creates goes into the folder, unless the folder has its name', async ({ page }) => {
  // The remedial actions and their schedules in the folder too, opened again.
  await writeOnDisk(page, 'nc_RA.xml', readFileSync(fixture('nc_RA.xml'), 'utf8'));
  await writeOnDisk(page, 'nc_RAS.xml', readFileSync(fixture('nc_RAS.xml'), 'utf8'));
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
  await page.getByRole('button', { name: 'Open a folder to save edits in place' }).click();
  await expect(page.getByTestId('totals')).toContainText('from 5 files');
  await validated(page, 30_000);
  // RA_UC4's counter-proposal, a file of its own.
  await (await at(page, 'tree')).getByRole('searchbox').fill('open a, proposed');
  await (await at(page, 'hits')).getByRole('button', { name: /^Open A, proposed/ }).click();
  const edit = (await at(page, 'details')).getByTestId('edit');
  if ((await edit.getAttribute('open')) === null) await edit.getByText('Edit', { exact: true }).click();
  await edit.getByRole('button', { name: 'Counter-propose' }).click();
  await expect(page.getByTestId('edited-files')).not.toContainText('validating', { timeout: 30_000 });
  const bar = page.getByTestId('folder');
  await bar.getByRole('button', { name: 'Save in place…' }).click();
  await expect(bar.getByTestId('folder-plan')).toHaveText('nc_RAS_counter-proposal.xml: created');
  // Something of that name appears in the folder meanwhile: it is not overwritten.
  await writeOnDisk(page, 'nc_RAS_counter-proposal.xml', '<x/>');
  await bar.getByRole('button', { name: 'Cancel' }).click();
  await bar.getByRole('button', { name: 'Save in place…' }).click();
  await expect(bar.getByTestId('folder-plan')).toHaveText('nc_RAS_counter-proposal.xml: left alone: the folder has a file of that name');
  await page.evaluate(async (folder) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
    await root.removeEntry('nc_RAS_counter-proposal.xml');
  }, FOLDER);
  await bar.getByRole('button', { name: 'Cancel' }).click();
  await bar.getByRole('button', { name: 'Save in place…' }).click();
  await bar.getByRole('button', { name: 'Write 1 file' }).click();
  await expect(bar).toContainText('Saved 1 file into a-model.');
  expect(await onDisk(page, 'nc_RAS_counter-proposal.xml')).toContain('RemedialActionScheduleResponse');
});

test('forgetting the folder, or clearing the model, writes nothing more', async ({ page }) => {
  await page.getByTestId('folder').getByRole('button', { name: 'Forget the folder' }).click();
  await expect(page.getByTestId('folder')).toBeHidden();
  // Gone from what the browser keeps, before the reload.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const open = indexedDB.open('cimlens-folder', 1);
            open.onsuccess = () => {
              const get = open.result.transaction('folder').objectStore('folder').get('current');
              get.onsuccess = () => {
                resolve(get.result === undefined);
                open.result.close();
              };
            };
          }),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByTestId('totals')).toContainText('from 3 files');
  await expect(page.getByTestId('folder')).toBeHidden();
  await page.getByRole('button', { name: 'Open a folder to save edits in place' }).click();
  await expect(page.getByTestId('folder')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('heading', { name: 'Open a model' })).toBeVisible();
  await expect(page.getByTestId('folder')).toBeHidden();
});
