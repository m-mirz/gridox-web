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

/** An object linked to from a table: `missing` if the set lacks it. */
export interface Linked {
  id: string;
  label: string | null;
  class: string | null;
  missing?: boolean;
  /** The link's own: a contingent status, a combination's kind. */
  status?: string | null;
  kind?: string | null;
}

export interface Contingency {
  id: string;
  label: string | null;
  class: string;
  mustStudy: string | null;
  equipment: Linked[];
  assessed: Linked[];
  grid: Reveal[];
}

export interface AssessedElement {
  id: string;
  label: string | null;
  inBaseCase: string | null;
  normalEnabled: string | null;
  securedFor: Linked | null;
  scannedFor: Linked | null;
  exclusionReason: string | null;
  combinableWithContingency: string | null;
  combinableWithRemedialAction: string | null;
  assesses: Linked | null;
  limit: Linked | null;
  schedules: Linked[];
  contingencies: Linked[];
  remedialActions: Linked[];
  grid: Reveal[];
}

/** What applying a remedial action does to a switch: `open` as the model has it, `openAfter` as applied. */
export interface SwitchState extends Linked {
  open: string | null;
  openAfter: boolean | null;
  changes: boolean | null;
}

export interface RemedialAction {
  id: string;
  label: string | null;
  class: string;
  kind: string | null;
  available: string | null;
  alterations: {
    id: string;
    class: string;
    label: string | null;
    target: Linked | null;
    enabled: string | null;
    values: { property: string | null; valueKind: string | null; direction: string | null; value: string | null }[];
  }[];
  dependencies: { id: string; kind: string | null; group: Linked | null; with: Linked[] }[];
  applied: SwitchState[];
  grid: Reveal[];
}

/** A value an object writes of its own: `time` when it is a date and time. */
export interface Written {
  key: string;
  value: string;
  time: boolean;
}

/** A schedule, with what holds between its time points (`previous`, `next`, `linear`, `zero`, `none`). */
export interface Schedule extends Linked {
  interpolation: string | null;
  values: Written[];
  /** The schedules of its group it refers to, by field. */
  links: Linked[];
  points: { id: string; atTime: string | null; values: Written[] }[];
}

/** Schedules that refer to one another, with what they refer to and what refers to them. */
export interface ScheduleGroup {
  id: string;
  schedules: Schedule[];
  about: Linked[];
  referredBy: Linked[];
  grid: Reveal[];
}

/** Remedial actions depending exclusively on one another, and when more than one is active. */
export interface ExclusiveActions {
  group: Linked;
  /** Each with the schedules giving its activation. */
  actions: (Linked & { schedules: string[] })[];
  together: { at: string; actions: string[] }[];
}

export interface Schedules {
  groups: ScheduleGroup[];
  exclusive: ExclusiveActions[];
}

export type Sharing = 'reference' | 'capability' | 'equal';

/** A connected component's outcome: solved, stopped short, or left unsolved as it has no angle reference or several. */
export type ComponentStatus = 'converged' | 'maxIterations' | 'singular' | 'noReference' | 'ambiguousReference';

