/**
 * An answer's text, in pieces the panel renders as elements, never as HTML: links to objects in the
 * model, links out, code and bold. Everything else stays text, line breaks and all.
 */

export type Piece =
  | { type: 'text'; text: string }
  | { type: 'object'; text: string; id: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; text: string };

const PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;

export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(PATTERN)) {
    if (m.index > at) out.push({ type: 'text', text: text.slice(at, m.index) });
    const [whole, label, target, code, bold] = m;
    if (label !== undefined) {
      if (target.startsWith('#object:')) out.push({ type: 'object', text: label, id: decodeURIComponent(target.slice(8)) });
      else if (/^https?:\/\//.test(target)) out.push({ type: 'link', text: label, href: target });
      else out.push({ type: 'text', text: whole });
    } else if (code !== undefined) out.push({ type: 'code', text: code });
    else out.push({ type: 'bold', text: bold });
    at = m.index + whole.length;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}
