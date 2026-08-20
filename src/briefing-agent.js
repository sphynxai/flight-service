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

// Formats only NOAA-decoded fields — no local METAR parsing.
function describeStation(label, icao, m) {
  if (!m) return `${label} (${icao}): weather unavailable`;

  const bits = [];
  if (m.fltCat) bits.push(m.fltCat);

  if (m.wdir === 0 && m.wspd === 0) {
    bits.push('Wind calm');
  } else if (m.wspd != null) {
    const dir = m.wdir === 'VRB' ? 'variable' : `${m.wdir}°`;
    bits.push(`Wind ${dir} at ${m.wspd}kt${m.wgst ? ` gusting ${m.wgst}kt` : ''}`);
  }

  if (m.visib != null) bits.push(`Vis ${m.visib}SM`);
  if (m.wxString) bits.push(`Wx ${m.wxString}`);

  const ceiling = m.clouds.find(c => c.cover === 'BKN' || c.cover === 'OVC');
  bits.push(ceiling
    ? `Ceiling ${ceiling.cover} ${ceiling.base.toLocaleString()}ft`
    : 'No ceiling reported');

  if (m.temp != null) bits.push(`${Math.round(m.temp)}°C/${Math.round(m.dewp)}°C`);
  if (m.altim != null) bits.push(`Altimeter ${(m.altim / 33.8639).toFixed(2)}inHg`);

  return `${label} (${icao}): ${bits.join(' · ')}\n  ${m.raw}`;
}

function fallbackBriefing({ departure, arrival, altitude, weather, notams, sua }) {
  // Fallback: return structured briefing without AI synthesis
  let weatherSummary = 'Unable to fetch weather data';
  let notamSummary = 'No NOTAMs reported';
  let suaSummary = 'No special use airspace alerts';
  let cats = [];

  try {
    const w = typeof weather === 'string' ? JSON.parse(weather) : weather;
    weatherSummary = [
      describeStation('Departure', departure, w.departure?.metar),
      describeStation('Arrival', arrival, w.arrival?.metar)
    ].join('\n\n');
    cats = [w.departure?.metar?.fltCat, w.arrival?.metar?.fltCat].filter(Boolean);
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

  // No go/no-go verdict: this service has no basis to issue one. State the
  // observed flight category and leave the decision with the PIC.
  const catLine = cats.length
    ? `Reported flight category: ${cats.join(' / ')}.`
    : 'Flight category unavailable.';

  return `BRIEFING: ${departure} to ${arrival} at ${altitude}

WEATHER:
${weatherSummary}

NOTAMS:
${notamSummary}

AIRSPACE:
${suaSummary}

ADVISORY:
${catLine}
This is not an official FAA weather briefing and does not substitute for one.
The pilot in command is responsible for the go/no-go decision.`;
}

export async function streamBriefing(briefingData) {
  // Stream version for real-time voice synthesis
  // TODO: integrate with Albert voice server for live TTS
  return generateBriefing(briefingData);
}
