// Runs the shared fixtures through the JavaScript implementation and emits
// normalized results as JSON on stdout. Consumed by conformance.mjs.
// Never prints anything else — stdout must stay parseable.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { parseGroup, parseStationLine, nearestLevel } from '../src/winds-fetcher.js';
import { computeAltitudes } from '../src/weather-fetcher.js';
import { gairmetAltitude, routeBounds, boundsIntersect } from '../src/hazards-fetcher.js';
import { describeStation } from '../src/briefing-agent.js';
import { encodeLevel, encodeSpeed, encodeDuration, estimateEnrouteMinutes } from '../src/flight-plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const norm = (g) => g === null || g === undefined ? null : {
  dir: g.dir ?? null,
  speed: g.speed ?? null,
  temp: g.temp ?? null,
  lightVariable: Boolean(g.lightVariable)
};

const out = {
  groups: [], lines: [], levels: [], stations: [], density: [], gairmetAlt: [],
  fpLevels: [], fpSpeeds: [], fpDurations: [], fpEnroute: []
};

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
  out.stations.push(describeStation(c.label, c.icao, c.metar, c.taf ?? null));
}

for (const c of fx('density-altitude.json').cases) {
  out.density.push(computeAltitudes(c.input).densityAltitude);
}

for (const c of fx('gairmet-altitude.json').cases) {
  const a = gairmetAltitude(c.raw);
  out.gairmetAlt.push(a === null ? null : { ft: a.ft, label: a.label });
}

const fp = fx('flight-plan-encoding.json');
for (const c of fp.levels) out.fpLevels.push(encodeLevel(c.ft, c.rules));
for (const c of fp.speeds) out.fpSpeeds.push(encodeSpeed(c.kt));
for (const c of fp.durations) out.fpDurations.push(encodeDuration(c.min));
for (const c of fp.enroute) {
  const r = estimateEnrouteMinutes(c.input);
  out.fpEnroute.push(r === null ? null : { minutes: r.minutes, groundSpeed: r.groundSpeed });
}

process.stdout.write(JSON.stringify(out));
