// Runs the shared fixtures through the JavaScript implementation and emits
// normalized results as JSON on stdout. Consumed by conformance.mjs.
// Never prints anything else — stdout must stay parseable.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { parseGroup, parseStationLine, nearestLevel } from '../src/winds-fetcher.js';
import { describeStation } from '../src/briefing-agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const norm = (g) => g === null || g === undefined ? null : {
  dir: g.dir ?? null,
  speed: g.speed ?? null,
  temp: g.temp ?? null,
  lightVariable: Boolean(g.lightVariable)
};

const out = { groups: [], lines: [], levels: [], stations: [] };

for (const c of fx('fb-groups.json').cases) {
  out.groups.push(norm(parseGroup(c.raw)));
}

for (const c of fx('fb-lines.json').cases) {
  const parsed = parseStationLine(c.line);
  if (!parsed) { out.lines.push(null); continue; }
  // Compare column alignment only: level -> the raw group found there.
  const levels = {};
  for (const [ft, g] of Object.entries(parsed.levels)) levels[ft] = g.raw;
  out.lines.push({ id: parsed.id, levels });
}

for (const c of fx('levels.json').cases) {
  out.levels.push(nearestLevel(c.altitude));
}

for (const c of fx('metar-stations.json').cases) {
  out.stations.push(describeStation(c.label, c.icao, c.metar));
}

process.stdout.write(JSON.stringify(out));
