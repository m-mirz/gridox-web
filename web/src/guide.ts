/**
 * A guide through the SV-IOP 2026 report's use cases on ReliCapGrid, the example: one step a use
 * case, each choosing the files it needs, going where it is seen, and saying what the report asks,
 * what to look at, and what ReliCapGrid gives, its data's problems included as cimoxide's harness
 * records them. `check` is what the acceptance test sees after the step, so the guide cannot go
 * stale unnoticed: `web/tests/relicapgrid.spec.ts` follows every step.
 */

export type GuideView = 'explore' | 'validation' | 'codes' | 'power-flow' | 'contingencies' | 'data';

export interface Step {
  id: string;
  title: string;
  /** The files of the example to tick in, by their path in ReliCapGrid's Instance folder. */
  files: (path: string) => boolean;
  /** Where to go. */
  view: GuideView;
  /** In Network codes, the table to show. */
  tab?: 'contingencies' | 'assessed' | 'actions' | 'schedules';
  /** An object to open in the inspector, by mRID (Explore). */
  object?: string;
  /** What the report asks. */
  asks: string;
  /** What to do and look at. */
  look: string;
  /** What ReliCapGrid gives. */
  finds: string;
  /** For the test: a button to press after the step, in its view, and what then shows where. */
  check: { press?: RegExp; testid: string; text: string };
}

const AREAS = ['Belgovia', 'Britheim', 'DC-Espheim-Svedala', 'DC-Nordheim-Galia', 'Espheim', 'Galia', 'Nordheim', 'Portheim', 'Svedala'];
const under = (p: string, dir: string) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/');
const grid = (p: string, ...areas: string[]) => areas.some((a) => under(p, `${a}/Grid/cimxml`));
const nc = (p: string, ...areas: string[]) => areas.some((a) => under(p, `${a}/NetworkCode/cimxml`));
const common = (p: string) => under(p, 'commonData/Grid/cimxml') || under(p, 'commonData/NetworkCode/cimxml');
const boundary = (p: string) => under(p, 'boundaryData/Grid/cimxml');
/** An IGM, its network codes and the common data. */
const igm = (a: string) => (p: string) => grid(p, a) || nc(p, a) || common(p);
const allNc = (p: string) => nc(p, ...AREAS, 'Jotunheim') || under(p, 'Jotunheim/NetworkCode');
/** The CGM as ReliCapGrid's CI assembles it, and gridoxide's tests pin. */
const cgm = (p: string) =>
  under(p, 'Jotunheim/ChangeSet/cimxml') ||
  (under(p, 'Jotunheim/Grid/cimxml') && /_(SV|TP)_/.test(p)) ||
  AREAS.some((a) => under(p, `${a}/Grid/cimxml`) && /_EQ_/.test(p)) ||
  boundary(p) ||
  under(p, 'commonData/Grid/cimxml');
const co = (p: string) => /\/NetworkCode\/cimxml\/[^/]*_CO[^/]*\.xml$/.test(p) && !p.includes('Dataset_version_dependency');

