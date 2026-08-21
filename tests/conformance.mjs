// Conformance suite: the JS and PHP implementations of the safety-critical
// decode paths must agree with the fixtures AND with each other.
//
// The FB parser and the METAR formatter exist twice — once in src/*.js for the
// Node app, once in deploy/kbmsolvedit/api.php for the PHP demo host. Nothing in
// the language prevents them drifting, and a drift here produces plausible,
// wrong weather rather than an error. This suite is what prevents that.
//
//   npm test
//
// Exits non-zero on any mismatch. Requires `php` on PATH for the PHP half; if
// php is missing the JS half still runs and the PHP half is reported SKIPPED
// (never silently passed).

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';

let failures = 0;
let checks = 0;

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(suite, name, actual, expected, why) {
  checks++;
  if (eq(actual, expected)) return;
  failures++;
  console.log(`${RED}FAIL${OFF}  ${suite} :: ${name}`);
  console.log(`        expected: ${JSON.stringify(expected)}`);
  console.log(`        actual:   ${JSON.stringify(actual)}`);
  if (why) console.log(`        ${DIM}${why}${OFF}`);
}

function run(cmd, args) {
  const raw = execFileSync(cmd, args, { cwd: here, encoding: 'utf8', maxBuffer: 8 << 20 });
  return JSON.parse(raw);
}

// ---------------------------------------------------------------- gather ---

const js = run(process.execPath, ['run-js.mjs']);

let php = null;
let phpError = null;
try {
  php = run('php', ['run-php.php']);
} catch (err) {
  phpError = err.message.split('\n')[0];
}

// ------------------------------------------------------ per-impl vs fixture ---

const groups = fx('fb-groups.json').cases;
const lines = fx('fb-lines.json').cases;
const levels = fx('levels.json').cases;
const stations = fx('metar-stations.json').cases;
const gairmetAlt = fx('gairmet-altitude.json').cases;
const fpFx = fx('flight-plan-encoding.json');
const toldFx = fx('told-interpolation.json');
const densityFx = fx('density-altitude.json');
const density = densityFx.cases;
const DA_TOLERANCE = densityFx.toleranceFt ?? 30;

// Density altitude is compared against externally published figures (Garmin),
// so it gets a tolerance rather than exact equality.
function checkNear(suite, name, actual, expected, tol, why) {
  checks++;
  const ok = (actual === null && expected === null) ||
             (typeof actual === 'number' && typeof expected === 'number' &&
              Math.abs(actual - expected) <= tol);
  if (ok) return;
  failures++;
  console.log(`${RED}FAIL${OFF}  ${suite} :: ${name}`);
  console.log(`        expected: ${expected} ±${tol}`);
  console.log(`        actual:   ${actual}`);
  if (why) console.log(`        ${DIM}${why}${OFF}`);
}

