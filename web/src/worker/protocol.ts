/** What passes between the page and the worker holding the model. */

import type { Findings, Grid, Inside, Reveal } from '../grid/model';

export type FileOutcome =
  | { status: 'loaded'; name: string; objects: number }
  | { status: 'skipped'; name: string; reason: string };

/** gridox-wasm's `Summary`. */
export interface Summary {
  files: FileOutcome[];
  objects: number;
  foreign: number;
  classes: { class: string; objects: number }[];
}

/** The model after files came or went, and whether its files are kept in this browser. */
export interface Loaded {
  summary: Summary;
  kept: boolean;
}

export type Severity = 'violation' | 'warning' | 'info';

/** The checks beyond each profile's own: `cimcli validate --common` and `--quality`. */
export interface Checks {
  common: boolean;
  quality: boolean;
}

/** What validation found, by severity and by rule, worst first. */
export interface FindingsSummary extends Findings, Checks {
  files: string[];
  rules: { rule: string; name: string; severity: Severity; description: string; count: number }[];
}

/** One finding of a rule. `file`: the file it was found in, when it is that file's alone. */
export interface Finding {
  object: string;
  label: string | null;
  class: string;
  property: string;
  message: string;
  file: string | null;
}

/** A finding on an object. */
export interface ObjectFinding {
  rule: string;
  name: string;
  severity: Severity;
  property: string;
  message: string;
}

/** A node of the tree, as cimoxide-view answers. */
export interface TreeEntry {
  key: string;
  kind: 'section' | 'group' | 'range' | 'object' | 'missing';
  label: string;
  class?: string;
  id?: string;
  children: number;
  findings: Findings;
  grid?: Reveal | null;
}

export interface SearchHit {
  id: string;
  label: string;
  class: string;
  place: string;
}

export interface ObjectValue {
  text: string;
  /** The object it refers to, if the set has it. */
  ref?: string;
}

export interface ObjectFields {
  id: string;
  class: string;
  label: string | null;
  fields: { key: string; values: ObjectValue[] }[];
  grid: Reveal | null;
  findings: ObjectFinding[];
}

/** Each request, by kind. */
export type Request =
  | { kind: 'load'; files: File[] }
  | { kind: 'restore' }
  | { kind: 'clear' }
  | { kind: 'grid' }
  | { kind: 'inside'; id: string }
  | { kind: 'children'; key: string | null; onlyFindings: boolean }
  | { kind: 'search'; query: string }
  | { kind: 'path'; id: string; onlyFindings: boolean }
  | { kind: 'object'; id: string }
  | ({ kind: 'validate' } & Checks)
  | { kind: 'findings'; rule: string };

/** What each kind of request answers. */
export interface Answers {
  load: Loaded;
  restore: Loaded;
  clear: Loaded;
  grid: Grid;
  inside: Inside | null;
  children: TreeEntry[] | null;
  search: SearchHit[];
  path: string[] | null;
  object: ObjectFields | null;
  validate: FindingsSummary;
  findings: Finding[];
}

export type Envelope = { id: number; request: Request };

/** A grid can be megabytes: it crosses as text, parsed once, on the side that wants it. */
export type Reply = { id: number; ok: true; json: string } | { id: number; ok: false; error: string };
