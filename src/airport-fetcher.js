// Airport facility data: frequencies and runways.
//
// Garmin's briefing opens with the departure and destination weather-station
// frequencies. A pilot needs the ATIS/AWOS frequency to get the current
// automated broadcast, and the runway list to reconcile the wind with what they
// will actually be using.
//
// Same unauthenticated NOAA API as everything else.

import axios from 'axios';

const NOAA_API_BASE = 'https://aviationweather.gov/api/data';
const CACHE_TTL = 86400000; // facility data barely changes
const cache = new Map();

/**
 * "LCL/P,120.825;ATIS,126.925;LCL/P,135.15" -> grouped by type.
 *
 * Types seen live: ATIS, D-ATIS, LCL/P (tower/CTAF), plus AWOS/ASOS at
 * uncontrolled fields. The broadcast frequency is the one a pilot dials first,
 * so it is pulled out separately rather than buried in a list.
 */
export function parseFreqs(text) {
  const out = [];
  for (const entry of String(text || '').split(';')) {
    const [type, mhz] = entry.split(',').map(s => (s || '').trim());
    if (!type || !mhz) continue;
    out.push({ type: type.toUpperCase(), mhz });
  }

  const broadcast = out.find(f => /^D?-?ATIS$/.test(f.type)) ||
                    out.find(f => /AWOS|ASOS|AWSS/.test(f.type)) || null;
  const tower = out.find(f => /^LCL/.test(f.type)) || null;

  return { all: out, broadcast, tower };
}

/** "11000x150" -> { lengthFt, widthFt } */
function parseDimension(d) {
  const m = /^(\d+)x(\d+)$/.exec(String(d || '').trim());
  if (!m) return { lengthFt: null, widthFt: null };
  return { lengthFt: Number(m[1]), widthFt: Number(m[2]) };
}

const SURFACE = { A: 'asphalt', C: 'concrete', G: 'grass', D: 'dirt', T: 'turf', W: 'water' };

export async function fetchAirports(icaos = []) {
  const ids = [...new Set(icaos.filter(Boolean).map(s => String(s).toUpperCase()))];
  if (!ids.length) return {};

  const key = ids.join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL) return hit.data;

  try {
    const url = `${NOAA_API_BASE}/airport?ids=${encodeURIComponent(key)}&format=json`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const rows = Array.isArray(data) ? data : [];

    const out = {};
    for (const a of rows) {
      const id = String(a.icaoId || '').toUpperCase();
      if (!id) continue;

      const runways = (Array.isArray(a.runways) ? a.runways : []).map(r => {
        const dim = parseDimension(r.dimension);
        return {
          id: r.id || null,
          ...dim,
          surface: SURFACE[String(r.surface || '').toUpperCase()] || r.surface || null,
          alignment: r.alignment ?? null
        };
      });

      // Longest runway is what a pilot checks against required field length.
      const longest = runways.reduce(
        (best, r) => (r.lengthFt || 0) > (best?.lengthFt || 0) ? r : best, null);

      out[id] = {
        icao: id,
        name: a.name ? String(a.name).trim() : null,
        elevM: a.elev ?? null,
        magdec: a.magdec || null,
        towered: String(a.tower || '').toUpperCase() === 'T',
        freqs: parseFreqs(a.freqs),
        runways,
        longestRunway: longest
      };
    }

    cache.set(key, { data: out, timestamp: Date.now() });
    return out;
  } catch (err) {
    console.error('Airport fetch failed:', err.message);
    // Empty means "not retrieved", and callers report it that way.
    return {};
  }
}
