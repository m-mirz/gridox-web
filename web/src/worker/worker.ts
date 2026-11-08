/// <reference lib="webworker" />
/** Holds the model and does the work, so the page stays responsive whatever a file costs. */

import init, { Session } from '../wasm/gridox_wasm';
import type { Envelope, FileOutcome, Reply, Request } from './protocol';
import { forget, keep, kept } from './store';

let session: Session;
const ready = init().then(() => {
  session = new Session();
});

/** Whether the files of the model are kept in this browser. */
let keeping = false;

function loaded(): string {
  return `{"summary":${session.summary()},"kept":${keeping}}`;
}

async function add(files: File[]): Promise<File[]> {
  const added: File[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      // One file that cannot be read, such as a folder a browser passes as one, leaves the others.
      session.skipFile(file.name, `it could not be read (${error})`);
      continue;
    }
    session.addFile(file.name, text);
    const outcomes = JSON.parse(session.summary()).files as FileOutcome[];
    if (outcomes[outcomes.length - 1].status === 'loaded') added.push(file);
  }
  return added;
}

async function handle(request: Request): Promise<string> {
  await ready;
  switch (request.kind) {
    case 'load': {
      const added = await add(request.files);
      if (added.length) keeping = await keep(added);
      return loaded();
    }
    case 'restore': {
      const added = await add(await kept());
      keeping = added.length > 0;
      return loaded();
    }
    case 'clear':
      session.free();
      session = new Session();
      keeping = false;
      await forget().catch(() => {});
      return loaded();
    case 'grid':
      return session.grid();
    case 'inside':
      return session.inside(request.id);
    case 'children':
      return session.children(request.key ?? undefined);
    case 'search':
      return session.search(request.query);
    case 'path':
      return session.path(request.id);
    case 'object':
      return session.object(request.id);
  }
}

self.onmessage = async ({ data: { id, request } }: MessageEvent<Envelope>) => {
  let reply: Reply;
  try {
    reply = { id, ok: true, json: await handle(request) };
  } catch (error) {
    reply = { id, ok: false, error: String(error) };
  }
  self.postMessage(reply);
};
