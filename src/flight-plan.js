// FAA Form 7233-4 (International Flight Plan) — preparation, not filing.
//
// ‼️ This module does NOT file anything. A flight plan can only reach the FAA
// through Leidos Flight Service (the FAA's contractor), whose /rest/FP/file
// endpoint is gated behind Service Provider Authorization. Everything here
// produces a complete, validated plan the pilot reviews and then files. Any
// wording that implies otherwise is a defect.
//
// Field rules follow FAA Form 7233-4 rev 07/2023 and the AIM Appendix 4
// instructions. The domestic mandatory set is Items 7, 8, 9, 10, 13, 15, 16 and
// the Item 19 search-and-rescue block (endurance, souls on board, colour, PIC).

const EARTH_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Item 15 level: below 18,000 ft is altitude in hundreds (A040); FL180+ is F300. */
export function encodeLevel(altitudeFt, flightRules = 'V') {
  const n = Number(altitudeFt);
  if (!Number.isFinite(n) || n <= 0) return flightRules === 'V' ? 'VFR' : null;
  const hundreds = Math.round(n / 100);
  if (n >= 18000) return `F${String(hundreds).padStart(3, '0')}`;
  return `A${String(hundreds).padStart(3, '0')}`;
}

/** Item 15 cruising speed in knots TAS: 110 -> "N0110". */
export function encodeSpeed(knots) {
  const n = Math.round(Number(knots));
  if (!Number.isFinite(n) || n <= 0) return null;
  return `N${String(n).padStart(4, '0')}`;
}

/** HHMM from minutes. Item 16 EET and Item 19 endurance both use this. */
export function encodeDuration(minutes) {
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 0) return null;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

/** Great-circle distance in nm. */
export function greatCircleNm(a, b) {
  const vals = [a?.lat, a?.lon, b?.lat, b?.lon].map(Number);
  if (vals.some(v => !Number.isFinite(v))) return null;
  const [la1, lo1, la2, lo2] = vals;
  const h = Math.sin(rad(la2 - la1) / 2) ** 2 +
            Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * EARTH_NM;
}

