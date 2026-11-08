# gridox-web: plan

A web UI for power system models, running gridoxide and cimoxide as WebAssembly in the browser. It is a static
PWA on GitHub Pages: no server, and a model never leaves the user's machine. Its scope is the use cases of the
[2026 SV-IOP report](https://www.entsoe.eu/Documents/CIM_documents/Market%20CIM/SV_IOP_Report_2026.pdf): a person
should be able to carry out each of them in the browser, on ReliCapGrid.

Status: plan, nothing built. Everything marked **measured** comes from a throwaway prototype, described in
[What was measured](#what-was-measured). The rest is design and has not been tried.

## Goals

1. Load CGMES and NC files by dropping them on the page, and work offline after the first visit.
2. Browse the model: a tree of its objects, and a drawing of its grid.
3. Validate it (SHACL), and see findings on the objects they concern.
4. Solve it: power flow, contingencies against current limits, and export a SAR.
5. Edit it: fix findings, change objects, export the result. A browser-only grid diagram editor grows from this.
6. Carry out each use case of the SV-IOP report: see [the scope](#scope-the-reports-use-cases).

Not goals for a first version: accounts, sharing, a backend, models over the 4 GB wasm32 limit.

## Scope: the report's use cases

The report's Annex 1 scores each tool by what it does per use case: import, validate, view/edit, export, simulate. This is what the UI has to
offer for each. "Today" says what the libraries already do; cimoxide's and gridoxide's SV-IOP reports hold the details and the tests.

| Use case | What the person does in the UI | Today | Phase |
|---|---|---|---|
| **PF_UC1** Power flow | solve each IGM, a chosen combination, the CGM; see convergence, voltages, flows, how far from the published state | gridoxide | 5 |
| **BDS_UC1** Boundary | load the boundary with IGMs; see each boundary point's terminals and topology, gaps and objects defined twice | cimoxide's checks are in its test harness, not its API | 4 |
| **CD_UC1** Common data | see the listed classes, and objects defined again by other datasets | as above | 4 |
| **RD_UC1** Reference data | browse SKOS/PROV/DCAT objects; see which header URIs resolve | `foreign()`; the lookup is in the harness | 4 |
| **CO_UC1** Contingencies | see each contingency's equipment on the grid; run it; change it; export the CO dataset | gridoxide runs, cimoxide edits and exports | 4, 6, 7 |
| **ER_UC1** Equipment reliability | browse ER objects with their links, and export | cimoxide | 4 |
| **RA_UC1** Topology action | see the action and its switch; apply it; see the state and the grid change | switch states in the harness; re-solving not done | 4, 8 |
| **RA_UC2** Dependent actions | see the group and its exclusivity; apply each; compare configurations | as above | 4, 8 |
| **RA_UC3** Modify before RAO | see an action's enabled/disabled time points, through SIS and SSI; change one | reading in the harness | 4, 7 |
| **RA_UC4** Modify after RAO | refuse a schedule; create the counter-proposal; export the RAS | built by script in cimoxide's `test_edits.py`; a guided form is new | 7 |
| **RA_UC5** Activation | see exclusive actions' schedules on a timeline, and overlaps | reading in the harness | 4 |
| **RA_UC6** Countertrade | see power schedules and bids, with their time points | as above | 4 |
| **RA_UC7** Redispatch | see bids and shift keys, and what they link to | as above | 4 |
| **AS_UC1** Availability | see a schedule, its cancellation and its resulting window | as above | 4 |
| **AE_UC1..6** Assessed elements | see secured/scanned status, exclusions, schedules, contingency and remedial action combinations; change them | as above | 4, 7 |
| **OR_UC1** Object registry | browse designations and what they name | as above | 4 |
| **SAR_UC1** SAR | run the analysis, see violations, download the SAR; open a supplied SAR beside its model | gridoxide | 6 |

The checks each use case needs exist as `check_*` functions in cimoxide's `scripts/relicapgrid/test_use_cases.py`. They are test code in Python, and
the browser cannot run them. So what is common goes into Rust, in `cimoxide-view` (below), and those tests call or are compared with it.

**Acceptance.** A use case is done when a Playwright test walks through the report's steps on ReliCapGrid and sees the same objects and
findings that cimoxide's and gridoxide's reports record, data problems included. For instance, RA_UC1's action leaves its switch closed,
and the UI has to show that rather than what the description expects.

**Not a scored result.** This does not make gridox-web a participant in the event: as with cimoxide's and gridoxide's own reports, these would be
later runs on a later dataset.

## Architecture

```
 main thread (UI)                     Web Worker(s)
┌─────────────────────────┐          ┌──────────────────────────────┐
│ Svelte, Vite, TypeScript│ messages │ gridox-wasm (Rust → wasm)    │
│ tree · grid · findings  │ ───────► │   Session: the decoded model │
│ Cytoscape.js            │ ◄─────── │   cimoxide-model, -validation│
│ service worker (PWA)    │  JSON    │   gridoxide                  │
└─────────────────────────┘          └──────────────────────────────┘
           │                                         ▲
           └── File System Access / OPFS ── file text ┘
```

- **Everything computed runs in a worker.** A 325-contingency sweep takes 15 s; the UI must stay responsive and
  be able to cancel. Cancelling means terminating the worker and starting a new one from the files.
- **The decoded model stays in the worker**, in a `Session`. The UI asks for what it draws, a level of the tree at a
  time, as `cimlsp` already answers the VS Code extension. Whole datasets do not cross `postMessage`.
- **`gridox-wasm` lives in this repository**, not in gridoxide or cimoxide, so neither library takes on
  `wasm-bindgen`. It is thin: JSON in and out over the libraries' APIs, with no analysis of its own.

### Repository layout

```
Cargo.toml                 workspace
crates/gridox-wasm/        the wasm bindings: Session, and one function per worker request
web/
  src/worker/              the worker, and a typed request/response protocol
  src/views/               tree, grid, findings, results
  src/symbols.ts           from cimoxide's editors/vscode/src
  public/                  PWA manifest, icons
.github/workflows/         build, test, deploy to Pages
```

Built with `wasm-pack build --target web`, then Svelte on Vite with `vite-plugin-pwa`; the wasm is precached by its service
worker. Deployed to Pages by GitHub Actions.

## What was measured

A throwaway crate (`wasm32-unknown-unknown`, `wasm-bindgen`, `opt-level = "s"`, LTO, no `wasm-opt`) with the published
`cimoxide-model` and `cimoxide-validation` 0.6.0 and gridoxide at `a350ed1` with one change, below, run in Node 24 on
ReliCapGrid's CGM (27 files, 16.3 MB). One run on one machine, and in Node rather than a browser.

| | Result |
|---|---|
| Size | 6.1 MB, 1.53 MB gzipped, with gridoxide's CGMES and cimoxide's validation in it |
| Decode the CGM | 156 ms, 31,412 objects |
| Security analysis, 325 contingencies, and the SAR | 15 s, against 15.5 s for the native CLI |
| Results | identical to native: 304 solved, 21 stalled, 13 + 4,003 violations, a SAR of 3,643 KB |
| `validate_files` | **panics**: `failed to spawn thread`, from `thread::scope` |
| `cargo check` of gridoxide's `matpower`, `ucte`, `iidm`, `opf`, `rao`, `dynamics` | compile. Not run |
| `cargo check` of `cimoxide-sparql` | fails on `getrandom`, through oxigraph. Fix not tried |

Not measured: a browser, peak memory, RealGrid-sized models (113 MB of XML), `wasm-opt`, rayon's behaviour in gridoxide's
batch solvers, and `dynamics`, `opf` and `rao` at runtime.

### How this differs from what was assumed

The starting point was a discussion of the idea (not in this repository). Measured against it:

| Assumed | Found |
|---|---|
| C dependencies are the main obstacle: a `wasm` feature must switch to faer | KLU, PARDISO, HiGHS and IPOPT are already optional, and the default build is pure Rust. The blocker is faer's own default features (`spindle`, `rand`) |
| Threads need `wasm-bindgen-rayon`, SharedArrayBuffer and `coi-serviceworker` | Not to start. The solve path runs on one thread at native speed, and a sweep can be split across workers with no shared memory, below |
| RAO may need HiGHS compiled to wasm | gridoxide's `opf` and `rao` have pure Rust solvers and compile without it; `opf-highs` is optional. Whether they run well is open |
| Gate PyO3 out of the wasm build | Already gated, by the `python` feature |
| wasm32's 4 GB cap, FP64 native, solve in a Web Worker, PWA on Pages, `wasm-pack` + Vite + Actions | Kept |

## Changes needed upstream

These go first, as everything here depends on them.

### gridoxide

1. **Merge PR #32** and release. It has `security_analysis`, `with_out_of_service` and `terminal_flows`.
2. **Make faer's threading a feature.** The prototype turned faer's default features off everywhere
   (`features = ["std", "linalg", "sparse", "sparse-linalg"]`), which would cost native builds their parallelism. Keep it
   for them: a default-on `parallel` feature carrying `faer/rayon`, with `gridox-wasm` building with
   `default-features = false`.
3. **Check rayon on wasm.** `BatchSolver` and friends build thread pools. rayon compiles, but this path has not been run.
4. **Add `cargo check --target wasm32-unknown-unknown` to CI**, so a dependency cannot break this unnoticed.

### cimoxide

1. **Run single-threaded on wasm.** `thread::scope` is called in `cimvalidation/src/lib.rs` (twice, unconditionally),
   `par.rs`, `sparql/common_solved_mas.rs` and `cimmodel/src/decode.rs`. Run them in turn under
   `cfg(target_family = "wasm")`. Output is already byte-identical to one thread by design, and that is the test: results
   on wasm must equal `cimcli validate`'s.
2. **Move the grid and tree out of the language server.** `cimoxide-lsp` is a binary with `lsp-server` in it. New library
   crate `cimoxide-view`, taken from its `src/`:

   | File | Lines | Depends on |
   |---|---|---|
   | `grid.rs` | 925 | `cimmodel` only: moves as it is |
   | `layout.rs` | 351 | `cimmodel` only: moves as it is |
   | `tree.rs` | 757 | `validate::ModelSet`: needs a narrower input |
   | `edit.rs` | 818 | `lsp_types` for its text edits: needs its own edit type, and the file access taken out |

   `cimlsp` then depends on it, and its tests and the rule that its diagnostics equal `cimcli validate`'s keep it honest.
   It also takes what the use cases need from `test_use_cases.py` and now only exists in Python: a remedial action's resulting switch
   states (`applied`), a boundary point's terminals and topology, datasets defining an object twice, and which header URIs reference data
   resolves.
3. **Add wasm to CI**, and release.
4. **SPARQL** is left out of the first version. If wanted, see whether `getrandom`'s `wasm_js` backend settles it.

## Phases

Each phase ends with something usable, deployed.

### 1. Skeleton

Workspace, `gridox-wasm`, worker with its typed protocol, Vite, PWA, deploy to Pages. Drop files on the page; the worker
decodes them and the page shows the classes and counts. Needs only the published `cimoxide-model` 0.6.0: gridoxide's `main` does not yet
compile to wasm, and joins with its `parallel` feature.

Measured on the skeleton: the wasm with the decoder alone is 520 KB gzipped, and ReliCapGrid's CGM (16 MB) decodes in 200 to 340 ms in Chromium and Firefox.
WebKit is set up in CI, and has not been run yet.

Done when: it works offline on the deployed URL, and CI fails if the wasm exceeds the budget below.

### 2. Browse

The tree and the grid, using `cimoxide-view`.

- Reuse from `editors/vscode/src`: `webview/grid.ts` (748 lines, Cytoscape, grid and substation views) and `symbols.ts`
  (IEC 60617 symbols). Take out what depends on VS Code's webview messaging, rather than rewriting.
- The layout is `layout.rs`, in the worker: Cytoscape's `cose` hangs on RealGrid, which is why it exists.
- Model sets persist in OPFS, so a reload does not ask for the files again.

### 3. Validate

`validate_files`, a findings panel, each finding on its object in the tree and grid, as the extension's badges do. Needs
cimoxide's threading fix. Bundles the CGMES and NC shape tables, which are already in the size measured.

### 4. Network Code views

What most of the report's use cases are about, and the phase with the most to do. Generic object pages first: any object's fields, with links in
both directions (`referrers`). Then views for what generic pages show badly, each from use cases in the scope table:

- **Time points on a timeline:** RA_UC3, RA_UC5, RA_UC6, AS_UC1, AE_UC3. Several schedules together, as overlaps are the point of RA_UC5.
- **Remedial actions:** an action, its alterations and what it targets, on the grid, with dependencies and groups: RA_UC1, RA_UC2, RA_UC7.
- **Contingencies and assessed elements:** tables with their equipment highlighted on the grid: CO_UC1, AE_UC1..6.
- **Datasets:** headers, what requires what, and what does not resolve: BDS_UC1, CD_UC1, RD_UC1, OR_UC1, ER_UC1.
- **Applying a remedial action** shows the resulting switch states, from `applied`, whether or not anything is solved.

### 5. Solve

- Power flow, with voltages and flows on the grid, and each component's status from `islands()`. Do not show a green tick for
  convergence alone: `no_reference` and `ambiguous_reference` have to be visible, as they are on merged models.
- Options that change answers are in the UI and in the results they produced: reactive limits, and who takes the imbalance.

### 6. Contingencies and the SAR

Run the CO files' contingencies, show violations per contingency and per element, and download the SAR.

**Parallelism without shared memory.** A sweep splits naturally: N workers, each with its own wasm instance and decoded model,
each taking a share of the contingencies. This needs no SharedArrayBuffer, no special headers and no nightly compiler, and works
on plain Pages. It costs N copies of the model in memory. Needs `security_analysis` to run a subset and merge results, with
results equal however the work is split, which is a test.

The UI must carry over what the analysis cannot decide: contingencies that did not converge are absent from a SAR and have to be
listed beside it, and the imbalance treatment changes the answer. gridoxide's `docs/src/cgmes/sv_iop_2026.md` shows how much.

### 7. Edit

Fixes from findings, adding and deleting objects, renaming mRIDs, from `edit` in `cimoxide-view`, then export through
`to_xml_for_profile`, downloaded or saved back with the File System Access API where the browser has it. Every export is validated first, and its
findings shown.

The use cases' own edits, as guided forms rather than free editing: CO_UC1's change of a contingency, RA_UC3's and AE_UC3's enabling and disabling,
AE_UC4's exclusion, and RA_UC4's refusal and counter-proposal, whose new schedule needs new identifiers throughout (see `counter_proposal` in cimoxide's
`test_edits.py`).

Then the grid diagram editor: placing and connecting equipment on the canvas, writing DL. That editor is its own design, to be done when this phase is
reached.

### 8. Remedial actions on the grid

RA_UC1 and RA_UC2 ask that the grid topology follow the action, and the report scores "simulate". Opening a switch changes the topology the TP describes, so
this needs solving from the switches rather than from the TP. gridoxide's `topology="node_breaker"` and `set_switch` look like the way, but they have not been tried on
ReliCapGrid, and that view has no tap tables or machine data for reactive sharing. Find out first; this could be a large piece of gridoxide work. Applying an action
in a contingency (the report's security analysis with remedial actions) follows from it, and belongs in the SAR's `RemedialActionApplied`.

### 9. Later, each only if wanted

- Threads inside one solve (`wasm-bindgen-rayon`, `coi-serviceworker`). Only if phase 6's workers fall short: it needs nightly and
  a service worker reload on first visit.
- RAO, dynamics, OPF: bind them once they are shown to run. They may belong in lazily loaded wasm modules.
- SPARQL, for queries in the browser.

## Testing

| What | How |
|---|---|
| Results equal native | `wasm-bindgen-test` in Node on ReliCapGrid: the numbers gridoxide's and cimoxide's own tests pin. A difference is a bug |
| Worker protocol and views | unit tests in Vitest |
| The app | Playwright against the built site: load files, solve, download a SAR, reload offline |
| Each use case | a Playwright test per row of [the scope](#scope-the-reports-use-cases), walking through the report's steps on ReliCapGrid |
| The SAR it downloads | validated by cimoxide, as `test_relicapgrid_security_analysis.py` does |

CI builds, tests, checks the size budget, and deploys from `main`. The CGMES test models are not fetched by default; the same
ReliCapGrid submodule used elsewhere is enough, at `f09bb34`.

## Budgets

Starting points, to be revisited with browser measurements.

| | Target | Measured so far |
|---|---|---|
| wasm, gzipped | 5 MB, to catch accidents rather than to trim features; reviewed as features are added | 0.52 MB with the decoder; 1.53 MB in the prototype with validation and solver, before `wasm-opt` |
| First load on a fast connection | under 3 s | not measured |
| Decode of a 16 MB model | under 1 s | 156 ms in Node |
| Interaction during any calculation | no blocking | by design: workers |

The wasm is downloaded once and then cached by the service worker. Check the deployed site's real download size: whether Pages compresses `.wasm` has not been verified. If size becomes a problem: `wasm-opt -Oz`, and loading validation's tables or rarely used parts such as RAO on demand.

## Risks

| Risk | What would show it | Response |
|---|---|---|
| Browsers run slower than Node, or differ on memory | phase 1 measurements in Chrome, Firefox, Safari | the budgets above; workers already keep the UI responsive |
| Large models: RealGrid is 113 MB of XML, and strings cross into wasm | loading it in phase 2 | stream the decode, or state a supported size |
| N workers multiply memory | a CGM across 8 workers | fewer workers; measure in phase 6 |
| The extension's `grid.ts` is tied to VS Code | phase 2 | if separating it costs more than it saves, keep only the drawing |
| Moving code out of `cimoxide-lsp` destabilises the language server | its existing tests, and the `npm test` suite | move without changing behaviour, as its own PR |
| Numbers read as more certain than they are | | show the assumptions beside the results, phases 5 and 6 |

## Licensing and data

- This repository is Apache-2.0. gridoxide's `license` field is `Apache-2.0 AND BSD-3-Clause AND LGPL-2.1-or-later`, for its vendored parts.
  A wasm bundle links statically, so check before the first public deploy that it contains none of the LGPL code: KLU is a feature this build
  leaves out, but that has not been verified, nor have the dependencies' licences. Cytoscape.js is MIT.
- **No sample models are bundled at first.** ReliCapGrid is CC BY-SA 4.0 and the CGMES test configurations CC BY-NC-SA 4.0, and neither
  licence fits being shipped inside an Apache-2.0 site without thought. A "load an example" button that fetches ReliCapGrid from its own
  repository, with attribution, avoids that. Check that it allows being fetched from the browser (CORS).
- Models can be confidential. "Nothing leaves your browser" is a feature to state and to keep true: a strict Content-Security-Policy, no
  analytics, no external requests but the example above. Pages cannot set headers, so this is a `<meta>` policy.

## Decisions to make

1. **Where `gridox-wasm` depends on the libraries.** Recommendation: git revisions until the upstream changes are released, then crates.io.
2. **How much of the extension to share.** Copy `grid.ts` and `symbols.ts` here (recommended to start), or publish them as a package both use.
3. **Browser support.** Recommendation: current Chrome, Edge, Firefox and Safari, with saving back to the original file only where the File
   System Access API exists, and a download elsewhere.
4. **Name of the crate.** `gridox-wasm`, here, as it binds more than gridoxide.

Decided: the UI is **Svelte**, for its small bundle, with the grid in Cytoscape. Most state lives in the worker.

## Order of work

1. Phase 1, against published cimoxide: this will surface what Node could not.
2. gridoxide's `parallel` feature and wasm CI, then cimoxide's threading fix and wasm CI.
3. `cimoxide-view`, then phase 2.
4. Phases 3 to 7 in order. Phases 3, 4 and 5 do not depend on each other and can swap; 6 needs 5, and 7 needs 4.
5. Phase 8, once it is known how much gridoxide work it takes.
