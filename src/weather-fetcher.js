// Fetch METAR, TAF, winds aloft from NOAA Aviation Weather Center
// No authentication required — free public API

import axios from 'axios';

// The legacy ADDS DataServer (/adds/dataserver_current/httpparam) was retired and
// now 308-redirects without serving data. This is the current NOAA endpoint.
const NOAA_API_BASE = 'https://aviationweather.gov/api/data';
const CACHE_TTL = 600000; // 10 minutes

const cache = new Map();

function getCacheKey(airport) {
  return `metar_${airport.toUpperCase()}`;
}

function isCached(key) {
  if (!cache.has(key)) return false;
  const { timestamp } = cache.get(key);
  return Date.now() - timestamp < CACHE_TTL;
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
    const response = await axios.get(url, { timeout: 10000 });

    const raw = response.data?.[0]?.rawOb;
    if (!raw) return null;

    cache.set(cacheKey, {
      data: raw,
      timestamp: Date.now()
    });

    return raw;
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
    const response = await axios.get(url, { timeout: 10000 });

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

export async function fetchWindsAloft(airport) {
  // Winds aloft typically available via NWS forecast API
  // TODO: wire NWS GridPoint API for detailed winds
  return null;
}

export async function getWeatherBriefing(departure, arrival) {
  const [depMetar, arrMetar, depTaf, arrTaf] = await Promise.all([
    fetchMETAR(departure),
    fetchMETAR(arrival),
    fetchTAF(departure),
    fetchTAF(arrival)
  ]);

  const briefing = {
    departure: {
      airport: departure,
      metar: depMetar || 'Unable to fetch METAR',
      taf: depTaf || 'Unable to fetch TAF'
    },
    arrival: {
      airport: arrival,
      metar: arrMetar || 'Unable to fetch METAR',
      taf: arrTaf || 'Unable to fetch TAF'
    }
  };

  return briefing;
}
