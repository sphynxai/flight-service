import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from 'dotenv';
import { getWeatherBriefing, fetchRouteMetars } from './weather-fetcher.js';
import { fetchNOTAMs, fetchSUA } from './notam-fetcher.js';
import { fetchWindsAloft } from './winds-fetcher.js';
import { fetchHazards, positionIsOnRoute, distanceNm } from './hazards-fetcher.js';
import { buildVoiceBriefing } from './voice-briefing.js';
import { buildFlightPlan, prefillFromBriefing } from './flight-plan.js';
import { resolveFlightTimes, forecastAt, summarisePeriod, scanWindow } from './flight-time.js';
import { fetchTfrs, stateFromStationName } from './tfr-fetcher.js';
import { generateBriefing } from './briefing-agent.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());
app.use(express.static(dirname(__dirname) + '/web'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'flight-service' });
});

// Briefing endpoint: accepts geolocation + route, returns weather/NOTAMs/SUA
app.post('/api/briefing', async (req, res) => {
  try {
    const {
      latitude, longitude, departure, arrival, altitude, aircraft,
      departureTime, eet
    } = req.body;

    if (!departure || !arrival) {
      return res.status(400).json({ error: 'departure and arrival ICAO required' });
    }

    const dep = departure.toUpperCase();
    const arr = arrival.toUpperCase();

    // Fetch weather, NOTAMs, SUA, winds aloft in parallel
    const [weather, notams, sua, depWinds, arrWinds] = await Promise.all([
      getWeatherBriefing(dep, arr),
      fetchNOTAMs(dep, arr),
      fetchSUA(latitude, longitude),
      fetchWindsAloft(dep, altitude),
      fetchWindsAloft(arr, altitude)
    ]);

    const winds = { departure: depWinds, arrival: arrWinds };

    // Route geometry. The reported position widens the box ONLY when the pilot
    // is actually near the flight — briefing a Texas route from a desk in Los
    // Angeles would otherwise stretch the box across the continent and fill the
    // briefing with West Coast hazards that have nothing to do with the route.
    const endpoints = [
      { lat: weather.departure?.metar?.lat, lon: weather.departure?.metar?.lon },
      { lat: weather.arrival?.metar?.lat, lon: weather.arrival?.metar?.lon }
    ];
    const position = (latitude != null && longitude != null)
      ? { lat: latitude, lon: longitude }
      : null;

    const positionUsed = position ? positionIsOnRoute(position, endpoints) : false;
    const dists = position
      ? endpoints.map(e => distanceNm(position, e)).filter(v => v !== null)
      : [];
    const positionDistanceNm = dists.length ? Math.round(Math.min(...dists)) : null;

    const hazards = await fetchHazards(
      positionUsed ? [...endpoints, position] : endpoints
    );

    // Reuse the hazard corridor so enroute weather and hazards describe the
    // same piece of sky.
    const routeWeather = await fetchRouteMetars(
      hazards.bounds,
      [dep, arr],
      12,
      {
        from: { lat: weather.departure?.metar?.lat, lon: weather.departure?.metar?.lon },
        to: { lat: weather.arrival?.metar?.lat, lon: weather.arrival?.metar?.lon }
      }
    );

    // TFRs. States come from both endpoints and every corridor station, so the
    // pre-filter covers the states the route actually crosses. Must resolve
    // before the briefing is synthesised, which consumes it.
    const routeStates = [
      stateFromStationName(weather.departure?.metar?.station),
      stateFromStationName(weather.arrival?.metar?.station),
      ...(routeWeather.stations || []).map(s => stateFromStationName(s.name))
    ].filter(Boolean);

    const tfrs = await fetchTfrs(endpoints, [...new Set(routeStates)]);

    // Synthesize briefing via AlbertAI
    const briefing = await generateBriefing({
      departure: dep,
      arrival: arr,
      altitude: altitude || 'VFR',
      aircraft: aircraft ? aircraft.toUpperCase() : null,
      latitude,
      longitude,
      weather: JSON.stringify(weather),
      routeWeather: JSON.stringify(routeWeather),
      winds: JSON.stringify(winds),
      hazards: JSON.stringify(hazards),
      tfrs: JSON.stringify(tfrs),
      notams: JSON.stringify(notams),
      sua: JSON.stringify(sua)
    });

    // Spoken rendering is built from the same data, not from the text briefing.
    const voice = buildVoiceBriefing({
      weather, routeWeather, winds, hazards, notams, sua,
      altitude: altitude || null
    });

    // Apply the flight plan's times to the briefing. Without a proposed
    // departure time this is a report of current conditions; with one, the TAF
    // period governing ETD and ETA is what actually matters, and Mike's
    // "+/- 1 hour" window is what drives the alternate decision.
    const times = resolveFlightTimes(departureTime, eet);
    let planned = null;

    if (times) {
      const at = (taf, epoch) => {
        const f = forecastAt(taf?.periods, epoch);
        if (!f) return null;
        return {
          base: summarisePeriod(f.base),
          overlays: f.overlays.map(summarisePeriod).filter(Boolean)
        };
      };

      planned = {
        etd: times.etd,
        eta: times.eta,
        hoursToDeparture: times.hoursToDeparture,
        // Current observations stop being representative for a flight well in
        // the future; say so rather than letting a stale METAR read as current.
        observationsRepresentative: times.hoursToDeparture <= 2,
        departure: {
          forecast: at(weather.departure?.taf, times.etd),
          window: scanWindow(weather.departure?.taf?.periods, times.etd)
        },
        arrival: {
          forecast: at(weather.arrival?.taf, times.eta),
          window: scanWindow(weather.arrival?.taf?.periods, times.eta)
        }
      };
    }

    // Everything the briefing already knows, so the pilot types as little as
    // possible on the flight plan. Preparation only — nothing is filed.
    const flightPlanPrefill = prefillFromBriefing({
      weather, winds, aircraft: aircraft || null, altitude: altitude || null
    });

    res.json({
      status: 'ok',
      briefing,
      voice,
      planned,
      flightPlanPrefill,
      weather,
      routeWeather,
      winds,
      hazards,
      tfrs,
      notams,
      sua,
      aircraft: aircraft ? aircraft.toUpperCase() : null,
      altitude: altitude || null,
      location: {
        latitude, longitude,
        // Whether the reported position influenced the briefing, and why not.
        used: positionUsed,
        distanceNm: positionDistanceNm,
        note: position
          ? (positionUsed
              ? `Position is ${positionDistanceNm} nm from the route and was included.`
              : `Position is ${positionDistanceNm} nm from the route — too far to be relevant, so it was not used. The briefing covers the filed route only.`)
          : 'No position reported; the briefing covers the filed route only.'
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Briefing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Validates and assembles an FAA Form 7233-4. This endpoint does NOT file:
// filing requires Leidos Flight Service vendor authorization we do not hold.
app.post('/api/flight-plan', (req, res) => {
  try {
    res.json({ status: 'ok', filed: false, ...buildFlightPlan(req.body || {}) });
  } catch (err) {
    console.error('Flight plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Flight Service running on port ${PORT}`);
});
