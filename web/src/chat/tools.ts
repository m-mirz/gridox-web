/**
 * What the chat's model may do: read the model the worker holds, and show an object in the page.
 * Nothing here edits. Answers are cut short, as a model reads every token of them: lists keep their
 * first entries and say how many there were.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { WorkerClient } from '../worker/client';
import type { FindingsSummary, Linked, ObjectFields } from '../worker/protocol';

export interface ToolHost {
  client: WorkerClient;
  /** The validation the page last ran, if it has. */
  findings: () => FindingsSummary | null;
  /** Shows an object in Explore: tree, grid and inspector. */
  navigate: (id: string) => void;
}

/** At most `n` of a list, and how many there were. */
function some<T>(list: T[], n: number): { total: number; shown: T[] } {
  return { total: list.length, shown: list.slice(0, n) };
}

const link = (l: Linked | null) => (l ? { id: l.id, label: l.label, class: l.class } : null);

const clip = (text: string, n = 300) => (text.length > n ? `${text.slice(0, n)}…` : text);

function object(o: ObjectFields) {
  return {
    id: o.id,
    class: o.class,
    label: o.label,
    missing: o.missing ?? false,
    description: clip(o.comment),
    fields: o.fields.map((f) => ({
      key: f.key,
      values: f.values.slice(0, 20).map((v) => (v.ref ? { ref: v.ref, text: v.text, missing: v.missing ?? false } : v.text)),
      ...(f.values.length > 20 ? { more: f.values.length - 20 } : {}),
    })),
    findings: o.findings.map((f) => ({ rule: f.rule, severity: f.severity, property: f.property, message: f.message })),
    referrers: {
      total: o.referrers.total,
      by: o.referrers.by.map((b) => ({ key: b.key, count: b.count, first: b.objects.slice(0, 5) })),
    },
    definedIn: o.definedIn,
  };
}

export function chatTools({ client, findings, navigate }: ToolHost) {
  return {
    summary: tool({
      description: 'The files loaded and the model they make: each file, how many objects, and the classes by count.',
      inputSchema: z.object({}),
      execute: async () => {
        const { summary } = await client.request<'summary'>({ kind: 'summary' });
        return {
          files: summary.files,
          objects: summary.objects,
          excluded: summary.excluded,
          classes: some(summary.classes, 40),
        };
      },
    }),

    search: tool({
      description: 'Finds objects by name, mRID or class. Answers up to 25 hits, each with its id.',
      inputSchema: z.object({ query: z.string().describe('Part of a name or an mRID, or a class name such as ACLineSegment') }),
      execute: async ({ query }) => some(await client.request<'search'>({ kind: 'search', query }), 25),
    }),

    object: tool({
      description: "One object by its id (mRID): its class, attributes and references, validation findings on it, and the objects that refer to it.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const found = await client.request<'object'>({ kind: 'object', id });
        return found ? object(found) : { error: `No object ${id}` };
      },
    }),

    validation: tool({
      description: 'What the last validation found: counts by severity, and each rule broken with how often. Rule names go to `findings`.',
      inputSchema: z.object({}),
      execute: async () => {
        const f = findings();
        if (!f) return { error: 'Not validated yet: the page validates after loading; ask again shortly.' };
        return {
          violation: f.violation,
          warning: f.warning,
          info: f.info,
          rules: some(
            f.rules.map((r) => ({ rule: r.rule, name: r.name, severity: r.severity, count: r.count, description: clip(r.description, 200) })),
            40,
          ),
        };
      },
    }),

    findings: tool({
      description: 'The findings of one validation rule: the objects it found and why. Up to 40.',
      inputSchema: z.object({ rule: z.string().describe('The rule, as `validation` names it') }),
      execute: async ({ rule }) => some(await client.request<'findings'>({ kind: 'findings', rule }), 40),
    }),

    powerFlow: tool({
      description:
        "Solves an AC power flow of the model with gridoxide, as the Power flow view does by default (the reference machine takes the imbalance, reactive limits held, buses from the TP). Answers each island's outcome, the extreme voltages, machines past their limits, and current violations.",
      inputSchema: z.object({}),
      execute: async () => {
        const pf = await client.request<'powerFlow'>({
          kind: 'powerFlow',
          sharing: 'reference',
          qLimits: true,
          switches: false,
          action: null,
          at: null,
        });
        if (pf.error) return { error: pf.error };
        const solved = pf.nodes.filter((n) => n.pu !== null);
        const byPu = [...solved].sort((a, b) => (a.pu ?? 0) - (b.pu ?? 0));
        const node = (n: (typeof pf.nodes)[number]) => ({ id: n.id, label: n.label, kV: n.kV, pu: n.pu, deg: n.deg, nominalKV: n.nominalKV });
        return {
          components: pf.components.map((c) => ({
            status: c.status,
            nodes: c.nodes,
            references: c.references.map(link),
            maxMismatch: c.maxMismatch,
            sv: c.sv,
          })),
          nodes: pf.nodes.length,
          solved: solved.length,
          lowest: byPu.slice(0, 8).map(node),
          highest: byPu.slice(-8).reverse().map(node),
          switchedToPQ: some(pf.switched.map(link), 20),
          sharedMW: pf.sharedMW,
          pastLimits: some(pf.pastLimits.map((p) => ({ ...link(p), mw: p.mw, limit: p.limit })), 20),
          violations: some(
            pf.violations.map((v) => ({ equipment: link(v.equipment), kind: v.kind, amps: v.amps, limitAmps: v.limitAmps, percent: v.percent })),
            30,
          ),
        };
      },
    }),

    contingencies: tool({
      description: 'The contingencies the Network Code files define, with the equipment each takes out. Up to 40.',
      inputSchema: z.object({}),
      execute: async () => {
        const list = await client.request<'contingencies'>({ kind: 'contingencies' });
        return some(
          list.map((c) => ({ id: c.id, label: c.label, class: c.class, mustStudy: c.mustStudy, equipment: c.equipment.map(link) })),
          40,
        );
      },
    }),

    show: tool({
      description: 'Shows an object to the user in the page: in the Explore view, its tree, grid and inspector. Use it when the user asks to see something.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        navigate(id);
        return { shown: id };
      },
    }),
  };
}

export const INSTRUCTIONS = `You help an engineer inspect a power system model in cimlens, a web app that reads ENTSO-E CGMES and Network Code (NC) files in the browser. The model is in the page; read it with the tools rather than guessing. Every object has an id, its mRID.

When you mention an object, link it as [its name](#object:ID) with its id, so that the user can click it to see it in the page. Answer briefly, in plain text with these links; say what you looked up when it matters. Explain CGMES and power systems terms where they help, and say when the data cannot answer a question.`;
