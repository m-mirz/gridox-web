// Writes public/third-party-licenses.txt: the licences and notices of everything the site ships
// beside its own code. The bundle's minifier drops licence comments, so this file is where they go.
//
// The Rust crates are those the WebAssembly module is built from: cimlens-wasm's normal dependencies
// for wasm32-unknown-unknown, as cargo resolves them, less proc-macros (they run at build time and
// ship nothing). Each crate's own licence and notice files are copied; a crate from a git checkout
// takes its repository's when it has none of its own. The npm packages are those the bundle and the
// service worker include.
//
// LGPL-2.1-or-later code comes first, with what its licence asks of a distribution: the notice,
// where its source is, how to rebuild the module with a modified version of it, and the licence.
//
// Run from web/: `node scripts/licenses.mjs`. `npm run build` runs it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..');
const ROOT = resolve(WEB, '..');
const OUT = join(WEB, 'public', 'third-party-licenses.txt');

/** The npm packages whose code the built site carries. */
const NPM = ['cytoscape', 'svelte', 'clsx', 'esm-env', 'workbox-window', 'workbox-core', 'workbox-precaching', 'workbox-routing', 'workbox-strategies'];

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense|authors)([-._].*)?$/i;
const rule = (title) => `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`;

function licenceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8').trimEnd() }));
}

/** A crate's licence files; for one from a git checkout without its own, its repository's. */
function crateFiles(pkg) {
  let dir = dirname(pkg.manifest_path);
  const own = licenceFiles(dir);
  if (own.length || !pkg.source?.startsWith('git+')) return own;
  // In a checkout, …/checkouts/<repo>-<hash>/<rev>/…: up to the revision's root.
  while (dirname(dir) !== dir && !/[\\/]checkouts[\\/][^\\/]+[\\/][^\\/]+$/.test(dir)) {
    dir = dirname(dir);
    const found = licenceFiles(dir);
    if (found.length) return found;
  }
  return [];
}

/** Where a crate's source is: its git revision, else its crates.io release. */
function sourceOf(pkg) {
  const git = /^git\+(.*?)\?rev=([0-9a-f]+)/.exec(pkg.source ?? '');
  if (git) return `${git[1]} at commit ${git[2]}`;
  return `https://crates.io/crates/${pkg.name}/${pkg.version}${pkg.repository ? ` (repository ${pkg.repository})` : ''}`;
}

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', 'wasm32-unknown-unknown'], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  }).toString(),
);
const byId = new Map(metadata.packages.map((p) => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const isProcMacro = (pkg) => pkg.targets.some((t) => t.kind.includes('proc-macro'));

const start = metadata.packages.find((p) => p.name === 'cimlens-wasm');
const shipped = new Set();
const queue = [start.id];
while (queue.length) {
  const id = queue.pop();
  for (const dep of nodes.get(id)?.deps ?? []) {
    const normal = dep.dep_kinds.some((k) => k.kind === null);
    const pkg = byId.get(dep.pkg);
    if (!normal || isProcMacro(pkg) || shipped.has(dep.pkg)) continue;
    shipped.add(dep.pkg);
    queue.push(dep.pkg);
  }
}
const crates = [...shipped].map((id) => byId.get(id)).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch {
    return 'the commit this site was built from';
  }
})();
const repository = start.repository ?? 'https://github.com/m-mirz/cimlens';

const lgpl = crates.filter((c) => /LGPL/.test(c.license ?? ''));
const missing = [];
let out = `cimlens: the software in this site besides its own

cimlens (${repository}) is licensed under the Apache License 2.0. The site also carries the
libraries listed here, each under its own licence: the WebAssembly module
(assets/cimlens_wasm_bg-*.wasm) is built from ${crates.length} Rust crates, and the scripts include
${NPM.length} npm packages. Their licences and notices follow.
`;

