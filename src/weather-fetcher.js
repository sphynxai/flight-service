// Fetch METAR, TAF, winds aloft from NOAA Aviation Weather Center
// No authentication required — free public API

import axios from 'axios';

// The legacy ADDS DataServer (/adds/dataserver_current/httpparam) was retired and
// now 308-redirects without serving data. This is the current NOAA endpoint.
const NOAA_API_BASE = 'https://aviationweather.gov/api/data';
const CACHE_TTL = 600000; // 10 minutes

const cache = new Map();

const M_TO_FT = 3.280839895;
const INHG_TO_HPA = 33.8639;

/**
 * Pressure and density altitude from the fields NOAA already reports.
 *
 * Uses the moist-air (virtual temperature) method rather than the
 * elevation + 120*(OAT-ISA) rule of thumb. The dry approximation ignores
 * humidity and so UNDERSTATES density altitude — by ~260 ft in both Garmin
 * reference cases — and understating it is the dangerous direction, since a
 * pilot then believes they have more takeoff performance than they do.
 * Validated against Garmin Pilot's published figures: KULM 1586 ft and
 * KLUM 1170 ft, matched to within 25 ft. See tests/fixtures/density-altitude.json.
 *
 * Returns nulls rather than a guess when any input is missing.
 */
export function computeAltitudes({ elev, temp, dewp, altim }) {
  if (elev == null || temp == null || altim == null) {
    return { pressureAltitude: null, densityAltitude: null };
  }

  const elevFt = elev * M_TO_FT;

  // NOAA reports altim in hPa already; pressure altitude works in inHg.
  const altimHpa = altim;
  const altimInHg = altim / INHG_TO_HPA;
  const pa = elevFt + (29.92 - altimInHg) * 1000;

  // Without a dewpoint fall back to dry air; still better than nothing, and
  // the result can only be conservative-low rather than invented.
  const td = dewp == null ? temp : dewp;

  // Altimeter setting -> station pressure at field elevation.
  const pSta = altimHpa * Math.pow((288.15 - 0.0065 * elev) / 288.15, 5.2558797);
  // Magnus: vapour pressure equals saturation vapour pressure at the dewpoint.
  const e = 6.112 * Math.exp((17.67 * td) / (td + 243.5));
  const tv = (temp + 273.15) / (1 - 0.378 * e / pSta);
  const rho = (pSta * 100) / (287.05 * tv);
  const da = 145442.16 * (1 - Math.pow(rho / 1.225, 0.234969));

  return {
    pressureAltitude: Math.round(pa),
    densityAltitude: Math.round(da)
  };
}

function getCacheKey(airport) {
  return `metar_${airport.toUpperCase()}`;
}

function isCached(key) {
  if (!cache.has(key)) return false;
  const { timestamp } = cache.get(key);
  return Date.now() - timestamp < CACHE_TTL;
}

/**
 * One retry on transient failure.
 *
 * A briefing now makes ~13 outbound NOAA calls, and a single dropped request
 * renders as "weather unavailable" for that station while the rest of the
 * briefing looks complete — a gap a pilot can easily miss. Observed live on an
 * arrival METAR that succeeded on the three following attempts.
 */
async function getWithRetry(url, timeout = 10000) {
  try {
    return await axios.get(url, { timeout });
  } catch (err) {
    await new Promise(r => setTimeout(r, 400));
    return axios.get(url, { timeout });
  }
}

export async function fetchMETAR(airport) {
  const cacheKey = getCacheKey(airport);

  if (isCached(cacheKey)) {
    return cache.get(cacheKey).data;
  }

  try {
    const params = new URLSearchParams({
      ids: airport.toUpperCase(),
      format: 'json'
    });

    const url = `${NOAA_API_BASE}/metar?${params}`;
    const response = await getWithRetry(url);

    const ob = response.data?.[0];
    if (!ob?.rawOb) return null;

    const alt = computeAltitudes({
      elev: ob.elev, temp: ob.temp, dewp: ob.dewp, altim: ob.altim
    });

    // Only pass through fields NOAA itself decoded. Hand-rolling a METAR parser
    // in a flight tool risks mis-decoding safety-relevant data.
    const data = {
      raw: ob.rawOb,
      station: ob.name || airport.toUpperCase(),
      lat: ob.lat ?? null,
      lon: ob.lon ?? null,
      elev: ob.elev ?? null,
      pressureAltitude: alt.pressureAltitude,
      densityAltitude: alt.densityAltitude,
      fltCat: ob.fltCat || null,
      wdir: ob.wdir,
      wspd: ob.wspd,
      wgst: ob.wgst,
      visib: ob.visib,
      wxString: ob.wxString || null,
      temp: ob.temp,
      dewp: ob.dewp,
      altim: ob.altim,
      clouds: Array.isArray(ob.clouds) ? ob.clouds : []
    };

    cache.set(cacheKey, { data, timestamp: Date.now() });

    return data;
  } catch (err) {
    console.error(`METAR fetch failed for ${airport}:`, err.message);
    return null;
  }
}

