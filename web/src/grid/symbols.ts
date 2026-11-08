// Equipment symbols, after IEC 60617's single-line ones, simplified to read at 16 px: drawn on a
// 16 × 16 grid, strokes on half pixels. From cimoxide's VS Code extension
// (editors/vscode/src/symbols.ts).

/** Each symbol's SVG body, stroked (and, where filled, filled) in `currentColor`. */
export const SYMBOLS = {
  load: `<path d="M8 1.5v7"/><path d="M4 8.5h8L8 14.5z" fill="currentColor"/>`,
  machine: `<circle cx="8" cy="8" r="6.25"/><path d="M4.5 8.5c1-2.5 2.5-2.5 3.5 0s2.5 2.5 3.5 0"/>`,
  transformer: `<circle cx="8" cy="5.5" r="4"/><circle cx="8" cy="10.5" r="4"/>`,
  transformer3: `<circle cx="5.75" cy="6" r="3.75"/><circle cx="10.25" cy="6" r="3.75"/><circle cx="8" cy="10.25" r="3.75"/>`,
  breaker: `<rect x="3.5" y="3.5" width="9" height="9" fill="currentColor"/>`,
  breakerOpen: `<rect x="3.5" y="3.5" width="9" height="9"/>`,
  disconnector: `<path d="M8 1.5v13"/><path d="M5.5 11.5h5"/>`,
  disconnectorOpen: `<path d="M8 1.5v3.5"/><path d="M8 5l4 6.5"/><path d="M8 11.5v3"/><path d="M5.5 11.5h5"/>`,
  busbar: `<path d="M1.5 8h13" stroke-width="3"/>`,
  line: `<path d="M1.5 8h11"/><path d="M9 4.5l3.5 3.5L9 11.5"/>`,
  capacitor: `<path d="M8 1.5v5M8 9.5v5"/><path d="M3.5 6.5h9M3.5 9.5h9"/>`,
  reactor: `<path d="M8 1.5v3.5"/><path d="M8 5a3 3 0 1 1 0 6"/><path d="M8 11v3.5"/>`,
  network: `<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.5 8.5l6-6M2.5 13.5l11-11M7.5 13.5l6-6"/>`,
  converter: `<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.5 13.5l11-11"/>`,
  battery: `<path d="M8 1.5v4.5M8 10v4.5"/><path d="M3 6h10"/><path d="M5.5 10h5" stroke-width="2.5"/>`,
  node: `<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>`,
  other: `<rect x="3.5" y="3.5" width="9" height="9" rx="2.5"/>`,
} as const;

export type Symbol = keyof typeof SYMBOLS;

/** The symbol of a CIM class, as a tree shows it; `undefined` for what has none (containers, limits, …). */
export function symbolOf(cls: string): Symbol | undefined {
  if (cls === "BusbarSection") return "busbar";
  if (cls === "ConnectivityNode" || cls === "TopologicalNode" || cls === "DCNode") return "node";
  if (/Disconnector|^Jumper$/.test(cls)) return "disconnector";
  if (/^(Breaker|LoadBreakSwitch|Switch|Fuse|ProtectedSwitch|Recloser|Sectionaliser|DCSwitch|DCBreaker|DCDisconnector)$/.test(cls)) return "breaker";
  if (cls === "PowerTransformer") return "transformer";
  if (/Machine$/.test(cls)) return "machine";
  if (/Load$|^EnergyConsumer$/.test(cls)) return "load";
  if (/^(ACLineSegment|DCLineSegment|SeriesCompensator|EquivalentBranch)$/.test(cls)) return "line";
  if (/Reactor|PetersenCoil/.test(cls)) return "reactor";
  if (/Compensator/.test(cls)) return "capacitor";
  if (/^(ExternalNetworkInjection|EquivalentInjection|EnergySource)$/.test(cls)) return "network";
  if (/Battery/.test(cls)) return "battery";
  if (/Converter|PowerElectronicsConnection/.test(cls)) return "converter";
  return undefined;
}

/** A symbol as an SVG document in `colour`, `px` wide. */
export function symbolSvg(symbol: Symbol, colour: string, px = 16): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="${colour}" color="${colour}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${SYMBOLS[symbol]}</svg>`;
}