/** Initial great-circle course in degrees true. */
export function courseDeg(a, b) {
  const vals = [a?.lat, a?.lon, b?.lat, b?.lon].map(Number);
  if (vals.some(v => !Number.isFinite(v))) return null;
  const [la1, lo1, la2, lo2] = vals;
  const dLon = rad(lo2 - lo1);
  const y = Math.sin(dLon) * Math.cos(rad(la2));
  const x = Math.cos(rad(la1)) * Math.sin(rad(la2)) -
            Math.sin(rad(la1)) * Math.cos(rad(la2)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Estimated elapsed time using the forecast wind at the filed level.
 *
 * Headwind component = windSpeed * cos(windFrom - track). Groundspeed is
 * approximated as TAS minus that component — the standard planning shortcut,
 * which ignores the small drift correction from the crosswind term. It is an
 * ESTIMATE and is labelled as one; the pilot owns the number they file.
 */
export function estimateEnrouteMinutes({ distanceNm, tasKnots, windDir, windSpeed, trackDeg }) {
  const d = Number(distanceNm), tas = Number(tasKnots);
  if (!Number.isFinite(d) || !Number.isFinite(tas) || tas <= 0) return null;

  let groundSpeed = tas;
  let headwind = null;

  if (Number.isFinite(Number(windDir)) && Number.isFinite(Number(windSpeed)) &&
      Number.isFinite(Number(trackDeg))) {
    headwind = Number(windSpeed) * Math.cos(rad(Number(windDir) - Number(trackDeg)));
    groundSpeed = tas - headwind;
  }

  // A forecast headwind at or above TAS means the plan is not flyable as filed;
  // report that rather than emitting a negative or absurd time.
  if (groundSpeed <= 5) return null;

  return {
    minutes: Math.round((d / groundSpeed) * 60),
    groundSpeed: Math.round(groundSpeed),
    headwindComponent: headwind == null ? null : Math.round(headwind)
  };
}

// Wake turbulence category is set by maximum certificated take-off mass:
// L <= 15,500 lb, M < 300,000 lb, H >= 300,000 lb (FAA Order 7360.1).
// Only unambiguous common types are pre-filled; anything else is left for the
// pilot rather than guessed.
const WAKE_BY_TYPE = {
  C172: 'L', C152: 'L', C182: 'L', C206: 'L', C210: 'L',
  PA28: 'L', PA32: 'L', PA44: 'L', BE33: 'L', BE35: 'L', BE36: 'L',
  SR20: 'L', SR22: 'L', DA40: 'L', DA42: 'L', M20P: 'L', C72R: 'L',
  BE20: 'M', C25A: 'M', C56X: 'M', E55P: 'M', PC12: 'L',
  B738: 'M', A320: 'M', E170: 'M', CRJ2: 'M',
  B744: 'H', B748: 'H', B77W: 'H', A388: 'H', B763: 'H', A333: 'H'
};

// Typical cruise TAS, used only as a starting suggestion.
const TAS_BY_TYPE = {
  C172: 110, C152: 95, C182: 140, C206: 145, PA28: 115,
  SR20: 155, SR22: 180, DA40: 150, BE36: 170, M20P: 165,
  BE20: 270, PC12: 270, C25A: 400,
  B738: 450, A320: 450, CRJ2: 420, B744: 490
};

export function suggestWake(type) {
  return WAKE_BY_TYPE[String(type || '').toUpperCase()] || null;
}
export function suggestTas(type) {
  return TAS_BY_TYPE[String(type || '').toUpperCase()] || null;
}

const REQUIRED = [
  ['aircraftId', 'Item 7 — aircraft identification'],
  ['flightRules', 'Item 8 — flight rules'],
  ['typeOfFlight', 'Item 8 — type of flight'],
  ['aircraftType', 'Item 9 — type of aircraft'],
  ['wakeCategory', 'Item 9 — wake turbulence category'],
  ['equipment', 'Item 10 — equipment and capabilities'],
  ['departure', 'Item 13 — departure aerodrome'],
  ['departureTime', 'Item 13 — proposed departure time (UTC)'],
  ['cruisingSpeed', 'Item 15 — cruising speed'],
  ['destination', 'Item 16 — destination aerodrome'],
  ['eet', 'Item 16 — total estimated elapsed time'],
  ['endurance', 'Item 19 — fuel endurance'],
  ['personsOnBoard', 'Item 19 — persons on board'],
  ['aircraftColour', 'Item 19 — aircraft colour and markings'],
  ['pilotInCommand', 'Item 19 — pilot in command and contact']
];

/**
 * Validates and assembles a 7233-4. Returns errors (blocking) separately from
 * warnings (worth a look but not malformed).
 */
export function buildFlightPlan(input = {}) {
  const f = { ...input };
  const errors = [];
  const warnings = [];

  f.flightRules = String(f.flightRules || 'V').toUpperCase();
  f.typeOfFlight = String(f.typeOfFlight || 'G').toUpperCase();

  for (const [key, label] of REQUIRED) {
    const v = f[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      errors.push(`Missing ${label}.`);
    }
  }

  if (f.aircraftId && !/^[A-Z0-9]{2,7}$/.test(String(f.aircraftId).toUpperCase())) {
    errors.push('Item 7 — aircraft identification must be 2–7 letters or digits, no hyphen (N123AB).');
  }
  if (f.flightRules && !['I', 'V', 'Y', 'Z'].includes(f.flightRules)) {
    errors.push('Item 8 — flight rules must be I, V, Y or Z.');
  }
  if (f.typeOfFlight && !['S', 'N', 'G', 'M', 'X'].includes(f.typeOfFlight)) {
    errors.push('Item 8 — type of flight must be S, N, G, M or X.');
  }
  if (f.aircraftType && !/^[A-Z0-9]{2,4}$/.test(String(f.aircraftType).toUpperCase())) {
    errors.push('Item 9 — aircraft type must be the 2–4 character ICAO designator (C172).');
  }
  if (f.wakeCategory && !['L', 'M', 'H', 'J'].includes(String(f.wakeCategory).toUpperCase())) {
    errors.push('Item 9 — wake category must be L, M, H or J.');
  }
  if (f.departureTime && !/^([01]\d|2[0-3])[0-5]\d$/.test(String(f.departureTime))) {
    errors.push('Item 13 — departure time must be 4-digit UTC, 0000–2359.');
  }
  if (f.eet && !/^\d{2}[0-5]\d$/.test(String(f.eet))) {
    errors.push('Item 16 — estimated elapsed time must be HHMM.');
  }
  if (f.endurance && !/^\d{2}[0-5]\d$/.test(String(f.endurance))) {
    errors.push('Item 19 — endurance must be HHMM.');
  }
  if (f.personsOnBoard && !/^(\d{1,3}|TBN)$/.test(String(f.personsOnBoard).toUpperCase())) {
    errors.push('Item 19 — persons on board must be a number, or TBN if not yet known.');
  }

  // Endurance below elapsed time is a fuel-planning error, not a format error.
  if (/^\d{4}$/.test(String(f.eet || '')) && /^\d{4}$/.test(String(f.endurance || ''))) {
    const mins = (s) => Number(String(s).slice(0, 2)) * 60 + Number(String(s).slice(2));
    if (mins(f.endurance) <= mins(f.eet)) {
      warnings.push('Item 19 — endurance does not exceed estimated elapsed time. Check fuel reserves.');
    }
  }

  const speed = encodeSpeed(f.cruisingSpeed);
  const level = encodeLevel(f.altitude, f.flightRules);
  if (f.cruisingSpeed && !speed) errors.push('Item 15 — cruising speed must be knots TAS.');

  const route = String(f.route || 'DCT').toUpperCase().trim() || 'DCT';
  const item18 = String(f.otherInformation || '').trim() || '0';

  const item15 = [speed, level, route].filter(Boolean).join(' ');
  const item19 = [
    `E/${f.endurance || ''}`,
    `P/${String(f.personsOnBoard || '').toUpperCase()}`,
    `A/${String(f.aircraftColour || '').toUpperCase()}`,
    `C/${String(f.pilotInCommand || '').toUpperCase()}`
  ].join(' ');

  // The single-line form a briefer reads back.
  const icao =
    `(FPL-${String(f.aircraftId || '').toUpperCase()}-${f.flightRules}${f.typeOfFlight}\n` +
    `-${String(f.aircraftType || '').toUpperCase()}/${String(f.wakeCategory || '').toUpperCase()}` +
    `-${String(f.equipment || '').toUpperCase()}\n` +
    `-${String(f.departure || '').toUpperCase()}${f.departureTime || ''}\n` +
    `-${item15}\n` +
    `-${String(f.destination || '').toUpperCase()}${f.eet || ''}\n` +
    `-${item18}\n` +
    `-${item19})`;

  return {
    ready: errors.length === 0,
    errors,
    warnings,
    encoded: { item15, item18, item19, speed, level },
    icao,
    // Shape matching the Leidos /rest/FP/file parameters, for when vendor
    // authorization exists. Not sent anywhere today.
    leidos: {
      type: 'ICAO',
      flightRules: f.flightRules === 'I' ? 'IFR' : 'VFR',
      aircraftIdentifier: String(f.aircraftId || '').toUpperCase(),
      departure: String(f.departure || '').toUpperCase(),
      destination: String(f.destination || '').toUpperCase(),
      departureInstant: f.departureTime || null,
      flightDuration: f.eet || null
    }
  };
}

/** Everything the briefing already knows, so the pilot types as little as possible. */
export function prefillFromBriefing(data = {}) {
  const dep = data.weather?.departure;
  const arr = data.weather?.arrival;
  const type = String(data.aircraft || '').toUpperCase() || null;

  const from = { lat: dep?.metar?.lat, lon: dep?.metar?.lon };
  const to = { lat: arr?.metar?.lat, lon: arr?.metar?.lon };
  const distanceNm = greatCircleNm(from, to);
  const trackDeg = courseDeg(from, to);

  const tas = suggestTas(type);
  const w = data.winds?.departure?.available ? data.winds.departure : data.winds?.arrival;

  const est = (distanceNm != null && tas)
    ? estimateEnrouteMinutes({
        distanceNm, tasKnots: tas,
        windDir: w?.available && !w.lightVariable ? w.dir : null,
        windSpeed: w?.available && !w.lightVariable ? w.speed : null,
        trackDeg
      })
    : null;

  return {
    departure: dep?.airport || null,
    destination: arr?.airport || null,
    aircraftType: type,
    wakeCategory: suggestWake(type),
    altitude: data.altitude || null,
    cruisingSpeed: tas,
    route: 'DCT',
    eet: est ? encodeDuration(est.minutes) : null,
    derived: {
      distanceNm: distanceNm == null ? null : Math.round(distanceNm),
      trackDeg: trackDeg == null ? null : Math.round(trackDeg),
      groundSpeed: est?.groundSpeed ?? null,
      headwindComponent: est?.headwindComponent ?? null,
      tasSource: tas ? 'typical cruise for type — confirm against your aircraft' : null
    }
  };
}
