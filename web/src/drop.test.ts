import { describe, expect, it } from 'vitest';
import { droppedFiles } from './drop';

const file = (name: string) => ({ name }) as File;

function fileEntry(path: string): FileSystemFileEntry {
  const name = path.split('/').pop() as string;
  return {
    name,
    fullPath: path,
    isDirectory: false,
    isFile: true,
    file: (ok: (f: File) => void) => ok(file(name)),
  } as unknown as FileSystemFileEntry;
}

/** A folder that gives its entries in batches of two, as the browser does in larger ones. */
function folder(path: string, entries: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    name: path.split('/').pop(),
    fullPath: path,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      const left = [...entries];
      return { readEntries: (ok: (batch: FileSystemEntry[]) => void) => ok(left.splice(0, 2)) };
    },
  } as unknown as FileSystemDirectoryEntry;
}

const item = (entry: FileSystemEntry | null, f: File | null = null) => ({
  kind: 'file',
  webkitGetAsEntry: () => entry,
  getAsFile: () => f,
});

const transfer = (items: unknown[], files: File[] = []) => ({ items, files }) as unknown as DataTransfer;
const names = (files: File[]) => files.map((f) => f.name);

describe('droppedFiles', () => {
  it('takes files as they are, whatever their name', async () => {
    const a = file('a.xml');
    const b = file('notes.txt');
    expect(names(await droppedFiles(transfer([item(fileEntry('/a.xml'), a), item(fileEntry('/notes.txt'), b)])))).toEqual(['a.xml', 'notes.txt']);
  });

  it('takes a file that has no entry', async () => {
    expect(names(await droppedFiles(transfer([item(null, file('a.xml'))])))).toEqual(['a.xml']);
  });

  it('opens a folder: its XML, in every batch and subfolder, by path', async () => {
    const dir = folder('/m', [
      fileEntry('/m/c.xml'),
      fileEntry('/m/README.adoc'),
      folder('/m/sub', [fileEntry('/m/sub/b.XML')]),
      fileEntry('/m/a.xml'),
    ]);
    expect(names(await droppedFiles(transfer([item(dir)])))).toEqual(['a.xml', 'c.xml', 'b.XML']);
  });

  it('has nothing for what is not files', async () => {
    const uri = { kind: 'string', webkitGetAsEntry: () => null, getAsFile: () => null };
    expect(await droppedFiles(transfer([uri]))).toEqual([]);
    expect(await droppedFiles(transfer([]))).toEqual([]);
  });

  it('falls back on the list of files', async () => {
    expect(names(await droppedFiles(transfer([], [file('a.xml')])))).toEqual(['a.xml']);
  });
});
