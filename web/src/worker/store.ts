/**
 * The loaded files, kept in this browser's origin private file system, so that a reload does not ask
 * for them again. Nothing here leaves the machine, and Clear removes them. They are read back in the
 * order they came, as that order decides what a merge keeps.
 */

const DIRECTORY = 'model';
const PREFIX = /^\d{4}-/;

async function directory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(DIRECTORY, { create });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function storedNames(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const found: string[] = [];
  // @ts-expect-error TypeScript's DOM library lacks the directory's iterator.
  for await (const name of dir.keys()) found.push(name as string);
  // The model's files, not what is kept about them.
  return found.filter((n) => PREFIX.test(n)).sort();
}

/** What is kept about the files: each one's path, and those left out of the model. */
export interface Meta {
  paths: Record<string, string>;
  excluded: string[];
}

const META = 'meta.json';

/** Keeps `meta` beside the files. Failing that, it is only lost: the files still come back. */
export async function keepMeta(meta: Meta): Promise<void> {
  try {
    const dir = await directory(false);
    if (!dir) return;
    const access = await (await dir.getFileHandle(META, { create: true })).createSyncAccessHandle();
    try {
      access.truncate(0);
      access.write(new TextEncoder().encode(JSON.stringify(meta)), { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
  } catch (error) {
    console.warn('What is known of the files could not be kept:', error);
  }
}

/** What was kept about the files, or nothing. */
export async function keptMeta(): Promise<Meta> {
  try {
    const dir = await directory(false);
    const file = dir && (await (await dir.getFileHandle(META)).getFile());
    const meta = file ? (JSON.parse(await file.text()) as Partial<Meta>) : {};
    return { paths: meta.paths ?? {}, excluded: meta.excluded ?? [] };
  } catch {
    return { paths: {}, excluded: [] };
  }
}

/** Keeps `files` after those kept already. Whether every file is kept: none are, otherwise. */
export async function keep(files: File[]): Promise<boolean> {
  try {
    const dir = await directory(true);
    if (!dir) return false;
    let next = (await storedNames(dir)).length;
    for (const file of files) {
      const name = `${String(next++).padStart(4, '0')}-${file.name}`;
      const handle = await dir.getFileHandle(name, { create: true });
      // The one way of writing that all three engines have in a worker.
      const access = await handle.createSyncAccessHandle();
      try {
        access.write(new Uint8Array(await file.arrayBuffer()));
        access.flush();
      } finally {
        access.close();
      }
    }
    return true;
  } catch (error) {
    console.warn('The files could not be kept in this browser:', error);
    // Part of a model would come back as if it were all of it.
    await forget().catch(() => {});
    return false;
  }
}

/** `files` in place of the kept ones of their names, as an edit leaves them. Whether all are kept. */
export async function replace(files: File[]): Promise<boolean> {
  try {
    const dir = await directory(false);
    if (!dir) return false;
    const stored = await storedNames(dir);
    for (const file of files) {
      const name = stored.find((n) => n.replace(PREFIX, '') === file.name);
      if (!name) return false;
      const access = await (await dir.getFileHandle(name)).createSyncAccessHandle();
      try {
        access.truncate(0);
        access.write(new Uint8Array(await file.arrayBuffer()), { at: 0 });
        access.flush();
      } finally {
        access.close();
      }
    }
    return true;
  } catch (error) {
    console.warn('The edited files could not be kept in this browser:', error);
    await forget().catch(() => {});
    return false;
  }
}

/** The kept files of these names gone, as undoing the edit that created them leaves them. */
export async function remove(names: string[]): Promise<boolean> {
  try {
    const dir = await directory(false);
    if (!dir) return false;
    for (const stored of await storedNames(dir)) {
      if (names.includes(stored.replace(PREFIX, ''))) await dir.removeEntry(stored);
    }
    return true;
  } catch (error) {
    console.warn('The files could not be kept in this browser:', error);
    await forget().catch(() => {});
    return false;
  }
}

/** What is kept, in the order it came, under the names it came with. */
export async function kept(): Promise<File[]> {
  try {
    const dir = await directory(false);
    if (!dir) return [];
    const files: File[] = [];
    for (const name of await storedNames(dir)) {
      const file = await (await dir.getFileHandle(name)).getFile();
      files.push(new File([file], name.replace(PREFIX, '')));
    }
    return files;
  } catch {
    return [];
  }
}

export async function forget(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIRECTORY, { recursive: true }).catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  });
}
