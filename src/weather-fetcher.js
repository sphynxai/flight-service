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

    const raw = response.data?.[0]?.rawTAF;
    if (!raw) return null;

    cache.set(cacheKey, {
      data: raw,
      timestamp: Date.now()
    });

    return raw;
  } catch (err) {
    console.error(`TAF fetch failed for ${airport}:`, err.message);
    return null;
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
