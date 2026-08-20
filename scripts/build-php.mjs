// Generates deploy/kbmsolvedit/index.php from web/index.html.
//
// The PHP demo host serves the same UI as the Node app; the only difference is
// where the browser posts. Keeping this as a script rather than a remembered
// shell one-liner means the generation step survives the person who ran it, and
// nobody is tempted to hand-edit the .php copy (which would silently drift).
//
//   npm run build:php
//
// Note: no .html twin is ever written into the deploy directory — on that host
// .html twins of PHP files are served as raw source.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'web', 'index.html');
const OUT = join(root, 'deploy', 'kbmsolvedit', 'index.php');

// Each entry must appear exactly once; a miss means the page was restructured
// and the generated copy would silently point at the wrong endpoint.
const REWRITES = [
  ["fetch('/api/briefing'", "fetch('api.php'"],
  ["const fpPlanUrl = '/api/flight-plan';", "const fpPlanUrl = 'api.php?action=flight-plan';"]
];

const src = readFileSync(SRC, 'utf8');

let out = src;
for (const [from, to] of REWRITES) {
  const occurrences = src.split(from).length - 1;
  if (occurrences !== 1) {
    console.error(`build:php FAILED — expected exactly 1 occurrence of:\n  ${from}\nfound ${occurrences}.`);
    console.error('The page was renamed or restructured; update this script to match.');
    process.exit(1);
  }
  out = out.replaceAll(from, to);
}
writeFileSync(OUT, out, 'utf8');

console.log(`build:php OK`);
console.log(`  web/index.html                 ${Buffer.byteLength(src)} bytes`);
console.log(`  deploy/kbmsolvedit/index.php   ${Buffer.byteLength(out)} bytes`);
