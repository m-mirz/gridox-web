// A grid and a substation as Cytoscape elements and as text, from what cimoxide-view answers. Taken
// from the page of cimoxide's VS Code extension (editors/vscode/src/webview/grid.ts), without
// VS Code's messaging; the drawing itself is in views/GridView.svelte.

import type { ElementDefinition, EdgeSingular } from 'cytoscape';
import type { FlowOverlay } from '../worker/protocol';
import { type Symbol, symbolOf } from './symbols';

export interface Findings {
  violation: number;
  warning: number;
  info: number;
}

export interface GridNode {
  id: string;
  label: string;
  kind: string;
  region: string | null;
  kV: number[];
  equipment: Record<string, number>;
  findings: Findings;
}

export interface GridEdge {
  id: string;
  label: string;
  class: string;
  source: string;
  target: string;
  kV: number | null;
  findings: Findings;
}

/** Positions from one DL diagram or one GL coordinate system, as written. */
export interface Layout {
  id: string;
  name: string;
  kind: "diagram" | "geographic";
  flipY: boolean;
  nodes: Record<string, [number, number]>;
  /** Edge id → its route, from its source's end to its target's. */
  edges: Record<string, [number, number][]>;
}

export interface Grid {
  files: string[];
  nodes: GridNode[];
  edges: GridEdge[];
  elsewhere: Findings;
  layouts: Layout[];
  /** The automatic layout, computed by the server. */
  auto: Layout | null;
}

/** Equipment, or a connectivity node (`junction`), inside a substation. */
export interface Item {
  id: string;
  label: string;
  class: string;
  junction: boolean;
  /** Its voltage level's id. */
  group: string | null;
  open: boolean | null;
  inService: boolean | null;
  /** The other grid nodes the equipment reaches. */
  far: { id: string; label: string; kind: string }[];
  findings: Findings;
}

/** What a substation holds: its items by voltage level, and the terminals linking them. */
export interface Inside {
  id: string;
  label: string;
  region: string | null;
  kV: number[];
  /** Findings on the substation that no item stands for. */
  findings: Findings;
    groups: { id: string; label: string; kV: number | null }[];
  items: Item[];
  links: { id: string; source: string; target: string; connected: boolean | null }[];
  layouts: Layout[];
}

/**
 * Where the grid shows an object, as cimoxide-view says: `select`, the node, edge (`e:<id>`) or item
 * to select; `enter`, the substation it is inside; `inside`, a substation's own id.
 */
export interface Reveal {
  select?: string | null;
  enter?: string;
  inside?: string | null;
}

export type Point = { x: number; y: number };

/** `n thing` or `n things`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

/** `2 violations, 1 warning`; the severities found, worst first. */
export function findingsText(f: Findings): string {
  const parts = [count(f.violation, 'violation'), count(f.warning, 'warning'), `${f.info.toLocaleString('en')} info`];
  const found = [f.violation, f.warning, f.info].map((n, i) => (n ? parts[i] : '')).filter((x) => x);
  return found.length ? found.join(', ') : 'no findings';
}

export function sumFindings(fs: Findings[]): Findings {
  return fs.reduce((a, f) => ({ violation: a.violation + f.violation, warning: a.warning + f.warning, info: a.info + f.info }), {
    violation: 0,
    warning: 0,
    info: 0,
  });
}

/** The grid in a line; with `validated`, its findings, and those of objects it does not draw. */
export function gridSummary(g: Grid, validated = false): string {
  const subs = g.nodes.filter((n) => n.kind === 'Substation').length;
  const shown = `${count(subs, 'substation')}, ${count(g.nodes.length - subs, 'boundary point')}, ${count(g.edges.length, 'connection')}`;
  if (!validated) return shown;
  const on = sumFindings([...g.nodes, ...g.edges].map((x) => x.findings));
  return `${shown} · ${findingsText(on)} · ${findingsText(g.elsewhere)} not on the grid`;
}

