// Briefing agent: Claude-powered synthesis of weather, NOTAMs, SUA data
// Reuses Albert's Claude integration pattern from Magellan

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
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const prompt = `You are a flight briefing specialist. Provide a concise, pilot-friendly preflight briefing for:

Departure: ${departure}
Arrival: ${arrival}
Altitude: ${altitude || 'VFR'}
Aircraft location: ${latitude}, ${longitude}

WEATHER (METAR/TAF):
${weather || 'Unable to fetch'}

NOTAMs:
${notams || 'None reported'}

SPECIAL USE AIRSPACE / RESTRICTIONS:
${sua || 'None nearby'}

Format:
1. Weather summary (2-3 sentences)
2. NOTAMs affecting the route
3. Airspace alerts
4. Go/no-go recommendation (not a directive — pilot decides)

Keep it under 2 minutes of speech time.`;

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
    }
  });

  return response.data.content[0].text;
}

export async function streamBriefing(briefingData) {
  // Stream version for real-time voice synthesis
  // TODO: integrate with Albert voice server for live TTS
  return generateBriefing(briefingData);
}
