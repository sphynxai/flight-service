// TOLD — Takeoff and Landing Data.
//
// Mike's first checklist item. "TOLD" is a term of art: the COMPUTED performance
// numbers (ground roll, distance over a 50 ft obstacle, landing distance) for
// which temperature and pressure altitude are the inputs. Density altitude is an
// input to TOLD, not TOLD itself.
//
// ‼️ SAFETY GATE. Every performance table carries `verified: false` until a human
// has checked it cell-by-cell against the actual POH for that airframe. While a
// table is unverified this module returns the computation but marks it
// `usable: false` with a reason, and callers MUST NOT present the numbers as
// planning figures. Publishing a wrong takeoff distance is not a display bug —
// a pilot can plan a departure they cannot make.
//
// The interpolation is bilinear over the published pressure-altitude x
// temperature grid. Values are NEVER extrapolated beyond the table: outside the
// published envelope this reports "outside the published data" rather than
// inventing a number, because the POH stops where the manufacturer stopped
// testing.

/** Linear interpolation factor, clamped so callers cannot extrapolate. */
function lerpFactor(v, lo, hi) {
  if (hi === lo) return 0;
  return (v - lo) / (hi - lo);
}

function bracket(sortedKeys, value) {
  if (value < sortedKeys[0] || value > sortedKeys[sortedKeys.length - 1]) return null;
  for (let i = 0; i < sortedKeys.length - 1; i++) {
    if (value >= sortedKeys[i] && value <= sortedKeys[i + 1]) {
      return [sortedKeys[i], sortedKeys[i + 1]];
    }
  }
  return null;
}

/**
 * Bilinear lookup over grid[pressureAlt][tempC] = [groundRoll, over50ft].
 * Returns null when either axis falls outside the published envelope.
 */
export function interpolate(grid, pressureAltFt, tempC) {
  const alts = Object.keys(grid).map(Number).sort((a, b) => a - b);
  const altPair = bracket(alts, pressureAltFt);
  if (!altPair) return null;

  const temps = Object.keys(grid[alts[0]]).map(Number).sort((a, b) => a - b);
  const tempPair = bracket(temps, tempC);
  if (!tempPair) return null;

  const [a0, a1] = altPair;
  const [t0, t1] = tempPair;
  const fa = lerpFactor(pressureAltFt, a0, a1);
  const ft = lerpFactor(tempC, t0, t1);

  const at = (a, t) => grid[a][t];
  const out = [];

  for (let i = 0; i < 2; i++) {
    const v00 = at(a0, t0)[i], v01 = at(a0, t1)[i];
    const v10 = at(a1, t0)[i], v11 = at(a1, t1)[i];
    const lo = v00 + (v01 - v00) * ft;
    const hi = v10 + (v11 - v10) * ft;
    out.push(Math.round(lo + (hi - lo) * fa));
  }

  return { groundRoll: out[0], over50ft: out[1] };
}

/**
 * POH corrections, applied in the order the handbook states them.
 *
 * Each is a documented adjustment, not an estimate. Anything the table does not
 * cover is reported as an unapplied caveat rather than approximated — a
 * correction invented here would be indistinguishable from a published one.
 */
export function applyCorrections(base, { headwindKt = 0, surface = 'paved', slope = 0 } = {}, table) {
  if (!base) return null;

  const applied = [];
  const caveats = [];
  let roll = base.groundRoll;
  let over = base.over50ft;

  const c = table.corrections || {};

  // Headwind and tailwind are corrected differently, and tailwind is the
  // dangerous direction — never treat a negative headwind as a small benefit.
  if (headwindKt > 0 && c.headwindPer9kt) {
    const steps = headwindKt / 9;
    const factor = Math.pow(1 - c.headwindPer9kt, steps);
    roll = Math.round(roll * factor);
    over = Math.round(over * factor);
    applied.push(`${Math.round(headwindKt)} kt headwind`);
  } else if (headwindKt < 0 && c.tailwindPer2kt) {
    const steps = Math.abs(headwindKt) / 2;
    const factor = Math.pow(1 + c.tailwindPer2kt, steps);
    roll = Math.round(roll * factor);
    over = Math.round(over * factor);
    applied.push(`${Math.round(Math.abs(headwindKt))} kt TAILWIND`);
  }

  if (surface === 'grass' && c.dryGrassGroundRollPct) {
    const add = Math.round(roll * c.dryGrassGroundRollPct);
    roll += add;
    over += add;
    applied.push('dry grass runway');
  } else if (surface !== 'paved') {
    caveats.push(`No published correction for a ${surface} surface — figures are for a paved runway.`);
  }

  if (slope) caveats.push('Runway slope is not corrected; the POH table assumes level.');

  return { groundRoll: roll, over50ft: over, applied, caveats };
}

/**
 * Compute TOLD for a departure.
 *
 * Returns { usable, reason, ... }. `usable` is false — and the numbers must not
 * be shown as planning figures — when the table is unverified, the conditions
 * fall outside the published envelope, or a required input is missing.
 */
export function computeTold({ table, pressureAltitude, temperatureC, headwindKt = 0,
                              surface = 'paved', runwayLengthFt = null }) {
  if (!table) {
    return { usable: false, reason: 'no performance data for this aircraft type' };
  }

  if (!table.verified) {
    // Deliberate hard gate — see the header note.
    return {
      usable: false,
      reason: `performance table for ${table.aircraft} has not been verified against the POH`,
      aircraft: table.aircraft,
      unverified: true
    };
  }

  if (pressureAltitude == null || temperatureC == null) {
    return { usable: false, reason: 'pressure altitude and temperature are both required' };
  }

  const takeoff = interpolate(table.takeoff.grid, pressureAltitude, temperatureC);
  if (!takeoff) {
    return {
      usable: false,
      aircraft: table.aircraft,
      reason: 'conditions are outside the published performance data — ' +
              'consult the POH directly rather than extrapolating'
    };
  }

  const corrected = applyCorrections(takeoff, { headwindKt, surface }, table.takeoff);

  let margin = null;
  if (runwayLengthFt) {
    margin = {
      runwayFt: runwayLengthFt,
      // Compared against the 50 ft obstacle distance, not ground roll — clearing
      // the obstacle is the number that matters on a short field.
      remainingFt: runwayLengthFt - corrected.over50ft,
      ratio: Math.round((corrected.over50ft / runwayLengthFt) * 100)
    };
  }

  return {
    usable: true,
    aircraft: table.aircraft,
    configuration: table.takeoff.configuration,
    weightLb: table.takeoff.weightLb,
    inputs: { pressureAltitude, temperatureC, headwindKt, surface },
    uncorrected: takeoff,
    groundRoll: corrected.groundRoll,
    over50ft: corrected.over50ft,
    correctionsApplied: corrected.applied,
    caveats: corrected.caveats,
    margin,
    source: table.source,
    // Always stated. TOLD is the pilot's responsibility, not ours.
    disclaimer: 'Computed from published performance data at the stated weight and ' +
                'configuration. Verify against your own POH and actual aircraft weight ' +
                'before flight.'
  };
}
