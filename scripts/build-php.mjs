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

const FROM = "fetch('/api/briefing'";
const TO = "fetch('api.php'";

const src = readFileSync(SRC, 'utf8');

if (!src.includes(FROM)) {
  console.error(`build:php FAILED — marker not found in web/index.html: ${FROM}`);
  console.error('The fetch call was renamed or restructured; update this script to match.');
  process.exit(1);
}

const occurrences = src.split(FROM).length - 1;
if (occurrences !== 1) {
  console.error(`build:php FAILED — expected exactly 1 occurrence of the marker, found ${occurrences}.`);
  process.exit(1);
}

const out = src.replaceAll(FROM, TO);
writeFileSync(OUT, out, 'utf8');

console.log(`build:php OK`);
console.log(`  web/index.html                 ${Buffer.byteLength(src)} bytes`);
console.log(`  deploy/kbmsolvedit/index.php   ${Buffer.byteLength(out)} bytes`);
