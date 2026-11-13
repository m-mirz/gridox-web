/** What a drop on the page holds, folders opened. */

/** Everything in a folder, however many batches it comes in; the browser gives some 100 at a time. */
async function entriesOf(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** A folder's XML files and zip archives, in its subfolders too, by path. A model's folder also holds what is not one. */
async function xmlIn(directory: FileSystemDirectoryEntry): Promise<{ path: string; file: File }[]> {
  const found: { path: string; file: File }[] = [];
  const walk = async (folder: FileSystemDirectoryEntry) => {
    for (const entry of await entriesOf(folder)) {
      if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry);
      else if (/\.(xml|zip)$/i.test(entry.name)) {
        found.push({ path: entry.fullPath, file: await fileOf(entry as FileSystemFileEntry) });
      }
    }
  };
  await walk(directory);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found.map(({ path, file }) => ({ path: path.replace(/^\//, ''), file }));
}

/**
 * The files of a drop, each folder's in place of it. Files dropped as such all count, whatever their
 * name: what cannot be used is then reported. Empty if what was dragged is not files, as from an
 * editor, which may give only their addresses.
 */
export async function droppedFiles(transfer: DataTransfer): Promise<{ files: File[]; paths: string[] }> {
  // A drop's items are gone once the event is over, so all of them are taken before anything waits.
  const taken = [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => ({ entry: item.webkitGetAsEntry(), file: item.getAsFile() }));
  if (!taken.length) return { files: [...transfer.files], paths: [...transfer.files].map((f) => f.name) };
  const found = (
    await Promise.all(
      taken.map(async ({ entry, file }) =>
        entry?.isDirectory ? xmlIn(entry as FileSystemDirectoryEntry) : file ? [{ path: file.name, file }] : [],
      ),
    )
  ).flat();
  return { files: found.map((f) => f.file), paths: found.map((f) => f.path) };
}
