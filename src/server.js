import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from 'dotenv';

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
    const { latitude, longitude, departure, arrival, altitude } = req.body;

    if (!departure || !arrival) {
      return res.status(400).json({ error: 'departure and arrival ICAO required' });
    }

    // Placeholder: will wire briefing agent next
    res.json({
      status: 'ok',
      briefing: 'Flight briefing coming soon',
      departure, arrival, altitude,
      location: { latitude, longitude }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Flight Service running on port ${PORT}`);
});
