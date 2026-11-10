/** What passes between the page and the worker holding the model. */

import type { Grid, Inside, Reveal } from '../grid/model';

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

/** A node of the tree, as cimoxide-view answers. */
export interface TreeEntry {
  key: string;
  kind: 'section' | 'group' | 'range' | 'object' | 'missing';
  label: string;
  class?: string;
  id?: string;
  children: number;
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
}

/** Each request, by kind. */
export type Request =
  | { kind: 'load'; files: File[] }
  | { kind: 'restore' }
  | { kind: 'clear' }
  | { kind: 'grid' }
  | { kind: 'inside'; id: string }
  | { kind: 'children'; key: string | null }
  | { kind: 'search'; query: string }
  | { kind: 'path'; id: string }
  | { kind: 'object'; id: string };

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
}

export type Envelope = { id: number; request: Request };

/** A grid can be megabytes: it crosses as text, parsed once, on the side that wants it. */
export type Reply = { id: number; ok: true; json: string } | { id: number; ok: false; error: string };