export function insideSummary(s: Inside, validated = false): string {
  const equipment = s.items.filter((it) => !it.junction);
  const switches = equipment.filter((it) => it.open !== null);
  const open = switches.filter((it) => it.open).length;
  const shown = `${s.label}: ${equipment.length} equipment, ${count(s.items.length - equipment.length, 'node')}, ` +
    `${count(switches.length, 'switch', 'switches')}${open ? ` (${open} open)` : ''}`;
  return validated ? `${shown} · ${findingsText(sumFindings([s.findings, ...s.items.map((it) => it.findings)]))}` : shown;
}

/** The layout to draw: the one picked, else the TSO's diagram, else the map, else automatic. */
export function choice(layouts: Layout[], picked: string | undefined): string {
  if (picked && (picked === 'auto' || layouts.some((l) => l.id === picked))) return picked;
  return (layouts.find((l) => l.kind === 'diagram') ?? layouts[0])?.id ?? 'auto';
}

export function worst(f: Findings): string {
  return f.violation ? "violation" : f.warning ? "warning" : f.info ? "info" : "none";
}

export function total(f: Findings): number {
  return f.violation + f.warning + f.info;
}

/** The ring grows with the findings: one and forty must not look alike. */
export function ring(f: Findings): number {
  return total(f) ? Math.min(6, 1.5 + Math.log2(total(f))) : 0;
}

/** Voltage bands, coloured as grid maps colour them (in the theme's chart colours). */
export const BANDS: [string, number, string, string][] = [
  ["v300", 300, "--v300", "#e5534b"],
  ["v200", 200, "--v200", "#57ab5a"],
  ["v100", 100, "--v100", "#539bf5"],
  ["v30", 30, "--v30", "#b083f0"],
];

export function band(kV: number | null | undefined): string {
  return kV == null ? "none" : BANDS.find(([, min]) => kV >= min)?.[0] ?? "none";
}

export function gridElements(g: Grid): ElementDefinition[] {
  const nodes = g.nodes.map((n) => {
    const size = Object.values(n.equipment).reduce((a, b) => a + b, 0);
    return {
      group: "nodes" as const,
      data: {
        id: n.id, label: n.label, kind: n.kind === "Substation" ? "substation" : "boundary", sev: worst(n.findings),
        size: Math.min(26, 10 + 2 * Math.sqrt(size)), ring: ring(n.findings), band: band(n.kV[0]),
      },
    };
  });
  const edges = g.edges.map((e) => ({
    group: "edges" as const,
    data: {
      id: `e:${e.id}`, source: e.source, target: e.target, label: e.label, sev: worst(e.findings), band: band(e.kV),
      width: e.kV === null ? 1.2 : e.kV >= 300 ? 2.4 : e.kV >= 200 ? 1.8 : 1.2,
    },
  }));
  return [...nodes, ...edges];
}

/** How an item is drawn: a connectivity node as a dot, a busbar as a bar, the rest as a symbol. */
export function kindOf(it: Item): string {
  if (it.junction) return "junction";
  if (!it.far.length && it.class === "BusbarSection") return "busbar";
  return "symbol";
}

/** An item's symbol: by its class, and a switch by its state; equipment reaching another node, a line. */
export function symbolFor(it: Item, terminals: number): Symbol {
  if (it.far.length) return "line";
  const s = symbolOf(it.class) ?? (it.open !== null ? "breaker" : "other");
  if (s === "breaker") return it.open ? "breakerOpen" : "breaker";
  if (s === "disconnector") return it.open ? "disconnectorOpen" : "disconnector";
  if (s === "transformer" && terminals >= 3) return "transformer3";
  return s;
}

