/// <reference lib="webworker" />
/** Holds the model and does the work, so the page stays responsive whatever a file costs. */

import init, { Session } from '../wasm/gridox_wasm';
import type { Envelope, FileOutcome, Reply, Request } from './protocol';
import { forget, keep, keepMeta, kept, keptMeta, remove, replace } from './store';
import { unzipped } from '../zip';

let session: Session;
const ready = init().then(() => {
  session = new Session();
});

/** Whether the files of the model are kept in this browser. */
let keeping = false;
/** The files loaded, in the order they came, for validation to read again. */
let files: File[] = [];
/** Each file's path in the folder or archive it came from, by name. */
let paths: Record<string, string> = {};
/** The files loaded but left out of the model, by name. */
let excluded: string[] = [];

function loaded(): string {
  return `{"summary":${session.summary()},"kept":${keeping},"paths":${JSON.stringify(paths)}}`;
}

async function keepAbout() {
  if (keeping) await keepMeta({ paths, excluded });
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

/** After an edit: the files it changed, as they are now, in place of the ones loaded and kept. */
async function edited(reply: string): Promise<string> {
  const { changed, removed = [] } = JSON.parse(reply) as { changed: string[]; removed?: string[] };
  const fresh: File[] = [];
  const created: File[] = [];
  for (const name of changed) {
    const text = session.fileText(name);
    if (text === undefined) continue;
    const file = new File([text], name, { type: 'application/rdf+xml' });
    const at = files.findIndex((f) => f.name === name);
    if (at < 0) {
      // A file the edit created.
      files.push(file);
      created.push(file);
    } else {
      files[at] = file;
      fresh.push(file);
    }
  }
  files = files.filter((f) => !removed.includes(f.name));
  if (keeping && fresh.length) keeping = await replace(fresh);
  if (keeping && created.length) keeping = await keep(created);
  if (keeping && removed.length) keeping = await remove(removed);
  return reply;
}

async function handle(request: Request): Promise<string> {
  await ready;
  switch (request.kind) {
    case 'load': {
      // A zip's XML files in its place: they, not the archive, are what is kept.
      const { files: opened, paths: at, failed } = await unzipped(request.files, request.paths ?? []);
      for (const { name, reason } of failed) session.skipFile(name, reason);
      const added = await add(opened);
      for (const file of added) paths[file.name] = at[opened.indexOf(file)] ?? file.name;
      files.push(...added);
      if (added.length) keeping = await keep(added);
      await keepAbout();
      return loaded();
    }
    case 'restore': {
      const added = await add(await kept());
      files = added;
      keeping = added.length > 0;
      ({ paths, excluded } = await keptMeta());
      excluded = excluded.filter((name) => added.some((f) => f.name === name));
      if (excluded.length) session.setExcluded(excluded);
      return loaded();
    }
    case 'clear':
      session.free();
      session = new Session();
      keeping = false;
      files = [];
      paths = {};
      excluded = [];
      await forget().catch(() => {});
      return loaded();
    case 'include':
      excluded = request.excluded.filter((name) => files.some((f) => f.name === name));
      session.setExcluded(excluded);
      await keepAbout();
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
      for (const file of files) {
        if (!excluded.includes(file.name)) session.checkFile(file.name, await file.text());
      }
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
      return session.powerFlow(request.sharing, request.qLimits, request.switches, request.action ?? undefined, request.at ?? undefined);
    case 'analysisStart':
      return session.analysisStart(request.sharing, request.qLimits, request.switches, request.curative, request.at ?? undefined);
    case 'scheduleTimes':
      return session.scheduleTimes();
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
    case 'summary':
      return loaded();
    case 'editState':
      return session.editState();
    case 'fileText':
      return JSON.stringify(session.fileText(request.name) ?? null);
    case 'editUndo':
      return edited(session.editUndo());
    case 'editRename':
      return edited(session.editRename(request.old, request.new));
    case 'editDeletePreview':
      return session.editDeletePreview(request.id, request.contained);
    case 'editDelete':
      return edited(session.editDelete(request.id, request.contained));
    case 'editAddable':
      return session.editAddable(request.parent);
    case 'editAdd':
      // Its identifier: a version 4 UUID from these, drawn again while the set has it.
      return edited(session.editAdd(request.parent, request.class, request.name ?? undefined, crypto.getRandomValues(new Uint8Array(160))));
    case 'editSet':
      return edited(session.editSet(request.id, request.key, request.value));
    case 'editRemove':
      return edited(session.editRemove(request.id, request.key));
    case 'editForm':
      return session.editForm(request.id);
    case 'editCandidates':
      return session.editCandidates(request.id, request.key);
    case 'editFixes':
      return session.editFixes(request.id);
    case 'editApply':
      return edited(session.editApply(request.revision, JSON.stringify(request.edits)));
    case 'editCounterProposal':
      return edited(session.editCounterProposal(request.refused, request.responding ?? undefined, crypto.getRandomValues(new Uint8Array(160))));
    case 'editGuided':
      return session.editGuided(request.id);
    case 'editContingencyAdd':
      return edited(session.editContingencyAdd(request.contingency, request.equipment, crypto.getRandomValues(new Uint8Array(160))));
    case 'editEnabling':
      return edited(session.editEnabling(request.schedule, request.at, request.enabled, crypto.getRandomValues(new Uint8Array(160))));
    case 'editResponders':
      return session.editResponders();
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
    // The model's files: those left out of it are not another worker's to load.
    const model = () => files.filter((f) => !excluded.includes(f.name));
    reply = { id, ok: true, json: await handle(request), ...(request.kind === 'files' ? { files: model() } : {}) };
  } catch (error) {
    reply = { id, ok: false, error: String(error) };
  }
  self.postMessage(reply);
};
