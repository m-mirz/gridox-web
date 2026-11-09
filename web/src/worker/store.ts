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

async function names(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const found: string[] = [];
  // @ts-expect-error TypeScript's DOM library lacks the directory's iterator.
  for await (const name of dir.keys()) found.push(name as string);
  return found.sort();
}

/** Keeps `files` after those kept already. Whether every file is kept: none are, otherwise. */
export async function keep(files: File[]): Promise<boolean> {
  try {
    const dir = await directory(true);
    if (!dir) return false;
    let next = (await names(dir)).length;
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

/** What is kept, in the order it came, under the names it came with. */
export async function kept(): Promise<File[]> {
  try {
    const dir = await directory(false);
    if (!dir) return [];
    const files: File[] = [];
    for (const name of await names(dir)) {
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
