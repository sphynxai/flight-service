// Ties the flight plan's times to the forecast.
//
// A briefing for a flight departing in three hours should not be a report of
// current conditions. Given the plan's proposed departure time and estimated
// elapsed time, this resolves ETD/ETA and pulls the TAF period that actually
// governs each — which is what a briefer does, and what Mike's "weather +/- 1
// hour of departure and arrival" checklist item is asking for.
//
// TAF semantics that matter here:
//   FM lines REPLACE the prevailing forecast from that point on.
//   TEMPO / PROB lines are conditional OVERLAYS within a period — they do not
//   replace the base. Reporting a PROB30 thunderstorm as the expected weather
//   would overstate it; ignoring it would hide it. They are returned separately.

/**
 * Resolve ETD/ETA as epoch seconds from a 4-digit UTC departure time and HHMM
 * elapsed time. Departure is taken as the next occurrence of that clock time —
 * a plan filed at 2350Z for 0010Z means tomorrow, not fifteen hours ago.
 */
export function resolveFlightTimes(departureHHMM, eetHHMM, nowMs = Date.now()) {
  if (!/^([01]\d|2[0-3])[0-5]\d$/.test(String(departureHHMM || ''))) return null;

  const hh = Number(String(departureHHMM).slice(0, 2));
  const mm = Number(String(departureHHMM).slice(2));

  const now = new Date(nowMs);
  const etd = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0, 0
  );

  // Within the last hour counts as "now-ish" rather than rolling to tomorrow,
  // so a plan filed just after the proposed time still briefs today.
  const etdMs = etd < nowMs - 3600000 ? etd + 86400000 : etd;

  let etaMs = null;
  if (/^\d{2}[0-5]\d$/.test(String(eetHHMM || ''))) {
    const eh = Number(String(eetHHMM).slice(0, 2));
    const em = Number(String(eetHHMM).slice(2));
    etaMs = etdMs + (eh * 60 + em) * 60000;
  }

  return {
    etd: Math.floor(etdMs / 1000),
    eta: etaMs === null ? null : Math.floor(etaMs / 1000),
    hoursToDeparture: Math.round(((etdMs - nowMs) / 3600000) * 10) / 10
  };
}

const isOverlay = (p) =>
  ['TEMPO', 'PROB'].includes(String(p?.fcstChange || '').toUpperCase()) ||
  p?.probability != null;

/**
 * The TAF period governing a moment, plus any conditional overlays covering it.
 * Returns null when the time falls outside the TAF's validity — an honest
 * "no forecast" rather than the nearest period pretending to cover it.
 */
export function forecastAt(periods, epochSeconds) {
  if (!Array.isArray(periods) || !periods.length || epochSeconds == null) return null;

  const t = Number(epochSeconds);
  const covers = (p) => Number(p.timeFrom) <= t && t < Number(p.timeTo);

  const base = periods.filter(p => covers(p) && !isOverlay(p)).pop() || null;
  const overlays = periods.filter(p => covers(p) && isOverlay(p));

  if (!base && !overlays.length) return null;
  return { base, overlays };
}

/** Ceiling from a decoded cloud list: first BKN/OVC layer. */
function ceilingOf(clouds) {
  const c = (clouds || []).find(x => x.cover === 'BKN' || x.cover === 'OVC');
  return c ? { cover: c.cover, base: c.base } : null;
}

/**
 * Flight category from forecast visibility and ceiling, per the standard
 * thresholds. NOAA does not publish fltCat on TAF periods the way it does on
 * METARs, so it is derived here — and only when both inputs are present, since
 * a category guessed from half the data is worse than none.
 */
export function categorise(visibSm, ceilingFt) {
  const v = typeof visibSm === 'string'
    ? (visibSm.includes('+') ? parseFloat(visibSm) : parseFloat(visibSm))
    : visibSm;
  const hasV = Number.isFinite(v);
  const hasC = Number.isFinite(ceilingFt);
  if (!hasV && !hasC) return null;

  // Missing ceiling means unlimited; missing visibility cannot be assumed.
  if (!hasV) return null;
  const c = hasC ? ceilingFt : Infinity;

  if (v < 1 || c < 500) return 'LIFR';
  if (v < 3 || c < 1000) return 'IFR';
  if (v <= 5 || c <= 3000) return 'MVFR';
  return 'VFR';
}

/** Compact, renderable summary of a forecast period. */
export function summarisePeriod(p) {
  if (!p) return null;
  const ceil = ceilingOf(p.clouds);
  return {
    from: p.timeFrom ?? null,
    to: p.timeTo ?? null,
    change: p.fcstChange || null,
    probability: p.probability ?? null,
    wdir: p.wdir ?? null,
    wspd: p.wspd ?? null,
    wgst: p.wgst ?? null,
    visib: p.visib ?? null,
    wxString: p.wxString || null,
    ceiling: ceil,
    category: categorise(p.visib, ceil ? ceil.base : null)
  };
}

/**
 * Mike's rule: check the hour either side of departure and arrival, because a
 * category change inside that window is what drives the alternate decision.
 * Returns the worst category found and the periods responsible.
 */
export function scanWindow(periods, centreEpoch, halfHours = 1) {
  if (!Array.isArray(periods) || centreEpoch == null) return null;

  const from = Number(centreEpoch) - halfHours * 3600;
  const to = Number(centreEpoch) + halfHours * 3600;
  const rank = { VFR: 3, MVFR: 2, IFR: 1, LIFR: 0 };

  const touching = periods.filter(p =>
    Number(p.timeFrom) < to && Number(p.timeTo) > from);

  const summaries = touching.map(summarisePeriod).filter(s => s && s.category);
  if (!summaries.length) return null;

  let worst = summaries[0];
  for (const s of summaries) {
    if ((rank[s.category] ?? 9) < (rank[worst.category] ?? 9)) worst = s;
  }

  return {
    windowHours: halfHours,
    worstCategory: worst.category,
    // An overlay driving the worst case is conditional, not expected.
    conditional: worst.probability != null ||
                 ['TEMPO', 'PROB'].includes(String(worst.change || '').toUpperCase()),
    driver: worst
  };
}
