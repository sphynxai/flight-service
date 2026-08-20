import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from 'dotenv';
import { getWeatherBriefing } from './weather-fetcher.js';
import { fetchNOTAMs, fetchSUA } from './notam-fetcher.js';
import { fetchWindsAloft } from './winds-fetcher.js';
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
    const { latitude, longitude, departure, arrival, altitude, aircraft } = req.body;

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

    // Synthesize briefing via AlbertAI
    const briefing = await generateBriefing({
      departure: dep,
      arrival: arr,
      altitude: altitude || 'VFR',
      aircraft: aircraft ? aircraft.toUpperCase() : null,
      latitude,
      longitude,
      weather: JSON.stringify(weather),
      winds: JSON.stringify(winds),
      notams: JSON.stringify(notams),
      sua: JSON.stringify(sua)
    });

    res.json({
      status: 'ok',
      briefing,
      weather,
      winds,
      notams,
      sua,
      aircraft: aircraft ? aircraft.toUpperCase() : null,
      altitude: altitude || null,
      location: { latitude, longitude },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Briefing error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Flight Service running on port ${PORT}`);
});
