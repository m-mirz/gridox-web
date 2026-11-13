/**
 * An example model to load without files of one's own: ReliCapGrid, ENTSO-E's test configuration,
 * fetched when asked from its own repository at a fixed commit, so the site ships none of it. Its
 * licence, CC BY-SA 4.0, asks for the attribution `ATTRIBUTION` gives, shown wherever it is loaded.
 */
import files from './example-files.json';

export const REPOSITORY = 'https://github.com/entsoe/relicapgrid';
export const COMMIT = 'f09bb340795122b43d6499e913c121bb21458859';
/** Where the files are fetched from: GitHub's raw files, which any site may fetch. */
export const RAW = `https://raw.githubusercontent.com/entsoe/relicapgrid/${COMMIT}/Instance`;
/** The folder the files are loaded under, which marks them as the example. */
export const FOLDER = 'ReliCapGrid';
export const LICENSE = 'https://creativecommons.org/licenses/by-sa/4.0/';
export const ATTRIBUTION = 'ReliCapGrid © ENTSO-E, under CC BY-SA 4.0';
export const FILES: string[] = files;
/** About how much is downloaded: the instance's XML, in megabytes. */
export const MEGABYTES = 26;

/**
 * The instance's files, fetched a few at a time; `progress` hears of each one done. Their paths
 * are under `FOLDER`, as a folder of them would give.
 */
export async function fetchExample(
  progress: (done: number, total: number) => void,
  fetcher: typeof fetch = fetch,
): Promise<{ files: File[]; paths: string[] }> {
  const out: File[] = new Array(FILES.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (let i = next++; i < FILES.length; i = next++) {
      const path = FILES[i];
      const response = await fetcher(`${RAW}/${path.split('/').map(encodeURIComponent).join('/')}`);
      if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
      out[i] = new File([await response.blob()], path.split('/').pop()!, { type: 'application/xml' });
      progress(++done, FILES.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { files: out, paths: FILES.map((p) => `${FOLDER}/${p}`) };
}