out += rule('1. Code under the GNU Lesser General Public License 2.1 or later');
for (const c of lgpl) {
  out += `
${c.name} ${c.version} (licence: ${c.license}) is in the WebAssembly module, statically linked with
cimlens's own code and the other libraries below.
  Source: ${sourceOf(c)}
`;
  const provenance = join(dirname(c.manifest_path), 'src', 'klu_native', 'PROVENANCE.md');
  if (existsSync(provenance)) {
    out += `
Its module klu_native is a Rust translation of SuiteSparse's KLU and BTF (LGPL-2.1-or-later) and
AMD (BSD-3-Clause), whose notices follow. The file-by-file mapping is in
crates/gridoxide-sparse/src/klu_native/PROVENANCE.md of the source above.
`;
    const vendor = join(dirname(c.manifest_path), 'vendor', 'suitesparse');
    for (const lib of ['KLU', 'BTF', 'AMD']) {
      const file = join(vendor, lib, 'Doc', 'License.txt');
      if (existsSync(file)) out += `\n--- SuiteSparse ${lib}: Doc/License.txt ---\n${readFileSync(file, 'utf8').trimEnd()}\n`;
    }
  }
}
out += `
To use a modified version of this code: the complete source of this site is
${repository} at commit ${commit}. Add, or change, a [patch.crates-io] entry for
gridoxide in its Cargo.toml naming the modified library (a path or a git repository), then build
the site with \`npm run build\` in web/ (see its README), which relinks the WebAssembly module
with it.

--- GNU Lesser General Public License, version 2.1 ---
${readFileSync(join(WEB, 'licenses', 'LGPL-2.1.txt'), 'utf8').trimEnd()}
`;

out += rule('2. Rust crates in the WebAssembly module');
out += '\n' + crates.map((c) => `${c.name} ${c.version}: ${c.license ?? 'no licence field'}`).join('\n') + '\n';
for (const c of crates) {
  const files = crateFiles(c);
  out += `\n--- ${c.name} ${c.version} (${c.license ?? 'no licence field'}) ---\n`;
  out += `Source: ${sourceOf(c)}\n`;
  if (c.authors?.length) out += `Authors: ${c.authors.join(', ')}\n`;
  if (!files.length) {
    // The licence's standard text: MIT where it may be chosen, its holders the crate's authors.
    const expr = c.license ?? '';
    const holders = (c.authors ?? []).map((a) => a.replace(/\s*<[^>]*>/, '')).filter((a) => a).join(', ') || `the ${c.name} authors`;
    if (/\bMIT\b/.test(expr)) {
      out += `The package carries no licence file; the standard text of its licence, MIT:\n\n${readFileSync(join(WEB, 'licenses', 'MIT.txt'), 'utf8').replace('{holders}', holders).trimEnd()}\n`;
    } else if (/\bApache-2\.0\b/.test(expr)) {
      out += `The package carries no licence file; the standard text of its licence, Apache-2.0:\n\n${readFileSync(join(WEB, 'licenses', 'Apache-2.0.txt'), 'utf8').trimEnd()}\n`;
    } else {
      missing.push(`${c.name} ${c.version}`);
      out += 'The package carries no licence file; its licence is the one named above.\n';
    }
  }
  for (const f of files) out += `\n[${f.name}]\n${f.text}\n`;
}

out += rule('3. npm packages in the scripts');
for (const name of NPM) {
  const dir = join(WEB, 'node_modules', name);
  if (!existsSync(join(dir, 'package.json'))) {
    missing.push(`npm ${name} (not installed)`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const files = licenceFiles(dir);
  out += `\n--- ${name} ${pkg.version} (${pkg.license}) ---\n`;
  if (!files.length) missing.push(`npm ${name}`);
  for (const f of files) out += `\n[${f.name}]\n${f.text}\n`;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`third-party-licenses.txt: ${crates.length} crates (${lgpl.length} LGPL), ${NPM.length} npm packages`);
if (missing.length) console.warn(`  without a licence file: ${missing.join('; ')}`);