export function insideElements(s: Inside): ElementDefinition[] {
  const kV = new Map(s.groups.map((g) => [g.id, g.kV]));
  const bandOf = new Map(s.items.map((it) => [it.id, it.group ? band(kV.get(it.group)) : "none"]));
  const terminals = new Map<string, number>();
  for (const l of s.links) terminals.set(l.source, (terminals.get(l.source) ?? 0) + 1);
  // Equipment in no voltage level (a line, in its Line): the level of the node it ends at.
  for (const l of s.links) {
    if (bandOf.get(l.source) === "none" && bandOf.get(l.target) !== "none") bandOf.set(l.source, bandOf.get(l.target) as string);
  }
  const groups = s.groups.map((g) => ({
    group: "nodes" as const,
    data: {
      id: `g:${g.id}`, kind: "group", sev: "none", ring: 0, band: band(g.kV),
      // A level is often named by its voltage: "400.0".
      label: g.kV === null ? g.label : Number(g.label) === g.kV ? `${g.kV} kV` : `${g.label} · ${g.kV} kV`,
    },
  }));
  const items = s.items.map((it) => ({
    group: "nodes" as const,
    data: {
      id: it.id, label: it.label, kind: kindOf(it), symbol: symbolFor(it, terminals.get(it.id) ?? 0),
      sev: worst(it.findings), parent: it.group ? `g:${it.group}` : undefined,
      // A transformer joins levels: no one level's colour.
      band: /^transformer/.test(symbolFor(it, terminals.get(it.id) ?? 0)) ? "none" : bandOf.get(it.id),
      ring: ring(it.findings),
    },
    classes: [it.open ? "open" : "", it.inService === false ? "out" : ""].join(" ").trim(),
  }));
  const links = s.links.map((l) => ({
    group: "edges" as const,
    data: { id: `t:${l.id}`, source: l.source, target: l.target, sev: "none", width: 1, band: bandOf.get(l.target) },
    classes: l.connected === false ? "disconnected" : "",
  }));
  return [...groups, ...items, ...links];
}

/** Screen coordinates of a layout's positions and routes, scaled to the scene's size. */
export function place(ids: string[], pairs: [string, string][], l: Layout): { nodes: Map<string, Point>; routes: Map<string, Point[]> } {
  const raw = Object.values(l.nodes);
  let project = (p: [number, number]): Point => ({ x: p[0], y: l.flipY ? -p[1] : p[1] });
  if (l.kind === "geographic") {
    // Longitude shrinks with latitude; north is up.
    const lat = raw.reduce((a, p) => a + p[1], 0) / raw.length;
    const k = Math.cos((lat * Math.PI) / 180);
    project = (p) => ({ x: p[0] * k, y: -p[1] });
  }
  const points = raw.map(project);
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const span = Math.max(Math.max(...points.map((p) => p.x)) - minX, Math.max(...points.map((p) => p.y)) - minY, 1e-9);
  // A few substations in a small scene, so that fitting it to the view makes them large enough to read.
  const scale = Math.max(Math.min(900, 160 * Math.sqrt(ids.length)), 70 * Math.sqrt(ids.length)) / span;
  const screen = (p: [number, number]): Point => {
    const q = project(p);
    return { x: (q.x - minX) * scale, y: (q.y - minY) * scale };
  };
  const nodes = new Map(Object.entries(l.nodes).map(([id, p]) => [id, screen(p)]));
  const routes = new Map(Object.entries(l.edges).map(([id, ps]) => [id, ps.map(screen)]));

  // A node the layout does not place goes among its placed neighbours, else below the rest.
  const neighbours = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }
  let missing = ids.filter((id) => !nodes.has(id));
  for (let round = 0; round < 5 && missing.length; round++) {
    missing.forEach((id, i) => {
      const known = (neighbours.get(id) ?? []).map((n) => nodes.get(n)).filter((p): p is Point => !!p);
      if (known.length) {
        const angle = (i * 2.4) % (2 * Math.PI);
        nodes.set(id, {
          x: known.reduce((a, p) => a + p.x, 0) / known.length + 25 * Math.cos(angle),
          y: known.reduce((a, p) => a + p.y, 0) / known.length + 25 * Math.sin(angle),
        });
      }
    });
    missing = missing.filter((id) => !nodes.has(id));
  }
  const bottom = Math.max(0, ...[...nodes.values()].map((p) => p.y)) + 80;
  missing.forEach((id, i) => nodes.set(id, { x: (i % 20) * 50, y: bottom + Math.floor(i / 20) * 50 }));
  return { nodes, routes };
}