/** A power flow of the model, by gridoxide, as its security analysis solves a base case. */
export interface PowerFlow {
  /** `switches`: the buses from the switches as the SSH sets them, not from the TP. */
  options: { sharing: Sharing; qLimits: boolean; switches: boolean };
  /** Why nothing was solved, such as a model without a topology. */
  error: string | null;
  components: {
    status: ComponentStatus;
    /** Topological nodes in it. */
    nodes: number;
    references: Linked[];
    maxMismatch: number | null;
    /** How far from the voltages the model's SV publishes, the angles aligned at its reference. */
    sv: { dvPercent: number; dDeg: number; nodes: number } | null;
  }[];
  nodes: {
    id: string;
    label: string | null;
    component: number | null;
    nominalKV: number;
    /** Absent where its component was not solved. */
    pu: number | null;
    kV: number | null;
    deg: number | null;
    sv: { kV: number; deg: number } | null;
    dvPercent?: number;
    dDeg?: number;
    /** The grid node it is drawn in. */
    at: string | null;
  }[];
  /** Nodes whose machines reactive limits took off voltage control. */
  switched: Linked[];
  /** What the machines' share of the imbalance came to; `null` when the reference took it. */
  sharedMW: number | null;
  pastLimits: (Linked & { mw: number; limit: number })[];
  violations: { terminal: string; equipment: Linked | null; limit: Linked; kind: string; amps: number; limitAmps: number; percent: number }[];
  overlay: FlowOverlay;
  /** A remedial action applied: the action, the switch states it set, and what that changed. */
  action?: Linked;
  actionSwitches?: (Linked & { open: string | null; openAfter: boolean })[];
  compared?: {
    violationsBefore: number;
    violationsAfter: number;
    solvedBefore: number;
    solvedAfter: number;
    largestChange: number | null;
    changed: number;
    most: (Linked & { change: number })[];
  };
}

/** A power flow, by what the grid draws. */
export interface FlowOverlay {
  /** Each grid node's lowest and highest voltage, p.u. */
  nodes: Record<string, { min: number; max: number }>;
  /** By topological and connectivity node. */
  voltages: Record<string, { pu: number; kV: number; deg: number }>;
  /** By equipment: each terminal's flow, `p` and `q` into it (MW, Mvar), and the highest loading against a PATL, %. */
  flows: Record<string, { ends: { terminal: string; p: number; q: number; amps: number; loading: number | null }[]; loading: number | null }>;
}

/** How far an analysis has come; `error` ends it. */
export interface AnalysisProgress {
  error: string | null;
  done?: number;
  total: number;
}

export interface AnalysisViolation {
  contingency: Linked | null;
  terminal: string;
  equipment: Linked | null;
  limit: Linked;
  kind: string;
  amps: number;
  limitAmps: number;
  percent: number;
}

/** A security analysis, by contingency and by element. Percentages are of the limit. */
export interface Analysis {
  options: { sharing: Sharing; qLimits: boolean; switches: boolean };
  scenarioTime: string;
  total: number;
  solved: number;
  /** Contingencies that did not converge: no SAR has a place for them. */
  stalled: Linked[];
  /** Contingencies naming equipment the model lacks. */
  absent: Linked[];
  baseViolations: number;
  violations: number;
  pastLimits: { contingency: Linked | null; machine: Linked; mw: number; limit: number }[];
  requires: string[];
  contingencies: (Linked & {
    equipment: Linked[];
    outcome: 'solved' | 'stalled' | 'absent';
    violations: number;
    worst: number | null;
    grid: Reveal[];
  })[];
  elements: {
    terminal: string;
    equipment: Linked | null;
    contingencies: number;
    worst: number | null;
    worstContingency: Linked | null;
    base: number | null;
    grid: Reveal[];
  }[];
}

export interface SarHeader {
  title: string;
  description: string;
  publisher: string;
  isVersionOf: string;
  rightsHolder: string;
  generatedAt: string;
}

/** A result of a SAR loaded with the model, and the analysis's own for the same, once run. */
export interface SarResult {
  id: string;
  contingency: Linked | null;
  terminal: Linked | null;
  equipment: Linked | null;
  limit: Linked | null;
  isViolation: string | null;
  value: string | null;
  valueA: string | null;
  atTime: string | null;
  ours: number | null;
  analysed: boolean;
}

/** What an edit did: the files it changed, or why it did nothing. */
export interface EditResult {
  error: string | null;
  changed: string[];
  /** Files an undo removed, as the edit undone had created them. */
  removed?: string[];
  revision?: number;
  /** An object added: its mRID. */
  id?: string;
}

export interface EditState {
  /** The files changed since they were loaded. */
  edited: string[];
  /** Edits that can be undone. */
  undo: number;
  revision: number;
}

