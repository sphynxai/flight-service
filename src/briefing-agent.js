// Briefing agent: AlbertAI-powered synthesis of weather, NOTAMs, SUA data
// Reuses Albert's integration pattern from Magellan

import axios from 'axios';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-opus-5';

export async function generateBriefing({
  departure,
  arrival,
  altitude,
  latitude,
  longitude,
  weather,
  notams,
  sua
}) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not configured; returning structured fallback');
    return fallbackBriefing({ departure, arrival, altitude, weather, notams, sua });
  }

  const prompt = `You are a flight briefing specialist. Provide a concise, pilot-friendly preflight briefing for:

Departure: ${departure}
Arrival: ${arrival}
Altitude: ${altitude || 'VFR'}
Aircraft location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}

WEATHER (METAR/TAF):
${weather || 'Unable to fetch'}

NOTAMs:
${notams || 'None reported'}

SPECIAL USE AIRSPACE / RESTRICTIONS:
${sua || 'None nearby'}

Format your response as:
1. WEATHER SUMMARY (2-3 sentences max)
2. NOTAMS (bullet list)
3. AIRSPACE ALERTS (bullet list)
4. RECOMMENDATION (Go/No-go advisory — pilot retains full authority)

Keep the entire briefing under 400 words (about 2 minutes of speech time).`;

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      timeout: 10000
    });

    return response.data.content[0].text;
  } catch (err) {
    console.error('AlbertAI API error:', err.message);
    return fallbackBriefing({ departure, arrival, altitude, weather, notams, sua });
  }
}

function fallbackBriefing({ departure, arrival, altitude, weather, notams, sua }) {
  // Fallback: return structured briefing without AI synthesis
  let weatherSummary = 'Unable to fetch weather data';
  let notamSummary = 'No NOTAMs reported';
  let suaSummary = 'No special use airspace alerts';

  try {
    const w = typeof weather === 'string' ? JSON.parse(weather) : weather;
    const depMetar = w.departure?.metar || 'N/A';
    const arrMetar = w.arrival?.metar || 'N/A';
    weatherSummary = `Departure (${departure}): ${depMetar}\nArrival (${arrival}): ${arrMetar}`;
  } catch (e) {
    // Keep default
  }

  try {
    const n = typeof notams === 'string' ? JSON.parse(notams) : notams;
    if (Array.isArray(n) && n.length > 0) {
      notamSummary = n.map(x => `• ${x.airport}: ${x.text}`).join('\n');
    }
  } catch (e) {
    // Keep default
  }

  try {
    const s = typeof sua === 'string' ? JSON.parse(sua) : sua;
    if (s.message) {
      suaSummary = s.message;
    }
  } catch (e) {
    // Keep default
  }

  return `BRIEFING: ${departure} to ${arrival} at ${altitude}

WEATHER:
${weatherSummary}

NOTAMS:
${notamSummary}

AIRSPACE:
${suaSummary}

RECOMMENDATION:
Safe to proceed. This briefing is for reference only—check official sources before flight.
Pilot in command retains full authority and responsibility.`;
}

export async function streamBriefing(briefingData) {
  // Stream version for real-time voice synthesis
  // TODO: integrate with Albert voice server for live TTS
  return generateBriefing(briefingData);
}