function verify(implName, impl) {
  groups.forEach((c, i) => {
    const expected = c.expect === null ? null : {
      dir: c.expect.dir, speed: c.expect.speed,
      temp: c.expect.temp, lightVariable: c.expect.lightVariable
    };
    check(`${implName}/fb-group`, `"${c.raw}"`, impl.groups[i], expected, c.why);
  });

  lines.forEach((c, i) => {
    const expected = c.expect === null ? null : { id: c.id, levels: c.expect };
    check(`${implName}/fb-line`, c.id ?? '(non-station row)', impl.lines[i], expected, c.why);
  });

  levels.forEach((c, i) => {
    check(`${implName}/level`, `${c.altitude} ft`, impl.levels[i], c.expect, c.why);
  });

  stations.forEach((c, i) => {
    check(`${implName}/metar`, c.icao, impl.stations[i], c.expect, c.why);
  });

  density.forEach((c, i) => {
    checkNear(`${implName}/density-alt`, c.icao, impl.density[i],
              c.expectDensityAltitude, DA_TOLERANCE, c.why);
  });

  // Flight-plan encoding lives in the Node app only — the PHP demo host does
  // not prepare flight plans, so there is nothing to compare against there.
  if (impl.fpLevels) {
    fpFx.levels.forEach((c, i) =>
      check(`${implName}/fp-level`, `${c.ft} ft ${c.rules}`, impl.fpLevels[i], c.expect, c.why));
    fpFx.speeds.forEach((c, i) =>
      check(`${implName}/fp-speed`, `${c.kt} kt`, impl.fpSpeeds[i], c.expect, c.why));
    fpFx.durations.forEach((c, i) =>
      check(`${implName}/fp-duration`, `${c.min} min`, impl.fpDurations[i], c.expect, c.why));
    fpFx.enroute.forEach((c, i) => {
      const expected = c.expectMinutes === null
        ? null
        : { minutes: c.expectMinutes, groundSpeed: c.expectGroundSpeed };
      check(`${implName}/fp-eet`, c.why.slice(0, 40), impl.fpEnroute[i], expected, c.why);
    });
  }

  // TOLD is JS-only: it is gated off until a human verifies the POH tables, so
  // there is nothing to port yet.
  if (impl.toldInterp) {
    toldFx.interpolation.forEach((c, i) =>
      check(`${implName}/told-interp`, `${c.pressureAlt}ft ${c.tempC}C`, impl.toldInterp[i], c.expect, c.why));
    toldFx.corrections.forEach((c, i) =>
      check(`${implName}/told-corr`, JSON.stringify(c.opts), impl.toldCorr[i], c.expect, c.why));
    // The gate is a safety control, so it is tested like one.
    check(`${implName}/told-gate`, 'unverified table must not be usable',
          impl.toldGate, { usable: false, unverified: true },
          'An unverified performance table must never produce usable planning figures.');
  }

  // Ported to JS first; the PHP half is checked once api.php grows hazards.
  if (impl.gairmetAlt) {
    gairmetAlt.forEach((c, i) => {
      const expected = c.expectLabel === null
        ? null
        : { ft: c.expectFt, label: c.expectLabel };
      check(`${implName}/gairmet-alt`, JSON.stringify(c.raw), impl.gairmetAlt[i], expected, c.why);
    });
  } else {
    notPorted.push(`${implName}: gairmet-alt`);
  }
}

const notPorted = [];

verify('JS', js);
if (php) verify('PHP', php);

// ----------------------------------------------------------- cross-impl ---

if (php) {
  // Only diff suites both implementations actually produce.
  const shared = ['groups', 'lines', 'levels', 'stations', 'density', 'gairmetAlt',
                  'fpLevels', 'fpSpeeds', 'fpDurations', 'fpEnroute']
    .filter(k => Array.isArray(js[k]) && Array.isArray(php[k]));

  for (const key of shared) {
    js[key].forEach((v, i) => {
      const label = {
        groups: () => `"${groups[i].raw}"`,
        lines: () => lines[i].id ?? '(non-station row)',
        levels: () => `${levels[i].altitude} ft`,
        stations: () => stations[i].icao,
        density: () => density[i].icao,
        gairmetAlt: () => JSON.stringify(gairmetAlt[i].raw),
        fpLevels: () => `${fpFx.levels[i].ft} ft`,
        fpSpeeds: () => `${fpFx.speeds[i].kt} kt`,
        fpDurations: () => `${fpFx.durations[i].min} min`,
        fpEnroute: () => `eet case ${i + 1}`
      }[key]();
      check('JS<->PHP drift', `${key} ${label}`, php[key][i], v,
            'the two implementations disagree — one of them is wrong');
    });
  }
}

// -------------------------------------------------------------- report ---

console.log('');
if (phpError) {
  console.log(`${YELLOW}SKIPPED${OFF} PHP half — could not run \`php\`: ${phpError}`);
  console.log(`${YELLOW}        The JS<->PHP drift check did NOT run.${OFF}`);
}

if (notPorted.length) {
  console.log(`${YELLOW}NOT PORTED${OFF} ${notPorted.join(', ')} — no cross-implementation check for these yet.`);
}

if (failures === 0) {
  console.log(`${GREEN}PASS${OFF}  ${checks} checks` + (php ? ' (JS + PHP + drift)' : ' (JS only)'));
  process.exit(phpError ? 1 : 0);
}

console.log(`${RED}FAIL${OFF}  ${failures} of ${checks} checks failed`);
process.exit(1);
