/** What passes between the page and the worker holding the model. */

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

export type Request = { kind: 'load'; files: File[] } | { kind: 'clear' };

export type Envelope = { id: number; request: Request };

export type Reply = { id: number; ok: true; summary: Summary } | { id: number; ok: false; error: string };