export async function fetchTAF(airport) {
  const cacheKey = `taf_${airport.toUpperCase()}`;

  if (isCached(cacheKey)) {
    return cache.get(cacheKey).data;
  }

  try {
    const params = new URLSearchParams({
      ids: airport.toUpperCase(),
      format: 'json'
    });

    const url = `${NOAA_API_BASE}/taf?${params}`;
    const response = await getWithRetry(url);

    const t = response.data?.[0];
    if (!t?.rawTAF) return null;

    // Keep the decoded periods, not just the raw string — they are what lets a
    // briefing report conditions at a planned ETD/ETA rather than only now.
    const data = {
      raw: t.rawTAF,
      validFrom: t.validTimeFrom ?? null,
      validTo: t.validTimeTo ?? null,
      periods: Array.isArray(t.fcsts) ? t.fcsts : []
    };

    cache.set(cacheKey, { data, timestamp: Date.now() });

    return data;
  } catch (err) {
    console.error(`TAF fetch failed for ${airport}:`, err.message);
    return null;
  }
}

const EARTH_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;

/**
 * Perpendicular distance in nm from a point to the great-circle track between
 * two points.
 *
 * A bounding box is not a corridor: the box around KDFW-KMSP spans Texas to
 * Minnesota, so Shreveport and Brownwood fall inside it while being hundreds of
 * miles off the route. The box is the cheap server-side query; this is what
 * makes "enroute" actually mean enroute.
 */
export function crossTrackNm(from, to, point) {
  const vals = [from?.lat, from?.lon, to?.lat, to?.lon, point?.lat, point?.lon];
  if (vals.some(v => v == null || !Number.isFinite(Number(v)))) return null;

  const d13 = angularDistance(from, point);
  const brg13 = bearing(from, point);
  const brg12 = bearing(from, to);

  const xt = Math.asin(Math.sin(d13) * Math.sin(brg13 - brg12)) * EARTH_NM;
  return Math.abs(xt);
}

function angularDistance(a, b) {
  const dLat = rad(Number(b.lat) - Number(a.lat));
  const dLon = rad(Number(b.lon) - Number(a.lon));
  const la1 = rad(Number(a.lat)), la2 = rad(Number(b.lat));
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a, b) {
  const la1 = rad(Number(a.lat)), la2 = rad(Number(b.lat));
  const dLon = rad(Number(b.lon) - Number(a.lon));
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return Math.atan2(y, x);
}

/**
 * Enroute stations inside the route corridor.
 *
 * Mike's checklist calls for weather along the route, not just the endpoints —
 * Garmin pulls ~13 stations on a 50 nm corridor. Ordering puts anything below
 * VFR first, because a single IFR field mid-route matters more than a dozen
 * clear ones, and the list is capped for readability.
 */
export async function fetchRouteMetars(bounds, exclude = [], limit = 12, route = null, corridorNm = 50) {
  if (!bounds) return { available: false, reason: 'no route corridor', stations: [], total: 0 };

  const bbox = [
    bounds.minLat.toFixed(3), bounds.minLon.toFixed(3),
    bounds.maxLat.toFixed(3), bounds.maxLon.toFixed(3)
  ].join(',');

  try {
    const url = `${NOAA_API_BASE}/metar?bbox=${bbox}&format=json`;
    const response = await getWithRetry(url, 12000);
    const rows = Array.isArray(response.data) ? response.data : [];

    const skip = new Set(exclude.map(s => String(s || '').toUpperCase()));
    const rank = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };

    const stations = rows
      .filter(r => r?.rawOb && !skip.has(String(r.icaoId || '').toUpperCase()))
      .map(r => ({
        icao: r.icaoId || null,
        name: r.name || null,
        fltCat: r.fltCat || null,
        visib: r.visib ?? null,
        wxString: r.wxString || null,
        offRouteNm: route
          ? crossTrackNm(route.from, route.to, { lat: r.lat, lon: r.lon })
          : null,
        raw: r.rawOb
      }))
      // Narrow the bbox result to an actual corridor. Stations with unknown
      // geometry are kept rather than silently dropped.
      .filter(s => s.offRouteNm == null || s.offRouteNm <= corridorNm)
      // Below-VFR first — one IFR field mid-route matters more than a dozen
      // clear ones — then by proximity to the track.
      .sort((a, b) => {
        const d = (rank[a.fltCat] ?? 4) - (rank[b.fltCat] ?? 4);
        if (d !== 0) return d;
        return (a.offRouteNm ?? 1e9) - (b.offRouteNm ?? 1e9);
      });

    const belowVfr = stations.filter(s => s.fltCat && s.fltCat !== 'VFR').length;

    return {
      available: true,
      corridorNm,
      total: stations.length,
      belowVfr,
      stations: stations.slice(0, limit)
    };
  } catch (err) {
    console.error('Route METAR fetch failed:', err.message);
    // Must not read as "no stations out there".
    return { available: false, reason: 'route weather lookup failed', stations: [], total: 0 };
  }
}

export async function getWeatherBriefing(departure, arrival) {
  const [depMetar, arrMetar, depTaf, arrTaf] = await Promise.all([
    fetchMETAR(departure),
    fetchMETAR(arrival),
    fetchTAF(departure),
    fetchTAF(arrival)
  ]);

  return {
    departure: { airport: departure, metar: depMetar, taf: depTaf },
    arrival: { airport: arrival, metar: arrMetar, taf: arrTaf }
  };
}
