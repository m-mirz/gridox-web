# gridox-web

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

## How it fits together

`crates/gridox-wasm` is the libraries' API as the worker needs it, JSON in and out. `web/src/worker` holds the model in a Web Worker, so the
page stays responsive. `web/src/views` is the Svelte UI. A push to `main` deploys to GitHub Pages.
