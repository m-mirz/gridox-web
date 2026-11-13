/**
 * The XML files in zip archives, as CGMES and NC test sets come, read with the browser's own
 * inflater (`DecompressionStream`), so no library is needed. A zip in a zip is opened too. Entries
 * are in path order, as a folder's files are: the order decides what a merge keeps.
 */

/** What reading the files came to: the files to load, and the archives that could not be read. */
export interface Unzipped {
  files: File[];
  failed: { name: string; reason: string }[];
}

const isZip = (name: string) => name.toLowerCase().endsWith('.zip');
const isXml = (name: string) => name.toLowerCase().endsWith('.xml');

/** `files`, each zip archive in it replaced by the XML files it holds. */
export async function unzipped(files: File[]): Promise<Unzipped> {
  const out: Unzipped = { files: [], failed: [] };
  for (const file of files) {
    if (!isZip(file.name)) {
      out.files.push(file);
      continue;
    }
    try {
      out.files.push(...(await xmlInZip(file)));
    } catch (error) {
      out.failed.push({ name: file.name, reason: `the archive could not be read (${error instanceof Error ? error.message : error})` });
    }
  }
  return out;
}

/** The XML files of an archive, those of the archives in it too. */
async function xmlInZip(zip: Blob): Promise<File[]> {
  const found: File[] = [];
  for (const entry of await entries(zip)) {
    if (isXml(entry.path)) found.push(new File([await entry.read()], basename(entry.path), { type: 'application/xml' }));
    else if (isZip(entry.path)) found.push(...(await xmlInZip(new Blob([await entry.read()]))));
  }
  return found;
}

const basename = (path: string) => path.split('/').pop() as string;

interface Entry {
  path: string;
  read: () => Promise<ArrayBuffer>;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** An archive's files, by its central directory, in path order. */
async function entries(zip: Blob): Promise<Entry[]> {
  // The end of central directory record: the last 22 bytes, after a comment of up to 64 KB.
  const tailStart = Math.max(0, zip.size - 22 - 0xffff);
  const tail = new DataView(await zip.slice(tailStart).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('a Zip64 archive, which this does not read');
  const directory = new DataView(await zip.slice(offset, offset + size).arrayBuffer());
  const names = new TextDecoder();
  const found: Entry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (directory.getUint32(at, true) !== CENTRAL) throw new Error('a broken central directory');
    const flags = directory.getUint16(at + 8, true);
    const method = directory.getUint16(at + 10, true);
    const compressed = directory.getUint32(at + 20, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const local = directory.getUint32(at + 42, true);
    const path = names.decode(new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/') || path.startsWith('__MACOSX/')) continue;
    if (flags & 1) throw new Error(`${path} is encrypted`);
    if (method !== 0 && method !== 8) throw new Error(`${path} is compressed with method ${method}, which this does not read`);
    found.push({
      path,
      read: async () => {
        const header = new DataView(await zip.slice(local, local + 30).arrayBuffer());
        if (header.getUint32(0, true) !== LOCAL) throw new Error(`${path}: a broken local header`);
        const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const data = zip.slice(start, start + compressed);
        if (method === 0) return data.arrayBuffer();
        return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      },
    });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
