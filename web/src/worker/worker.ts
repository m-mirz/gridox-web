/// <reference lib="webworker" />
/** Holds the model and does the work, so the page stays responsive whatever a file costs. */

import init, { Session } from '../wasm/gridox_wasm';
import type { Envelope, Reply, Request, Summary } from './protocol';

let session: Session;
const ready = init().then(() => {
  session = new Session();
});

async function handle(request: Request): Promise<Summary> {
  await ready;
  switch (request.kind) {
    case 'clear':
      session.free();
      session = new Session();
      break;
    case 'load':
      for (const file of request.files) {
        session.addFile(file.name, await file.text());
      }
      break;
  }
  return JSON.parse(session.summary()) as Summary;
}

self.onmessage = async ({ data: { id, request } }: MessageEvent<Envelope>) => {
  let reply: Reply;
  try {
    reply = { id, ok: true, summary: await handle(request) };
  } catch (error) {
    reply = { id, ok: false, error: String(error) };
  }
  self.postMessage(reply);
};
