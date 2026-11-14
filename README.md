# cimlens

Power system models in your browser: [gridoxide](https://github.com/m-mirz/gridoxide) and
[cimoxide](https://github.com/m-mirz/cimoxide) as WebAssembly, in a static PWA. Nothing leaves your machine.

Early days: it loads CGMES and NC files, keeps them in the browser, and shows their grid and objects.

## Develop

Needs Rust with the `wasm32-unknown-unknown` target, and Node 24.

```bash
cd web
npm ci
npm run dev        # builds the wasm, and serves the app
npm run build      # into web/dist
npm test           # unit tests
npm run check      # types
npm run size       # the wasm against its budget
npx playwright install chromium firefox webkit
npm run e2e        # the built app, in browsers
cargo test         # the Rust side, from the root
```

`RELICAPGRID_DIR=<a ReliCapGrid checkout> npm run e2e` also decodes its common grid model, and prints how long it took.

`tests/relicapgrid.spec.ts` walks through each use case of the report on ReliCapGrid, in Chromium, and expects what cimoxide's
harness and gridoxide's tests record, the data's problems included. It takes ReliCapGrid from `RELICAPGRID_DIR`, else from
`../cimoxide/relicapgrid` (fetch it with `git submodule update --init --checkout relicapgrid` there), and skips without it. SAR_UC1
validates the SAR it downloads with `cimcli` from `CIMCLI`, else `../cimoxide/target/release/cimcli`.

## The example

"Load an example" fetches ReliCapGrid, ENTSO-E's test configuration (CC BY-SA 4.0), from its
repository at a fixed commit (`web/src/example.ts`, its file list in `example-files.json`): the
only request the page makes to another site, and only when asked. The site ships none of it.

## The guide

The Guide view walks through the SV-IOP 2026 report's use cases on the example, a step each: what
the report asks, what to look at, what ReliCapGrid gives (its data's known problems included), and
"Show me", which ticks in the files the use case needs and goes there. The steps are in
`web/src/guide.ts`; the acceptance tests follow every one, so a step that no longer shows what it
says fails a test.

## Keys

1 to 7 go to the views (Explore, Validation, Network codes, Power flow, Contingencies, Data
quality, Guide), / to the search, Escape closes the inspector, and Ctrl or ⌘ with Z undoes the last edit.

## Licences

cimlens is licensed under the Apache License 2.0. The site it builds carries libraries under their
own licences, listed with their notices in `third-party-licenses.txt`, which `npm run build`
writes from cargo's and npm's metadata (`web/scripts/licenses.mjs`) and the page links to. Among
them is LGPL-2.1-or-later code: gridoxide's default solver, `klu_native` in gridoxide-sparse, is a
Rust translation of SuiteSparse's KLU and BTF. The file says where its source is and how to rebuild
the WebAssembly module with a modified version, as that licence asks.

## How it fits together

`crates/cimlens-wasm` is the libraries' API as the worker needs it, JSON in and out. `web/src/worker` holds the model in a Web Worker, so the
page stays responsive. `web/src/views` is the Svelte UI. A push to `main` deploys to GitHub Pages.
