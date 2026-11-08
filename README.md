# gridox-web

Power system models in your browser: [gridoxide](https://github.com/m-mirz/gridoxide) and
[cimoxide](https://github.com/m-mirz/cimoxide) as WebAssembly, in a static PWA. Nothing leaves your machine.

Early days: it loads CGMES and NC files and counts what is in them. [PLAN.md](PLAN.md) says where this is going.

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

## How it fits together

`crates/gridox-wasm` is the libraries' API as the worker needs it, JSON in and out. `web/src/worker` holds the model in a Web Worker, so the
page stays responsive. `web/src/views` is the Svelte UI. A push to `main` deploys to GitHub Pages.