export const STEPS: Step[] = [
  {
    id: 'PF_UC1',
    title: 'PF_UC1 · Power flow',
    files: igm('Svedala'),
    view: 'power-flow',
    asks: 'Solve each IGM, or a combination, and see whether it converges, its voltages and flows, and how far it is from the state it publishes (its SV).',
    look: 'Press Solve. Read the verdict, each component with its reference and largest mismatch, "From the SV", and the voltages, furthest from the SV first. Change who takes the imbalance, or reactive limits, and solve again; untick Svedala in the Files panel and tick another area to solve it instead.',
    finds: 'Svedala: 118 nodes solved in 2 components, within 0.68 % of its SV; 119 nodes have no angle reference. Belgovia is within 0.03 %; Espheim does not converge with reactive limits held, and does without.',
    check: { press: /^Solve/, testid: 'pf-verdict', text: '118 nodes solved, in 2 components' },
  },
  {
    id: 'BDS_UC1',
    title: 'BDS_UC1 · Boundary',
    files: cgm,
    view: 'data',
    asks: "Merge the boundary with the IGMs; see each boundary point's terminals and topology, and what is defined twice.",
    look: 'Data quality: "Boundary points", the ones with something amiss first, and "Defined more than once" above it.',
    finds: 'BP Portheim-Espheim has 9 of its 11 terminals on no topological node; Madgar1 to 3 are reached from Espheim only, Madgar4-Leyva1 from the HVDC IGM only; 8 objects of the boundary are defined again by Espheim\'s, Portheim\'s and Nordheim\'s EQ.',
    check: { testid: 'boundary-points', text: 'reached from Espheim only' },
  },
  {
    id: 'CD_UC1',
    title: 'CD_UC1 · Common data',
    files: (p) => (common(p) || boundary(p) || AREAS.some((a) => grid(p, a)) || allNc(p)) && !/GridSituation|Dataset_version_dependency/.test(p),
    view: 'data',
    asks: 'See the common data\'s classes, and whether another dataset defines its objects again.',
    look: 'Data quality: "Objects by class" for the classes (CapacityCalculationRegion, SchedulingArea, …), and "Defined more than once" for what is defined again.',
    finds: 'Belgovia_ER.xml defines the common data\'s SchedulingArea and BiddingZone again, and Nordheim\'s EQ its GeographicalRegion.',
    check: { testid: 'twice', text: 'SA-Belgovia SchedulingArea' },
  },
  {
    id: 'RD_UC1',
    title: 'RD_UC1 · Reference data',
    files: (p) => allNc(p) || under(p, 'referenceData/NetworkCode/cimxml'),
    view: 'data',
    asks: 'Browse the reference data, and see which of the headers\' references it defines.',
    look: 'Data quality: the summary counts the header references not loaded; open a file under "Files" for its header, each reference with "not loaded" where the reference data lacks it.',
    finds: 'Every licence, model collection, frame and activity the headers name is missing from the reference data, and 37 publishers; the access rights all resolve.',
    check: { testid: 'datasets-summary', text: 'header references not loaded' },
  },
  {
    id: 'CO_UC1',
    title: 'CO_UC1 · Contingencies',
    files: (p) => allNc(p) || AREAS.some((a) => grid(p, a)),
    view: 'codes',
    tab: 'contingencies',
    asks: 'See each contingency\'s equipment, on the grid; change a contingency; export the CO dataset.',
    look: 'Network codes › Contingencies: each with its equipment, and "Show on grid". Open one (L2), Edit, and add equipment to it: the CO file is changed, to download or save.',
    finds: 'The twelve contingencies the docs name, each naming its equipment of the class they say.',
    check: { testid: 'contingencies', text: 'TieLine_SD_BO3' },
  },
  {
    id: 'ER_UC1',
    title: 'ER_UC1 · Equipment reliability',
    files: (p) => igm('Svedala')(p) || boundary(p),
    view: 'data',
    asks: 'Browse the equipment reliability objects and what they link to.',
    look: 'Data quality › Files: Svedala_ER.xml, with no references to objects not loaded; open its objects from the tree (By class).',
    finds: 'Every reference of each area\'s ER dataset resolves.',
    check: { testid: 'dataset-files', text: 'Svedala_ER.xml' },
  },
  {
    id: 'RA_UC1',
    title: 'RA_UC1 · Topology action',
    files: igm('Svedala'),
    view: 'codes',
    tab: 'actions',
    asks: 'See a remedial action and its switch, apply it, and see the state and the grid change.',
    look: 'Network codes › Remedial actions: "Topology RA one Switch", what it sets and "Applied". Then Power flow › Remedial action applied, and Solve.',
    finds: 'The description has the action open the switch; its range sets Switch.open to 0.0, and the switch is already closed: it stays closed, and applying it changes nothing.',
    check: { testid: 'remedial-actions', text: 'RT133_RL8-B-S stays closed' },
  },
  {
    id: 'RA_UC2',
    title: 'RA_UC2 · Dependent actions',
    files: igm('Svedala'),
    view: 'codes',
    tab: 'actions',
    asks: 'See a group of actions and their exclusivity; apply each; compare.',
    look: 'Network codes › Remedial actions: "RA SubstationA_quarterbar1B" and "RA SubstationB_2N", exclusive in GroupSubstationA. Apply each in Power flow and compare.',
    finds: 'Each opens four switches; the docs put both on the same four, the data on four different switches each.',
    check: { testid: 'remedial-actions', text: 'exclusive in GroupSubstationA' },
  },
  {
    id: 'RA_UC3',
    title: 'RA_UC3 · Modify before RAO',
    files: igm('Espheim'),
    view: 'explore',
    object: '_f5205bd4-637a-4eb7-b0d8-e03638bc570b',
    asks: 'See an action\'s enabled and disabled time points (SIS, and SSI\'s state), and change one.',
    look: 'The inspector: the schedule\'s Edit › "Enabled from a time" lists its points; add one, enabled or not.',
    finds: 'Three points: enabled, disabled, enabled again; the alteration\'s SSI state beside.',
    check: { testid: 'inspector', text: 'GridStateAlterationSchedule' },
  },
  {
    id: 'RA_UC4',
    title: 'RA_UC4 · Modify after RAO',
    files: igm('Svedala'),
    view: 'explore',
    object: '_17527637-6099-4ee6-8b21-fea8dfec4c75',
    asks: 'Refuse a remedial action schedule the RAO proposed, and make a counter-proposal.',
    look: 'The inspector shows the proposed schedule; Edit › Counter-propose writes the response, a copy of the schedule and the dependency, in a file of its own.',
    finds: 'Svedala\'s own answer is in the data: its response refuses, and its dependency carries no kind (the docs say "none"; the profile allows none here).',
    check: { testid: 'inspector', text: 'RemedialActionSchedule' },
  },
  {
    id: 'RA_UC5',
    title: 'RA_UC5 · Activation',
    files: igm('Svedala'),
    view: 'codes',
    tab: 'schedules',
    asks: 'See exclusive actions\' schedules on one time axis, and whether they overlap.',
    look: 'Network codes › Schedules: the exclusive group, "Show on timeline".',
    finds: 'The two actions exclude one another, yet both are active at 00:30, 01:30 and 02:30 on 2024-11-20.',
    check: { testid: 'exclusive', text: '3 times more than one is active' },
  },
  {
    id: 'RA_UC6',
    title: 'RA_UC6 · Countertrade',
    files: igm('Belgovia'),
    view: 'codes',
    tab: 'schedules',
    asks: 'See a countertrade action\'s power schedule and bids, with their time points.',
    look: 'Network codes › Schedules: RA18\'s power schedule on its generating unit, and its bids.',
    finds: 'RA18, a CountertradeRemedialAction, with its power schedule and bid schedules.',
    check: { testid: 'schedules', text: 'RA18' },
  },
  {
    id: 'RA_UC7',
    title: 'RA_UC7 · Redispatch',
    files: igm('Belgovia'),
    view: 'explore',
    object: '_9d72d12a-f135-437a-83fa-ef3e5b23f41f',
    asks: 'See redispatch bids and their shift keys, and what they link to.',
    look: 'The inspector: variant 2 of "RD RA1". Compare variant 1, whose bids lead to the shift key distribution PSKD1 (Network codes › Schedules).',
    finds: 'Variant 2 is linked to no shift key object: PSKD1 goes through PBS1 to variant 1.',
    check: { testid: 'inspector', text: 'RedispatchRemedialAction' },
  },
  {
    id: 'AS_UC1',
    title: 'AS_UC1 · Availability',
    files: igm('Svedala'),
    view: 'explore',
    object: '_d394295f-9d18-4d9f-9808-bd23282bf60f',
    asks: 'See an availability schedule, its cancellation, and the window that results.',
    look: 'The inspector: the schedule, its cancelledDateTime and its action ARA1.',
    finds: 'It is cancelled, but has no time points: the outage window is only in its description text.',
    check: { testid: 'inspector', text: 'cancelledDateTime' },
  },
  {
    id: 'AE_UC',
    title: 'AE_UC1..6 · Assessed elements',
    files: igm('Belgovia'),
    view: 'codes',
    tab: 'assessed',
    asks: 'See assessed elements: in the base case or not, secured or scanned, excluded and why, their schedules, and their combinations with contingencies and remedial actions; change them.',
    look: 'Network codes › Assessed elements: AE1 (secured), AE3 (excluded, with its reason), AE1\'s schedule, AE5-CO and AE5-CO3 (contingencies), AE4 with TapRA2. Open one to edit it.',
    finds: 'Each as the use cases describe.',
    check: { testid: 'assessed-elements', text: 'nonNativeCapacityCalculationRegion' },
  },
  {
    id: 'OR_UC1',
    title: 'OR_UC1 · Object registry',
    files: igm('Espheim'),
    view: 'data',
    asks: 'Browse the designations and what they name.',
    look: 'Data quality › Files: Espheim_OR.xml and the common data\'s; their objects from the tree (By class › Designation).',
    finds: 'They resolve; Espheim\'s EQ and TP point to the boundary, not loaded here.',
    check: { testid: 'dataset-files', text: 'Espheim_OR.xml' },
  },
  {
    id: 'SAR_UC1',
    title: 'SAR_UC1 · Security analysis',
    files: (p) => cgm(p) || co(p) || p === 'Jotunheim/NetworkCode/2D_SAR_1030Z_Jotunheim.xml',
    view: 'contingencies',
    asks: 'Run the contingencies, see the violations, and download the SAR; open a supplied SAR beside its model.',
    look: 'Press Run. Read the counts, the contingencies that did not converge, "By element", and "Supplied SAR" beside; then "Download the SAR".',
    finds: 'By capability: 304 solved, 21 not converging (all Espheim\'s), 13 violations in the base case and 4,003 after. The supplied SAR\'s one violation is none here.',
    check: { press: /^Run \d/, testid: 'sa-summary', text: '304 solved, 21 did not converge' },
  },
  {
    id: 'SIPS',
    title: 'SIPS · Protection schemes',
    files: (p) => igm('Svedala')(p) || boundary(p),
    view: 'data',
    asks: 'See the special protection schemes: stages, triggers, gates and what they act on.',
    look: 'The tree, By class: RemedialActionScheme, Stage, StageTrigger, Gate; Data quality › Files: Svedala_RA.xml resolves.',
    finds: 'The schemes\' objects all resolve.',
    check: { testid: 'dataset-files', text: 'Svedala_RA.xml' },
  },
];
