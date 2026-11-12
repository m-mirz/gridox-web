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
/** The files loaded, in the order they came, for validation to read again. */
let files: File[] = [];

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
      files.push(...added);
      if (added.length) keeping = await keep(added);
      return loaded();
    }
    case 'restore': {
      const added = await add(await kept());
      files = added;
      keeping = added.length > 0;
      return loaded();
    }
    case 'clear':
      session.free();
      session = new Session();
      keeping = false;
      files = [];
      await forget().catch(() => {});
      return loaded();
    case 'grid':
      return session.grid();
    case 'inside':
      return session.inside(request.id);
    case 'children':
      return session.children(request.key ?? undefined, request.onlyFindings);
    case 'search':
      return session.search(request.query);
    case 'path':
      return session.path(request.id, request.onlyFindings);
    case 'object':
      return session.object(request.id);
    case 'validate':
      for (const file of files) session.checkFile(file.name, await file.text());
      return session.validate(request.common, request.quality);
    case 'findings':
      return session.findingsOf(request.rule);
    case 'datasets':
      return session.datasets();
    case 'contingencies':
      return session.contingencies();
    case 'assessedElements':
      return session.assessedElements();
    case 'remedialActions':
      return session.remedialActions();
    case 'schedules':
      return session.schedules();
    case 'powerFlow':
      return session.powerFlow(request.sharing, request.qLimits);
    case 'analysisStart':
      return session.analysisStart(request.sharing, request.qLimits);
    case 'analysisStep':
      return session.analysisStep(request.count);
    case 'analysisResult':
      return session.analysisResult();
    case 'analysisViolations':
      return session.analysisViolations(request.contingency ?? undefined, request.terminal ?? undefined);
    case 'sarDefaults':
      return session.sarDefaults();
    case 'sar':
      // Every reply is JSON: the XML as a JSON string.
      return JSON.stringify(session.sar(JSON.stringify(request.header)));
    case 'sarResults':
      return session.sarResults();
    case 'analysisRange':
      return session.analysisRange(request.from, request.to);
    case 'analysisPart':
      return session.analysisPart(request.from, request.to);
    case 'analysisAbsorb':
      return session.analysisAbsorb(JSON.stringify(request.part));
    case 'files':
      // Sent beside the reply, as files do not go into JSON.
      return 'null';
    case 'loadOnly': {
      // Another worker's model, for a share of its work: nothing is kept for it.
      files = await add(request.files);
      return loaded();
    }
  }
}

self.onmessage = async ({ data: { id, request } }: MessageEvent<Envelope>) => {
  let reply: Reply;
  try {
    reply = { id, ok: true, json: await handle(request), ...(request.kind === 'files' ? { files } : {}) };
  } catch (error) {
    reply = { id, ok: false, error: String(error) };
  }
  self.postMessage(reply);
};