/** How each field of an object's class is edited. */
export interface EditForm {
  id: string;
  class: string;
  fields: {
    key: string;
    kind: 'literal' | 'reference' | 'enumeration';
    range: string;
    xsd: string;
    values: string[];
    written: boolean;
    comment: string;
  }[];
  revision: number;
}

export interface Candidate {
  id: string;
  label: string;
  class: string;
  place: string;
}

/** Fixes for an object, each its edits by file, for the revision they were made for. */
export interface Fixes {
  revision: number;
  fixes: { title: string; edits: unknown }[];
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
  | { kind: 'datasets' }
  | { kind: 'contingencies' }
  | { kind: 'assessedElements' }
  | { kind: 'remedialActions' }
  | { kind: 'schedules' }
  | { kind: 'powerFlow'; sharing: Sharing; qLimits: boolean; switches: boolean; action: string | null }
  | { kind: 'analysisStart'; sharing: Sharing; qLimits: boolean; switches: boolean }
  | { kind: 'analysisStep'; count: number }
  | { kind: 'analysisRange'; from: number; to: number }
  | { kind: 'analysisPart'; from: number; to: number }
  | { kind: 'analysisAbsorb'; part: unknown }
  | { kind: 'files' }
  | { kind: 'summary' }
  | { kind: 'editState' }
  | { kind: 'fileText'; name: string }
  | { kind: 'editUndo' }
  | { kind: 'editRename'; old: string; new: string }
  | { kind: 'editDeletePreview'; id: string; contained: boolean }
  | { kind: 'editDelete'; id: string; contained: boolean }
  | { kind: 'editAddable'; parent: string }
  | { kind: 'editAdd'; parent: string; class: string; name: string | null }
  | { kind: 'editSet'; id: string; key: string; value: string }
  | { kind: 'editRemove'; id: string; key: string }
  | { kind: 'editForm'; id: string }
  | { kind: 'editCandidates'; id: string; key: string }
  | { kind: 'editFixes'; id: string }
  | { kind: 'editApply'; revision: number; edits: unknown }
  | { kind: 'editCounterProposal'; refused: string; responding: string | null }
  | { kind: 'editResponders' }
  | { kind: 'loadOnly'; files: File[] }
  | { kind: 'analysisResult' }
  | { kind: 'analysisViolations'; contingency: string | null; terminal: string | null }
  | { kind: 'sarDefaults' }
  | { kind: 'sar'; header: SarHeader }
  | { kind: 'sarResults' };

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
  contingencies: Contingency[];
  assessedElements: AssessedElement[];
  remedialActions: RemedialAction[];
  schedules: Schedules;
  powerFlow: PowerFlow;
  analysisStart: AnalysisProgress;
  analysisStep: AnalysisProgress;
  analysisRange: AnalysisProgress;
  /** A part of an analysis, for the worker merging it. */
  analysisPart: { error: string | null; part?: unknown };
  analysisAbsorb: AnalysisProgress;
  /** The files the model was loaded from, for another worker to load. */
  files: File[];
  loadOnly: Loaded;
  summary: Loaded;
  editState: EditState;
  fileText: string | null;
  editUndo: EditResult;
  editRename: EditResult;
  editDeletePreview: { objects: number; references: number; files: string[]; contained: number };
  editDelete: EditResult;
  editAddable: { class: string; key: string; comment: string }[];
  editAdd: EditResult;
  editSet: EditResult;
  editRemove: EditResult;
  editForm: EditForm | null;
  editCandidates: Candidate[];
  editFixes: Fixes;
  editApply: EditResult;
  editCounterProposal: EditResult;
  editResponders: Linked[];
  analysisResult: Analysis | null;
  analysisViolations: AnalysisViolation[];
  sarDefaults: Partial<SarHeader> | null;
  /** The SAR's XML. */
  sar: string;
  sarResults: SarResult[];
}

export type Envelope = { id: number; request: Request };

/** A grid can be megabytes: it crosses as text, parsed once, on the side that wants it. */
export type Reply = { id: number; ok: true; json: string; files?: File[] } | { id: number; ok: false; error: string };
