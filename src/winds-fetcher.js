// Winds and temperatures aloft from the NOAA FB (FD) forecast product.
//
// NOAA publishes FB only as a fixed-width text bulletin — there is no decoded
// JSON form — so this module has to parse it. Two things make that risky, and
// both are handled explicitly below:
//
//   1. Columns are FIXED WIDTH, not whitespace-delimited. High-elevation
//      stations omit low levels entirely (DEN's line begins at the 9,000 ft
//      column), so splitting on spaces silently reports 9,000 ft winds as
//      3,000 ft. Always slice by offset.
//   2. Direction 51-86 encodes wind over 99 kt (subtract 50, add 100 kt).
//      Missing that rule turns a 130 kt jet core into a 30 kt breeze.
//
// The raw group is carried through to the UI so a pilot can verify the decode.

import axios from 'axios';

const FD_BASE = 'https://aviationweather.gov/api/data/windtemp';
const REGIONS = ['bos', 'chi', 'dfw', 'mia', 'slc', 'sfo'];
const CACHE_TTL = 3600000; // FB issues ~4x daily

// Fixed column offsets, [start, end), matching the product header:
// FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
const LEVEL_COLUMNS = [
  { ft: 3000, start: 4, end: 8 },
  { ft: 6000, start: 9, end: 16 },
  { ft: 9000, start: 17, end: 24 },
  { ft: 12000, start: 25, end: 32 },
  { ft: 18000, start: 33, end: 40 },
  { ft: 24000, start: 41, end: 48 },
  { ft: 30000, start: 49, end: 55 },
  { ft: 34000, start: 56, end: 62 },
  { ft: 39000, start: 63, end: 69 }
];

// FB station IDs are not ICAO codes. Most resolve by dropping the leading K,
// but a few busy airports have no FB station of their own and are represented
// by another field in the same metro. Those are listed here so the
// substitution is deliberate — and the station ID is surfaced in the UI so the
// reader can see which field the forecast is actually for. Airports with no
// defensible nearby station are left out and reported unavailable.
const ICAO_TO_FB = {
  KDFW: 'DAL' // Dallas/Fort Worth -> Dallas Love, ~15 nm; immaterial at cruise
};

let tableCache = null;

// Exported for decode tests — summer bulletins rarely carry a >99 kt group.
export function parseGroup(text) {
  const g = text.trim();
  if (!g || g.length < 4) return null;

  const dd = g.slice(0, 2);
  const ff = g.slice(2, 4);

  // 9900 = light and variable (below 5 kt)
  const lightVariable = dd === '99' && ff === '00';

  let dir = null;
  let speed = null;

  if (!lightVariable) {
    let d = parseInt(dd, 10);
    let s = parseInt(ff, 10);
    if (Number.isNaN(d) || Number.isNaN(s)) return null;

    // Direction 51-86 flags wind >= 100 kt.
    if (d >= 51 && d <= 86) {
      d -= 50;
      s += 100;
    }
    dir = d * 10;
    speed = s;

    // Valid dd is 01-36, 51-86, or 99. Anything else yields an impossible
    // bearing — report nothing rather than print a 500 degree wind.
    if (dir > 360) return null;
  }

  // Temp is signed at/below 24,000 ft and unsigned (always negative) above it.
  let temp = null;
  const tempPart = g.slice(4);
  if (tempPart.length) {
    const n = parseInt(tempPart.replace('+', ''), 10);
    if (!Number.isNaN(n)) temp = tempPart.startsWith('+') ? n : -Math.abs(n);
  }

  return { dir, speed, temp, lightVariable, raw: g };
}

async function fetchRegion(region) {
  const url = `${FD_BASE}?region=${region}&fcst=06&level=low`;
  const { data } = await axios.get(url, { timeout: 10000 });
  if (typeof data !== 'string') return { stations: {}, validity: null };

  const lines = data.split('\n');
  const validity = lines.find(l => l.startsWith('VALID'))?.trim() || null;
  const headerIdx = lines.findIndex(l => l.trimStart().startsWith('FT'));
  if (headerIdx === -1) return { stations: {}, validity };

  const stations = {};
  for (const line of lines.slice(headerIdx + 1)) {
    const id = line.slice(0, 3).trim();
    if (!/^[A-Z0-9]{3}$/.test(id)) continue;

    const levels = {};
    for (const col of LEVEL_COLUMNS) {
      const parsed = parseGroup(line.slice(col.start, col.end));
      if (parsed) levels[col.ft] = parsed;
    }
    if (Object.keys(levels).length) stations[id] = { region, levels };
  }

  return { stations, validity };
}

async function getTable() {
  if (tableCache && Date.now() - tableCache.timestamp < CACHE_TTL) {
    return tableCache.data;
  }

  const results = await Promise.all(
    REGIONS.map(r => fetchRegion(r).catch(err => {
      console.error(`FB fetch failed for region ${r}:`, err.message);
      return { stations: {}, validity: null };
    }))
  );

  const stations = {};
  let validity = null;
  for (const r of results) {
    Object.assign(stations, r.stations);
    if (!validity && r.validity) validity = r.validity;
  }

  const data = { stations, validity };
  tableCache = { data, timestamp: Date.now() };
  return data;
}

function nearestLevel(altitudeFt) {
  const alt = Number(altitudeFt);
  if (!Number.isFinite(alt) || alt <= 0) return 30000;
  return LEVEL_COLUMNS
    .map(c => c.ft)
    .reduce((best, ft) => Math.abs(ft - alt) < Math.abs(best - alt) ? ft : best);
}

export async function fetchWindsAloft(icao, altitudeFt) {
  try {
    const code = String(icao || '').toUpperCase();
    const fbId = ICAO_TO_FB[code] || (code.length === 4 && code.startsWith('K')
      ? code.slice(1)
      : code);

    const { stations, validity } = await getTable();
    const station = stations[fbId];

    // No FB station for this airport — say so rather than substituting one.
    if (!station) {
      return { airport: code, available: false, reason: 'no FB station for this airport' };
    }

    const level = nearestLevel(altitudeFt);
    const wind = station.levels[level];
    if (!wind) {
      return {
        airport: code,
        station: fbId,
        available: false,
        reason: `no ${level.toLocaleString()} ft forecast for station ${fbId}`
      };
    }

    return {
      airport: code,
      station: fbId,
      substituted: Boolean(ICAO_TO_FB[code]),
      available: true,
      level,
      requestedAltitude: Number(altitudeFt) || null,
      dir: wind.dir,
      speed: wind.speed,
      temp: wind.temp,
      lightVariable: wind.lightVariable,
      raw: wind.raw,
      validity
    };
  } catch (err) {
    console.error(`Winds aloft failed for ${icao}:`, err.message);
    return { airport: String(icao || '').toUpperCase(), available: false, reason: 'lookup failed' };
  }
}
