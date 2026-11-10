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
  /** The object it refers to: one in the set, or, `missing`, one only referred to. */
  ref?: string;
  missing?: boolean;
}

export interface ObjectField {
  key: string;
  values: ObjectValue[];
  /** Whether the class tables declare it for the object's class. */
  declared: boolean;
  /** The vocabulary's description of the attribute. */
  comment: string;
}

/** The objects referring to one, by the field that does. */
export interface Referrers {
  total: number;
  by: { key: string; count: number; objects: { id: string; class: string; label: string | null }[] }[];
}

export interface ObjectFields {
  id: string;
  /** `null` for an object the files only refer to. */
  class: string | null;
  missing?: boolean;
  /** Every class the files write it as, when more than one. */
  types: string[];
  label: string | null;
  /** The vocabulary's description of the class. */
  comment: string;
  /** Whether a file defines it (`rdf:ID`), rather than only describing it (`rdf:about`). */
  defined: boolean;
  fields: ObjectField[];
  grid: Reveal | null;
  findings: ObjectFinding[];
  referrers: Referrers;
  /** Reference data (SKOS, PROV, DCAT, …), outside the CIM class tables. */
  foreign?: boolean;
  /** The files that define it, once validation has read them one by one. */
  definedIn: string[];
}

/** A header's reference, as an object page shows a value. */
export interface HeaderRef {
  key: string;
  values: ObjectValue[];
}

/** The datasets loaded, as validation read them one by one. */
export interface Datasets {
  files: {
    name: string;
    objects: number;
    foreign: number;
    header: { id: string; class: string; profiles: string[]; refs: HeaderRef[] } | null;
  }[];
  /** Objects more than one file defines. */
  twice: { count: number; objects: { id: string; label: string | null; class: string | null; files: string[] }[] };
  /** Objects the files type with unrelated classes. */
  conflicts: { count: number; objects: { id: string; label: string | null; types: string[] }[] };
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
  | { kind: 'findings'; rule: string }
  | { kind: 'datasets' };

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
  datasets: Datasets | null;
}

export type Envelope = { id: number; request: Request };

/** A grid can be megabytes: it crosses as text, parsed once, on the side that wants it. */
export type Reply = { id: number; ok: true; json: string } | { id: number; ok: false; error: string };
