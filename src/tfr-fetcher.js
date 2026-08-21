// Temporary Flight Restrictions.
//
// Mike names the separate FAA TFR website as one of his three complaints. This
// folds TFRs into the briefing. The list endpoint needs no authentication —
// unlike the FAA NOTAM API, which is regulation-gated and returns 401.
//
// Two-stage fetch, because the list carries no geometry:
//   1. /tfrapi/exportTfrList  — all active TFRs, with state and type.
//   2. /download/detail_{id}.xml — vertices, altitude band, effective times,
//      fetched ONLY for the handful that survive the state pre-filter.
//
// ‼️ Known limitation, surfaced to the reader rather than hidden: the pre-filter
// is by US state, so a TFR sitting just across a state line from the route can
// be missed. States are collected from BOTH endpoints and every corridor station,
// which covers the realistic cases, but this is not a substitute for the official
// TFR source and the UI says so.

import axios from 'axios';

const LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';
const DETAIL_URL = (id) => `https://tfr.faa.gov/download/detail_${id.replace('/', '_')}.xml`;
const CACHE_TTL = 900000; // 15 minutes
const MAX_DETAIL_FETCHES = 12;

const UA = 'flight-service/0.1 (+kbmsolvedit.net)';
const cache = new Map();

/** "46.9N" -> 46.9 ; "115.20833333W" -> -115.208... */
export function parseCoord(text) {
  const s = String(text || '').trim().toUpperCase();
  const m = /^([\d.]+)([NSEW])$/.exec(s);
  if (!m) return null;

  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;

  const sign = (m[2] === 'S' || m[2] === 'W') ? -1 : 1;
  // Guard against a DMS-encoded value being read as decimal degrees.
  if (n > 180) return null;
  return sign * n;
}

/** "Dallas-Ft Worth Intl, TX, US" -> "TX" */
export function stateFromStationName(name) {
  const parts = String(name || '').split(',').map(s => s.trim());
  const st = parts.length >= 2 ? parts[parts.length - 2] : null;
  return /^[A-Z]{2}$/.test(st || '') ? st : null;
}

async function getList() {
  const hit = cache.get('list');
  if (hit && Date.now() - hit.timestamp < CACHE_TTL) return hit.data;

  const { data } = await axios.get(LIST_URL, {
    timeout: 12000, headers: { 'User-Agent': UA }
  });
  const arr = Array.isArray(data) ? data : [];
  cache.set('list', { data: arr, timestamp: Date.now() });
  return arr;
}

async function getDetail(notamId) {
  const key = `d:${notamId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL) return hit.data;

  const { data } = await axios.get(DETAIL_URL(notamId), {
    timeout: 12000, headers: { 'User-Agent': UA }, responseType: 'text'
  });
  const parsed = parseDetail(String(data || ''));
  cache.set(key, { data: parsed, timestamp: Date.now() });
  return parsed;
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

export function parseDetail(xml) {
  const points = [];
  const re = /<Avx>([\s\S]*?)<\/Avx>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const lat = parseCoord(tag(m[1], 'geoLat'));
    const lon = parseCoord(tag(m[1], 'geoLong'));
    if (lat !== null && lon !== null) points.push({ lat, lon });
  }

  const upper = tag(xml, 'valDistVerUpper');
  const lower = tag(xml, 'valDistVerLower');

  return {
    points,
    city: tag(xml, 'txtNameCity'),
    effective: tag(xml, 'dateEffective'),
    expires: tag(xml, 'dateExpire'),
    lowerFt: lower === null ? null : Number(lower),
    upperFt: upper === null ? null : Number(upper),
    upperUnit: tag(xml, 'uomDistVerUpper')
  };
}

const EARTH_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;

function distNm(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * EARTH_NM;
}

/**
 * Nearest approach from any TFR vertex to any route point.
 *
 * Vertex-to-point is a deliberate simplification: it under-measures a large
 * polygon the route passes through the middle of. It is therefore paired with a
 * generous threshold, so the bias is toward showing a TFR rather than hiding
 * one — the same policy used for hazards.
 */
export function nearestApproachNm(points, routePoints) {
  let best = null;
  for (const p of points) {
    for (const r of routePoints) {
      if (r?.lat == null || r?.lon == null) continue;
      const d = distNm(p, { lat: Number(r.lat), lon: Number(r.lon) });
      if (best === null || d < best) best = d;
    }
  }
  return best;
}

/**
 * Endpoint-only geometry cannot establish that a route avoids a TFR polygon.
 * A route clearance requires actual enroute fixes/corridor coverage; this
 * integration currently receives departure and arrival points only.
 */
export function hasTfrRouteCoverage(routePoints) {
  return (routePoints || []).filter(p => p?.lat != null && p?.lon != null).length >= 3;
}

export async function fetchTfrs(routePoints, states = [], corridorNm = 100) {
  const usable = (routePoints || []).filter(p => p?.lat != null && p?.lon != null);

  if (!usable.length) {
    return { available: false, reason: 'no route geometry', tfrs: [], checked: 0 };
  }

  if (!hasTfrRouteCoverage(usable)) {
    return {
      available: false,
      reason: 'route geometry is endpoint-only; official TFR confirmation required',
      tfrs: [],
      checked: 0
    };
  }

  let list;
  try {
    list = await getList();
  } catch (err) {
    console.error('TFR list fetch failed:', err.message);
    // Must not read as "no TFRs out there".
    return { available: false, reason: 'TFR source unavailable', tfrs: [], checked: 0 };
  }

  const wanted = new Set(states.filter(Boolean).map(s => String(s).toUpperCase()));
  const candidates = list.filter(t => wanted.has(String(t.state || '').toUpperCase()));

  const truncated = candidates.length > MAX_DETAIL_FETCHES;
  const toFetch = candidates.slice(0, MAX_DETAIL_FETCHES);

  const detailed = await Promise.all(toFetch.map(async (t) => {
    try {
      const d = await getDetail(t.notam_id);
      const nearest = d.points.length ? nearestApproachNm(d.points, usable) : null;
      return { ...t, ...d, nearestNm: nearest };
    } catch (err) {
      console.error(`TFR detail failed for ${t.notam_id}:`, err.message);
      // Geometry unknown — keep it rather than drop it silently.
      return { ...t, points: [], nearestNm: null, detailFailed: true };
    }
  }));

  const onRoute = detailed
    .filter(t => t.nearestNm === null || t.nearestNm <= corridorNm)
    .sort((a, b) => (a.nearestNm ?? 1e9) - (b.nearestNm ?? 1e9))
    .map(t => ({
      id: t.notam_id,
      type: t.type || null,
      facility: t.facility || null,
      state: t.state || null,
      city: t.city || null,
      description: t.description || null,
      lowerFt: t.lowerFt ?? null,
      upperFt: t.upperFt ?? null,
      effective: t.effective || null,
      expires: t.expires || null,
      nearestNm: t.nearestNm === null ? null : Math.round(t.nearestNm),
      geometryUnknown: Boolean(t.detailFailed) || !t.points?.length
    }));

  return {
    available: true,
    corridorNm,
    states: [...wanted],
    totalActive: list.length,
    checked: toFetch.length,
    truncated: truncated ? candidates.length - MAX_DETAIL_FETCHES : 0,
    tfrs: onRoute
  };
}
