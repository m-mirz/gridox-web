/**
 * A model folder opened with the File System Access API, so that edits can be saved back into the
 * files they were made to. Chromium has it; elsewhere `supported` is false and edited files are
 * downloaded. The folder, its files' handles and when each was last modified on disk are kept in
 * IndexedDB, so that after a reload it can be reconnected with one click.
 *
 * Saving compares, for each file the folder gave, the model's text with the file on disk: what
 * differs is ours to write, unless the file changed on disk since it was read, which is left alone.
 * A file an edit created goes into the folder, unless something there has its name already.
 */

/** File System Access API methods TypeScript's DOM library lacks. */
type Permission = 'granted' | 'denied' | 'prompt';
interface Handle extends FileSystemHandle {
  queryPermission(options: { mode: 'readwrite' }): Promise<Permission>;
  requestPermission(options: { mode: 'readwrite' }): Promise<Permission>;
}
interface Directory extends FileSystemDirectoryHandle {
  values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
}

export const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** A file the folder gave, by the name the model knows it by. */
interface Entry {
  /** Its path in the folder. */
  path: string;
  handle: FileSystemFileHandle;
  /** When it was last modified on disk, as read or as written by us. */
  lastModified: number;
  /** Another file of the folder has its name: the model cannot tell them apart, so it is never written. */
  ambiguous: boolean;
}

interface Kept {
  root: FileSystemDirectoryHandle;
  entries: Record<string, Entry>;
}

/** The folder, if one is open or remembered; `connected` once writing to it is allowed. */
export const folder = $state<{ root: FileSystemDirectoryHandle | null; entries: Record<string, Entry>; connected: boolean }>({
  root: null,
  entries: {},
  connected: false,
});

const DB = 'cimlens-folder';
const STORE = 'folder';
const KEY = 'current';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function stored<T>(action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await database();
  try {
    // Done once the transaction commits, not when the request succeeds: a reload in between undoes it.
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onerror = () => reject(transaction.error ?? request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
    });
  } finally {
    db.close();
  }
}

/** Keeps the folder for the next visit. Failing that, it is open for this one only. */
async function persist() {
  if (!folder.root) return;
  const kept: Kept = { root: folder.root, entries: $state.snapshot(folder.entries) as Record<string, Entry> };
  try {
    await stored((s) => s.put(kept, KEY));
  } catch {
    // Private windows may refuse IndexedDB.
  }
}

/** The folder of the last visit, if there was one: connected if the browser still allows writing. */
export async function remembered(): Promise<void> {
  if (!supported) return;
  try {
    const kept = await stored<Kept | undefined>((s) => s.get(KEY));
    if (!kept) return;
    folder.root = kept.root;
    folder.entries = kept.entries;
    folder.connected = (await (kept.root as unknown as Handle).queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    // Nothing remembered, or nothing that can still be used.
  }
}

/** Asks again to write to the remembered folder: a click must lead here. */
export async function reconnect(): Promise<boolean> {
  if (!folder.root) return false;
  folder.connected = (await (folder.root as unknown as Handle).requestPermission({ mode: 'readwrite' })) === 'granted';
  return folder.connected;
}

/** No folder: nothing will be written, and nothing remembered. */
export async function forget(): Promise<void> {
  folder.root = null;
  folder.entries = {};
  folder.connected = false;
  try {
    await stored((s) => s.delete(KEY));
  } catch {
    // Nothing kept.
  }
}

/** The XML files and zip archives of `root`, in its subfolders too, with their paths. */
async function walk(root: FileSystemDirectoryHandle): Promise<{ path: string; handle: FileSystemFileHandle }[]> {
  const found: { path: string; handle: FileSystemFileHandle }[] = [];
  const into = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    for await (const handle of (dir as Directory).values()) {
      const path = `${prefix}${handle.name}`;
      if (handle.kind === 'directory') await into(handle as FileSystemDirectoryHandle, `${path}/`);
      else if (/\.(xml|zip)$/i.test(handle.name)) found.push({ path, handle: handle as FileSystemFileHandle });
    }
  };
  await into(root, '');
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A folder chosen to edit in place: its XML files and zip archives in path order, as the folder
 * input gives them, to load. Its XML files are the ones saved back; a zip's are only downloaded.
 * Null if the choice was cancelled.
 */
export async function open(): Promise<{ files: File[]; paths: string[] } | null> {
  let root: FileSystemDirectoryHandle;
  try {
    // @ts-expect-error Not in TypeScript's DOM library.
    root = await window.showDirectoryPicker({ id: 'cimlens-model', mode: 'readwrite' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
  const found = await walk(root);
  const files: File[] = [];
  const paths: string[] = [];
  const entries: Record<string, Entry> = {};
  const seen = new Map<string, number>();
  for (const { path, handle } of found) {
    const file = await handle.getFile();
    files.push(file);
    paths.push(`${root.name}/${path}`);
    if (!/\.xml$/i.test(handle.name)) continue;
    seen.set(handle.name, (seen.get(handle.name) ?? 0) + 1);
    entries[handle.name] = { path, handle, lastModified: file.lastModified, ambiguous: false };
  }
  for (const [name, n] of seen) if (n > 1) entries[name].ambiguous = true;
  folder.root = root;
  folder.entries = entries;
  folder.connected = true;
  await persist();
  return { files, paths };
}

/** What saving would do to a file. */
export interface Planned {
  name: string;
  /** `overwrite` and `create` are written; the rest are said why not. */
  action: 'overwrite' | 'create' | 'changed on disk' | 'exists' | 'ambiguous';
}

/**
 * What saving the model's files into the folder would do: `names` are the model's files, `text`
 * gives one as it is now, `created` those an edit made. Files that are as on disk are left out.
 */
export async function plan(names: string[], text: (name: string) => Promise<string | null>, created: Set<string>): Promise<Planned[]> {
  const root = folder.root;
  if (!root) return [];
  const out: Planned[] = [];
  for (const name of names) {
    const entry = folder.entries[name];
    if (entry) {
      const now = await text(name);
      if (now === null) continue;
      if (entry.ambiguous) {
        out.push({ name, action: 'ambiguous' });
        continue;
      }
      const disk = await entry.handle.getFile();
      if ((await disk.text()) === now) continue;
      out.push({ name, action: disk.lastModified !== entry.lastModified ? 'changed on disk' : 'overwrite' });
    } else if (created.has(name)) {
      let exists = true;
      try {
        await root.getFileHandle(name);
      } catch {
        exists = false;
      }
      out.push({ name, action: exists ? 'exists' : 'create' });
    }
  }
  return out;
}

/** Writes what `planned` says to write; what each file is on disk then is what is kept of it. */
export async function write(planned: Planned[], text: (name: string) => Promise<string | null>): Promise<number> {
  const root = folder.root;
  if (!root) return 0;
  let written = 0;
  for (const { name, action } of planned) {
    if (action !== 'overwrite' && action !== 'create') continue;
    const now = await text(name);
    if (now === null) continue;
    const handle = action === 'create' ? await root.getFileHandle(name, { create: true }) : folder.entries[name].handle;
    const writable = await handle.createWritable();
    await writable.write(now);
    await writable.close();
    const path = folder.entries[name]?.path ?? name;
    folder.entries[name] = { path, handle, lastModified: (await handle.getFile()).lastModified, ambiguous: false };
    written += 1;
  }
  await persist();
  return written;
}
