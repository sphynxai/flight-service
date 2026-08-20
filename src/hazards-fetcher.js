// Adverse conditions: SIGMETs, Convective SIGMETs, G-AIRMETs and Center Weather
// Advisories, filtered to the route.
//
// This is the section Garmin leads its briefing with and the one most likely to
// change a go/no-go decision. All of it comes from the same unauthenticated NOAA
// API used elsewhere in this project.
//
// Filtering policy: a hazard is INCLUDED when its bounding box overlaps the
// padded route box. That is deliberately permissive — showing a SIGMET that
// turns out to be off-route is a minor annoyance, hiding one that is on-route is
// a safety failure. Never tighten this into a precise polygon test without
// keeping the same bias.

import axios from 'axios';

const NOAA_API = 'https://aviationweather.gov/api/data';
const CACHE_TTL = 300000; // 5 minutes
const DEFAULT_CORRIDOR_NM = 100; // Garmin's winds-aloft corridor is 100 nm

const cache = new Map();

const NM_PER_DEG_LAT = 60;

// gairmet returns coordinates as strings, airsigmet as numbers.
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * G-AIRMET altitudes are encoded in HUNDREDS of feet, and the base may be a
 * keyword rather than a number.
 *
 *   top: 240   -> 24,000 ft   (NOT 240 ft)
 *   base: "SFC" -> surface
 *   base: "FZL" -> the freezing level
 *
 * Reading these as literal feet turns an icing layer reaching 24,000 ft into
 * "240 ft" — a hazard spanning the whole climb rendered as harmless ground
 * clutter. Verified against live G-AIRMETs: TURB-HI 270/400 = FL270-FL400.
 */
export function gairmetAltitude(v) {
  if (v === null || v === undefined || v === '') return null;

  const s = String(v).trim().toUpperCase();
  if (s === 'SFC') return { ft: 0, label: 'surface' };
  if (s === 'FZL') return { ft: null, label: 'freezing level' };

  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;

  const ft = Math.round(n * 100);
  return { ft, label: `${ft.toLocaleString()}ft` };
}

