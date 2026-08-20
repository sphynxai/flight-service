// Fetch NOTAMs (Notices to Airmen) from FAA
// FAA provides NOTAM Search via web interface; API access may vary

import axios from 'axios';

const CACHE_TTL = 300000; // 5 minutes
const cache = new Map();

// TODO: Determine FAA NOTAM API endpoint
// Current options:
// 1. FAA NOTAM Search (www.notam.faa.gov) — web scraping fallback
// 2. OpenFlight API (if available)
// 3. Aviation Safety API (if available)

export async function fetchNOTAMs(departure, arrival) {
  const cacheKey = `notam_${departure}_${arrival}`;

  if (cache.has(cacheKey)) {
    const { timestamp, data } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) {
      return data;
    }
  }

  try {
    // Placeholder: hardcoded sample NOTAMs for demo
    // In production, wire actual FAA NOTAM API or scraper
    const notams = [
      {
        airport: departure,
        text: `Check departure airport ATIS for active runways`,
        severity: 'info',
        source: 'placeholder'
      },
      {
        airport: arrival,
        text: `Check arrival airport for any temporary closures`,
        severity: 'info',
        source: 'placeholder'
      }
    ];

    cache.set(cacheKey, { data: notams, timestamp: Date.now() });
    return notams;
  } catch (err) {
    console.error('NOTAM fetch failed:', err.message);
    return [];
  }
}

export async function fetchSUA(latitude, longitude, radius = 50) {
  // Special Use Airspace (military, restricted, warning areas)
  // Data from FAA or OpenFlight
  const cacheKey = `sua_${latitude}_${longitude}_${radius}`;

  if (cache.has(cacheKey)) {
    const { timestamp, data } = cache.get(cacheKey);
    if (Date.now() - timestamp < CACHE_TTL) {
      return data;
    }
  }

  try {
    // Placeholder: in production, query SUA database
    // Could integrate OpenFlight API or FAA's airspace layers
    // Must not read as a verified negative — nothing is actually queried yet.
    const sua = {
      nearby: [],
      message: 'Special Use Airspace not checked — no SUA data source connected',
      source: 'placeholder'
    };

    cache.set(cacheKey, { data: sua, timestamp: Date.now() });
    return sua;
  } catch (err) {
    console.error('SUA lookup failed:', err.message);
    return { nearby: [], message: 'SUA lookup unavailable' };
  }
}
