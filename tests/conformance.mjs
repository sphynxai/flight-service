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
}

verify('JS', js);
if (php) verify('PHP', php);

// ----------------------------------------------------------- cross-impl ---

if (php) {
  for (const key of ['groups', 'lines', 'levels', 'stations']) {
    js[key].forEach((v, i) => {
      const label = {
        groups: () => `"${groups[i].raw}"`,
        lines: () => lines[i].id ?? '(non-station row)',
        levels: () => `${levels[i].altitude} ft`,
        stations: () => stations[i].icao
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

if (failures === 0) {
  console.log(`${GREEN}PASS${OFF}  ${checks} checks` + (php ? ' (JS + PHP + drift)' : ' (JS only)'));
  process.exit(phpError ? 1 : 0);
}

console.log(`${RED}FAIL${OFF}  ${failures} of ${checks} checks failed`);
process.exit(1);
