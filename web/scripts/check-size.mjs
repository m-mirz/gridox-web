// Fails the build if the wasm, gzipped, is over the budget in PLAN.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET = 5 * 1000 * 1000;
const assets = join(import.meta.dirname, '..', 'dist', 'assets');
const wasm = readdirSync(assets).filter((name) => name.endsWith('.wasm'));
if (wasm.length === 0) throw new Error(`no wasm in ${assets}: build first`);
for (const name of wasm) {
  const raw = readFileSync(join(assets, name));
  const size = gzipSync(raw, { level: 9 }).length;
  console.log(`${name}: ${raw.length} bytes, ${size} gzipped, budget ${BUDGET}`);
  if (size > BUDGET) process.exitCode = 1;
}
