// How a grid is drawn, in the page's colours (app.css). Taken from the page of cimoxide's VS Code
// extension (editors/vscode/src/webview/grid.ts).

import type cytoscape from 'cytoscape';
import { BANDS } from './model';
import { type Symbol, symbolSvg } from './symbols';

/** A colour the page defines. */
function colour(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function stylesheet(): cytoscape.StylesheetJson {
  const sev = {
    violation: colour("--violation", "#f14c4c"),
    warning: colour("--warning", "#cca700"),
    info: colour("--info", "#3794ff"),
    none: colour("--muted", "#888888"),
  };
  const fg = colour("--fg", "#cccccc");
  const bg = colour("--bg", "#1e1e1e");
  const fill = colour("--muted", "#8b8b8b");
  const focus = colour("--focus", "#007fd4");
  const bySeverity = (prop: string) =>
    Object.entries(sev).map(([k, c]) => ({ selector: `[sev = "${k}"]`, style: { [prop]: c } }));
  // Each voltage band's colour, on what `prop` paints of `selector`.
  const byBand = (selector: string, ...props: string[]) =>
    BANDS.map(([b, , v, fb]) => ({
      selector: `${selector}[band = "${b}"]`,
      style: Object.fromEntries(props.map((p) => [p, colour(v, fb)])),
    }));
  const shape = (kind: string, shape: string, width: number, height = width) =>
    ({ selector: `node[kind = "${kind}"]`, style: { shape, width, height, "font-size": 7 } });
  return [
    {
      selector: "node",
      style: {
        label: "data(label)", color: fg, "font-size": 9, "text-valign": "bottom", "text-margin-y": 2,
        // Legible over the lines it sits on.
        "text-outline-color": bg, "text-outline-width": 2, "text-outline-opacity": 0.85,
        width: "data(size)", height: "data(size)", "background-color": fill, "border-width": "data(ring)",
        "min-zoomed-font-size": 7,
      },
    },
    ...byBand('node[kind = "substation"]', "background-color"),
    { selector: 'node[kind = "boundary"]', style: { shape: "diamond", width: 8, height: 8, "font-size": 7 } },
    // Inside a substation: voltage levels as boxes, and a shape for each kind of equipment.
    {
      selector: 'node[kind = "group"]',
      style: {
        shape: "round-rectangle", "background-color": fill, "background-opacity": 0.05, "border-width": 1, "border-color": fill,
        "border-opacity": 0.6, "text-valign": "top", "text-margin-y": -3, "font-size": 10, padding: "12px",
      },
    },
    ...byBand('node[kind = "group"]', "border-color", "background-color", "color"),
    shape("junction", "ellipse", 4),
    shape("busbar", "rectangle", 36, 4),
    { selector: 'node[kind = "junction"]', style: { "font-size": 6, "text-opacity": 0.7 } },
    ...byBand('node[kind = "junction"]', "background-color"),
    ...byBand('node[kind = "busbar"]', "background-color"),
    // Equipment: its symbol, in its voltage's colour, on a transparent disc
    // (which carries the findings' ring, and the selection).
    {
      selector: 'node[kind = "symbol"]',
      style: {
        shape: "ellipse", width: 16, height: 16, "font-size": 7, "background-opacity": 0, "background-fit": "contain",
        "background-clip": "none",
        "background-image": (ele: cytoscape.NodeSingular) => {
          const b = BANDS.find(([name]) => name === ele.data("band"));
          const c = b ? colour(b[2], b[3]) : fill;
          return `data:image/svg+xml;utf8,${encodeURIComponent(symbolSvg(ele.data("symbol") as Symbol, c, 32))}`;
        },
      },
    },
    { selector: 'node[symbol ^= "transformer"]', style: { width: 18, height: 18 } },
    ...bySeverity("border-color").map((s) => ({ ...s, selector: `node[kind != "group"]${s.selector}` })),
    // And a halo, which reads apart from a voltage colour of the same hue.
    ...bySeverity("underlay-color").filter((s) => !s.selector.includes('"none"')).map((s) => ({
      ...s, selector: `node[kind != "group"]${s.selector}`,
      style: { ...s.style, "underlay-opacity": 0.35, "underlay-padding": 4, "underlay-shape": "ellipse" },
    })),

    { selector: "node.out", style: { opacity: 0.45, "border-style": "dashed" } },
    {
      selector: "edge",
      style: { width: "data(width)", "curve-style": "bezier", "line-color": fill, opacity: 0.9 },
    },
    ...byBand("edge", "line-color"),
    // Findings on a line: a halo in the worst one's colour, apart from its voltage colour.
    ...bySeverity("underlay-color").filter((s) => !s.selector.includes('"none"'))
      .map((s) => ({ ...s, selector: `edge${s.selector}`, style: { ...s.style, "underlay-opacity": 0.4, "underlay-padding": 5 } })),
    { selector: "edge.disconnected", style: { "line-style": "dashed" } },
    // What a table row is about: in the focus colour, around and along it.
    { selector: "node.highlighted", style: { "border-color": focus, "border-width": 4 } },
    { selector: "edge.highlighted", style: { "line-color": focus, width: 4, opacity: 1 } },
    { selector: "node:selected", style: { "background-color": focus, "background-opacity": 1 } },
    { selector: 'node[kind = "group"]:selected', style: { "background-opacity": 0.15 } },
    { selector: 'node[kind = "symbol"]:selected', style: { "background-opacity": 0.3 } },
    { selector: "edge:selected", style: { "line-color": focus, opacity: 1 } },
    // Faded, findings' halos too, which do not take the element's opacity.
    { selector: ".dim", style: { opacity: 0.15, "underlay-opacity": 0 } },
  ] as cytoscape.StylesheetJson;
}