/** Bend an edge along its route: Cytoscape's segment points, relative to the line between its nodes. */
export function route(edge: EdgeSingular, points: Point[]): void {
  const s = edge.source().position();
  const t = edge.target().position();
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const length = Math.hypot(dx, dy);
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  if (points.length < 3 || length < 1e-6) {
    edge.removeStyle();
    return;
  }
  // The route may run from the target's end.
  const ordered = d(points[0], t) < d(points[0], s) ? [...points].reverse() : points;
  const inner = ordered.slice(1, -1);
  const weights = inner.map((p) => ((p.x - s.x) * dx + (p.y - s.y) * dy) / (length * length));
  const distances = inner.map((p) => ((p.y - s.y) * dx - (p.x - s.x) * dy) / length);
  edge.style({
    "curve-style": "segments",
    "edge-distances": "node-position",
    "segment-weights": weights.join(" "),
    "segment-distances": distances.join(" "),
  });
}

/** A voltage's band: within 5 % of nominal, within 10 %, or beyond. */
export function voltageBand(min: number, max: number): 'ok' | 'warn' | 'bad' {
  const off = Math.max(Math.abs(min - 1), Math.abs(max - 1));
  return off <= 0.05 ? 'ok' : off <= 0.1 ? 'warn' : 'bad';
}

/** A loading's band: below 80 % of its PATL, up to it, or past it; `unknown` without a limit. */
export function loadingBand(loading: number | null): 'ok' | 'warn' | 'bad' | 'unknown' {
  return loading === null ? 'unknown' : loading < 80 ? 'ok' : loading <= 100 ? 'warn' : 'bad';
}

/** What a scene's element shows of a power flow: its band, and a line of text. `null` if nothing. */
export function flowOf(id: string, kind: string | undefined, flow: FlowOverlay): { band: string; text: string } | null {
  const pu = (x: number) => x.toFixed(3);
  if (id.startsWith('e:')) {
    const f = flow.flows[id.slice(2).split('#')[0]];
    if (!f) return null;
    const p = Math.max(...f.ends.map((e) => Math.abs(e.p)));
    return { band: loadingBand(f.loading), text: f.loading === null ? `${p.toFixed(0)} MW` : `${f.loading.toFixed(0)} %` };
  }
  if (kind === 'substation' || kind === 'boundary') {
    const v = flow.nodes[id];
    return v ? { band: voltageBand(v.min, v.max), text: v.min === v.max ? `${pu(v.min)} pu` : `${pu(v.min)}–${pu(v.max)} pu` } : null;
  }
  if (kind === 'junction' || kind === 'busbar') {
    const v = flow.voltages[id];
    return v ? { band: voltageBand(v.pu, v.pu), text: `${pu(v.pu)} pu` } : null;
  }
  if (kind === 'symbol') {
    const f = flow.flows[id];
    if (!f) return null;
    const p = Math.max(...f.ends.map((e) => Math.abs(e.p)));
    return { band: loadingBand(f.loading), text: f.loading === null ? `${p.toFixed(0)} MW` : `${f.loading.toFixed(0)} %` };
  }
  return null;
}

/** An element's power flow, as lines of its details. */
export function flowLines(id: string, flow: FlowOverlay): string[] {
  const lines: string[] = [];
  const v = flow.nodes[id] ?? (flow.voltages[id] ? { min: flow.voltages[id].pu, max: flow.voltages[id].pu } : undefined);
  if (v) lines.push(v.min === v.max ? `Voltage ${v.min.toFixed(4)} p.u.` : `Voltage ${v.min.toFixed(4)} to ${v.max.toFixed(4)} p.u.`);
  const f = flow.flows[id];
  for (const [i, e] of (f?.ends ?? []).entries()) {
    const loading = e.loading === null ? '' : `, ${e.loading.toFixed(1)} % of its PATL`;
    lines.push(`End ${i + 1}: ${e.p.toFixed(1)} MW, ${e.q.toFixed(1)} Mvar into it, ${e.amps.toFixed(0)} A${loading}`);
  }
  return lines;
}