/** Bounding box of a list of {lat, lon}, tolerating string values. */
export function coordsBounds(coords) {
  if (!Array.isArray(coords) || !coords.length) return null;

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let seen = 0;

  for (const c of coords) {
    const lat = num(c?.lat);
    const lon = num(c?.lon);
    if (lat === null || lon === null) continue;
    seen++;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  return seen ? { minLat, maxLat, minLon, maxLon } : null;
}

/**
 * Bounding box covering every supplied point, expanded by padNm.
 * Longitude degrees shrink with latitude, so the east/west pad is scaled by
 * cos(mid-latitude) — without that, a corridor near the poles would be far
 * narrower in nm than intended.
 */
export function routeBounds(points, padNm = DEFAULT_CORRIDOR_NM) {
  const usable = (points || [])
    .map(p => ({ lat: num(p?.lat), lon: num(p?.lon) }))
    .filter(p => p.lat !== null && p.lon !== null);

  if (!usable.length) return null;

  const b = coordsBounds(usable);
  const midLat = (b.minLat + b.maxLat) / 2;
  const padLat = padNm / NM_PER_DEG_LAT;

  // Guard the cosine so a near-polar route cannot divide by ~0.
  const cos = Math.max(Math.cos((midLat * Math.PI) / 180), 0.01);
  const padLon = padNm / (NM_PER_DEG_LAT * cos);

  return {
    minLat: b.minLat - padLat,
    maxLat: b.maxLat + padLat,
    minLon: b.minLon - padLon,
    maxLon: b.maxLon + padLon
  };
}

/** Axis-aligned overlap test. Touching edges count as overlapping. */
export function boundsIntersect(a, b) {
  if (!a || !b) return false;
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat &&
         a.minLon <= b.maxLon && a.maxLon >= b.minLon;
}

/** True when the item has no geometry (kept — cannot prove it is off-route). */
export function onRoute(coords, bounds) {
  const hb = coordsBounds(coords);
  if (!hb) return true;
  return boundsIntersect(hb, bounds);
}

async function getJson(path) {
  if (cache.has(path)) {
    const { timestamp, data } = cache.get(path);
    if (Date.now() - timestamp < CACHE_TTL) return data;
  }
  const { data } = await axios.get(`${NOAA_API}${path}`, { timeout: 12000 });
  const arr = Array.isArray(data) ? data : [];
  cache.set(path, { data: arr, timestamp: Date.now() });
  return arr;
}

const stillValid = (to) => {
  const t = num(to);
  // Missing validity is kept rather than dropped.
  return t === null ? true : t * 1000 >= Date.now() - 60000;
};

export async function fetchHazards(points, corridorNm = DEFAULT_CORRIDOR_NM) {
  const bounds = routeBounds(points, corridorNm);

  // Without any usable position there is no route to filter against. Report
  // that rather than silently returning "none found".
  if (!bounds) {
    return {
      available: false,
      reason: 'no usable coordinates for the route',
      corridorNm,
      convectiveSigmets: [], sigmets: [], gairmets: [], cwas: []
    };
  }

  // PIREPs are queried by bounding box rather than filtered client-side.
  const bboxParam = [
    bounds.minLat.toFixed(3), bounds.minLon.toFixed(3),
    bounds.maxLat.toFixed(3), bounds.maxLon.toFixed(3)
  ].join(',');

  const [airsig, gair, cwa, pireps] = await Promise.all([
    getJson('/airsigmet?format=json').catch(e => {
      console.error('airsigmet fetch failed:', e.message); return null;
    }),
    getJson('/gairmet?format=json').catch(e => {
      console.error('gairmet fetch failed:', e.message); return null;
    }),
    getJson('/cwa?format=json').catch(e => {
      console.error('cwa fetch failed:', e.message); return null;
    }),
    getJson(`/pirep?bbox=${bboxParam}&format=json`).catch(e => {
      console.error('pirep fetch failed:', e.message); return null;
    })
  ]);

  // A failed source must not read as "nothing out there".
  const failed = [];
  if (airsig === null) failed.push('SIGMET');
  if (gair === null) failed.push('G-AIRMET');
  if (cwa === null) failed.push('CWA');
  if (pireps === null) failed.push('PIREP');

  const near = (arr) => (arr || [])
    .filter(x => stillValid(x.validTimeTo ?? x.expireTime))
    .filter(x => onRoute(x.coords, bounds));

  const airsigNear = near(airsig);

  return {
    available: true,
    corridorNm,
    bounds,
    partial: failed.length ? failed : null,
    convectiveSigmets: airsigNear
      .filter(x => (x.hazard || '').toUpperCase() === 'CONVECTIVE')
      .map(mapAirSigmet),
    sigmets: airsigNear
      .filter(x => (x.hazard || '').toUpperCase() !== 'CONVECTIVE')
      .map(mapAirSigmet),
    gairmets: near(gair).map(g => ({
      hazard: g.hazard || null,
      severity: g.severity || null,
      // Hundreds of feet, with SFC/FZL keywords — see gairmetAltitude().
      base: gairmetAltitude(g.base),
      top: gairmetAltitude(g.top),
      level: gairmetAltitude(g.level),
      freezingBase: gairmetAltitude(g.fzlbase),
      freezingTop: gairmetAltitude(g.fzltop),
      validTime: g.validTime || null,
      forecastHour: g.forecastHour ?? null
    })),
    // Already bbox-scoped by the API. fltLvl is in hundreds of feet — verified
    // against the raw reports (fltLvl 350 carries "/FL350/"). airepType comes
    // back null in practice, so urgency is read from the raw UUA token instead.
    pireps: (pireps || [])
      .map(p => {
        const raw = (p.rawOb || '').trim();
        return {
          urgent: /\bUUA\b/.test(raw),
          acType: p.acType || null,
          flightLevel: p.fltLvl == null ? null : Number(p.fltLvl) * 100,
          raw: raw || null
        };
      })
      .sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0)),
    cwas: near(cwa).map(c => ({
      cwsu: c.cwsu || null,
      name: c.name || null,
      hazard: c.hazard || null,
      raw: c.cwaText || c.raw || null,
      validTimeTo: c.validTimeTo ?? null
    }))
  };
}

function mapAirSigmet(x) {
  return {
    type: x.airSigmetType || null,
    hazard: x.hazard || null,
    severity: x.severity ?? null,
    altitudeLow: num(x.altitudeLow1),
    altitudeHigh: num(x.altitudeHi1),
    validTimeFrom: x.validTimeFrom ?? null,
    validTimeTo: x.validTimeTo ?? null,
    // Raw bulletin retained so a pilot can read the authoritative text.
    raw: (x.rawAirSigmet || '').trim() || null
  };
}
