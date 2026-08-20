// Fetch METAR, TAF, winds aloft from NOAA Aviation Weather Center
// No authentication required — free public API

import axios from 'axios';

const NOAA_METAR_BASE = 'https://www.aviationweather.gov/adds/dataserver_current/httpparam';
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
      dataSource: 'metars',
      requestType: 'retrieve',
      format: 'csv',
      stationString: airport.toUpperCase(),
      hoursBeforeNow: '1',
      mostRecentForEachStation: 'constraint'
    });

    const url = `${NOAA_METAR_BASE}?${params}`;
    const response = await axios.get(url, { timeout: 5000 });

    if (!response.data || response.data.includes('No results')) {
      return null;
    }

    cache.set(cacheKey, {
      data: response.data,
      timestamp: Date.now()
    });

    return response.data;
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
      dataSource: 'tafs',
      requestType: 'retrieve',
      format: 'csv',
      stationString: airport.toUpperCase(),
      hoursBeforeNow: '0',
      mostRecentForEachStation: 'constraint'
    });

    const url = `${NOAA_METAR_BASE}?${params}`;
    const response = await axios.get(url, { timeout: 5000 });

    if (!response.data || response.data.includes('No results')) {
      return null;
    }

    cache.set(cacheKey, {
      data: response.data,
      timestamp: Date.now()
    });

    return response.data;
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
