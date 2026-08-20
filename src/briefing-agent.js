// Briefing agent: AlbertAI-powered synthesis of weather, NOTAMs, SUA data
// Reuses Albert's integration pattern from Magellan

import axios from 'axios';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-opus-5';

export async function generateBriefing({
  departure,
  arrival,
  altitude,
  aircraft,
  latitude,
  longitude,
  weather,
  routeWeather,
  winds,
  hazards,
  tfrs,
  notams,
  sua
}) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not configured; returning structured fallback');
    return fallbackBriefing({ departure, arrival, altitude, aircraft, weather, routeWeather, winds, hazards, tfrs, notams, sua });
  }

  const prompt = `You are a flight briefing specialist. Provide a concise, pilot-friendly preflight briefing for:

Departure: ${departure}
Arrival: ${arrival}
Cruising altitude: ${altitude || 'VFR'}
Aircraft type: ${aircraft || 'not specified'}
Aircraft location: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}

WEATHER (METAR/TAF):
${weather || 'Unable to fetch'}

WINDS AND TEMPERATURES ALOFT (NOAA FB product):
${winds || 'Unavailable'}

ADVERSE CONDITIONS (SIGMETs, G-AIRMETs, CWAs on route):
${hazards || 'Unavailable'}

NOTAMs:
${notams || 'None reported'}

SPECIAL USE AIRSPACE / RESTRICTIONS:
${sua || 'None nearby'}

Format your response as:
1. WEATHER SUMMARY (2-3 sentences max)
2. WINDS ALOFT (relevant to the filed cruising altitude)
3. NOTAMS (bullet list)
4. AIRSPACE ALERTS (bullet list)
5. ADVISORY

Rules you must follow:
- Do NOT issue a go/no-go verdict. State conditions and note that the pilot in
  command owns that decision.
- Any item marked source "placeholder" is scaffolding, NOT live data. Say so
  plainly rather than presenting it as a real notice or a verified all-clear.
- Do not assert anything the supplied data does not support.

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
    return fallbackBriefing({ departure, arrival, altitude, aircraft, weather, routeWeather, winds, hazards, tfrs, notams, sua });
  }
}

const ft = (n) => n == null ? null : `${Number(n).toLocaleString()}ft`;

// Renders the adverse-conditions block. A source that failed to load is called
// out explicitly — "none found" must never stand in for "did not check".
export function describeHazards(h) {
  if (!h || !h.available) {
    return `Adverse conditions not checked (${h?.reason || 'no data'})`;
  }

  const lines = [];

  const band = (lo, hi) => {
    const a = ft(lo), b = ft(hi);
    if (a && b) return ` ${a}–${b}`;
    if (b) return ` up to ${b}`;
    if (a) return ` above ${a}`;
    return '';
  };

  for (const s of h.convectiveSigmets) {
    const first = (s.raw || '').split('\n').find(l => l.includes('CONVECTIVE SIGMET')) || 'Convective SIGMET';
    lines.push(`• CONVECTIVE SIGMET — ${first.trim()}${band(s.altitudeLow, s.altitudeHigh)}`);
  }

  for (const s of h.sigmets) {
    lines.push(`• SIGMET ${s.hazard || ''}`.trimEnd() +
               `${s.severity != null ? ` (severity ${s.severity})` : ''}${band(s.altitudeLow, s.altitudeHigh)}`);
  }

  // Collapse G-AIRMETs: NOAA issues one per forecast hour, so listing each
  // produces a wall of duplicates for what is really one hazard type. Take the
  // widest band across periods so the summary cannot understate the extent.
  const byHazard = new Map();
  for (const g of h.gairmets) {
    const key = g.hazard || 'UNKNOWN';
    if (!byHazard.has(key)) byHazard.set(key, []);
    byHazard.get(key).push(g);
  }

  for (const [hazard, list] of byHazard) {
    // Altitudes are already decoded from hundreds-of-feet by gairmetAltitude().
    const tops = list.map(g => g.top?.ft).filter(v => v != null);
    const levels = list.map(g => g.level?.ft).filter(v => v != null);
    const baseLabels = [...new Set(list.map(g => g.base?.label).filter(Boolean))];

    let extent = '';
    if (tops.length) {
      const base = baseLabels.length === 1 ? baseLabels[0] : null;
      extent = base ? ` ${base} to ${ft(Math.max(...tops))}` : ` to ${ft(Math.max(...tops))}`;
    } else if (levels.length) {
      const lo = Math.min(...levels), hi = Math.max(...levels);
      extent = lo === hi ? ` at ${ft(lo)}` : ` ${ft(lo)}–${ft(hi)}`;
    }

    lines.push(`• G-AIRMET ${hazard}${extent} (${list.length} period${list.length > 1 ? 's' : ''})`);
  }

  for (const c of h.cwas) {
    lines.push(`• Center Weather Advisory — ${c.name || c.cwsu || ''} ${c.hazard || ''}`.trimEnd());
  }

  // Pilot reports last: they are observations, not advisories, but an urgent
  // one (UUA) outranks everything above it.
  const pireps = h.pireps || [];
  for (const p of pireps.slice(0, 6)) {
    const fl = p.flightLevel != null ? ` ${ft(p.flightLevel)}` : '';
    lines.push(`• ${p.urgent ? 'URGENT PIREP' : 'PIREP'}${fl} — ${p.raw || p.acType || ''}`.trimEnd());
  }
  if (pireps.length > 6) {
    const n = pireps.length - 6;
    lines.push(`  …and ${n} more pilot report${n > 1 ? 's' : ''} on route.`);
  }

  if (!lines.length) {
    lines.push(`No SIGMETs, G-AIRMETs or Center Weather Advisories within ${h.corridorNm}nm of the route.`);
  }

  if (h.partial) {
    lines.push(`⚠ ${h.partial.join(' and ')} source unavailable — this list may be incomplete.`);
  }

  return lines.join('\n');
}

export function describeTfrs(t) {
  if (!t || !t.available) {
    return `Temporary flight restrictions not checked (${t?.reason || 'no data'})`;
  }

  const lines = [];
  for (const r of t.tfrs) {
    const band = r.upperFt != null
      ? ` — surface to ${Number(r.upperFt).toLocaleString()}ft`
      : '';
    const near = r.nearestNm != null ? ` · ${r.nearestNm}nm from route` : '';
    const geo = r.geometryUnknown ? ' · extent unknown, shown to be safe' : '';
    lines.push(`• ${r.type || 'TFR'} ${r.id} — ${r.city || r.state || ''}${band}${near}${geo}`);
    if (r.description) lines.push(`    ${r.description}`);
  }

  if (!lines.length) {
    lines.push(`No TFRs within ${t.corridorNm}nm of the route ` +
               `(${t.totalActive} active nationally, ${t.checked} checked in ${t.states.join('/')}).`);
  }
  if (t.truncated) {
    lines.push(`⚠ ${t.truncated} further TFR${t.truncated > 1 ? 's' : ''} in these states were not ` +
               `checked for extent. Confirm against tfr.faa.gov.`);
  }

  return lines.join('\n');
}

export function describeRouteWeather(rw) {
  if (!rw || !rw.available) {
    return `Enroute stations not checked (${rw?.reason || 'no data'})`;
  }
  if (!rw.stations.length) {
    return 'No reporting stations found inside the route corridor.';
  }

  const within = rw.corridorNm ? ` within ${rw.corridorNm}nm of track` : '';
  const head = rw.belowVfr
    ? `${rw.belowVfr} of ${rw.total} stations${within} reporting below VFR:`
    : `All ${rw.total} stations${within} reporting VFR:`;

  const rows = rw.stations.map(s => {
    const bits = [s.fltCat || '—'];
    if (s.visib != null) bits.push(`${s.visib}SM`);
    if (s.wxString) bits.push(s.wxString);
    if (s.offRouteNm != null) bits.push(`${Math.round(s.offRouteNm)}nm off track`);
    return `  ${String(s.icao || '').padEnd(5)} ${bits.join(' · ')}`;
  });

  if (rw.total > rw.stations.length) {
    rows.push(`  …${rw.total - rw.stations.length} further stations in corridor.`);
  }

  return [head, ...rows].join('\n');
}

function describeWinds(label, w) {
  if (!w?.available) {
    return `${label}: winds aloft unavailable (${w?.reason || 'no data'})`;
  }
  const wind = w.lightVariable ? 'light and variable' : `${w.dir}° at ${w.speed}kt`;
  const station = w.substituted ? `${w.station} (nearest FB station)` : w.station;
  const temp = w.temp != null ? `, ${w.temp}°C` : '';
  const level = w.requestedAltitude && w.requestedAltitude !== w.level
    ? `${w.level.toLocaleString()}ft (nearest to filed ${w.requestedAltitude.toLocaleString()}ft)`
    : `${w.level.toLocaleString()}ft`;
  return `${label}: ${level} — ${wind}${temp}` +
         `\n  station ${station}, raw ${w.raw}`;
}

// Math.round(-2.5) is -2 (half toward +Infinity) but PHP round(-2.5) is -3
// (half away from zero). Sub-zero cruise temps rendered differently on the two
// hosts until this was pinned; PHP's convention is the one both now follow.
function roundHalfAwayFromZero(n) {
  return Math.sign(n) * Math.round(Math.abs(n));
}

// Formats only NOAA-decoded fields — no local METAR parsing.
// Exported for the conformance suite: the PHP port must render this identically.
export function describeStation(label, icao, m, taf = null) {
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

  if (m.temp != null) {
    bits.push(`${roundHalfAwayFromZero(m.temp)}°C/${roundHalfAwayFromZero(m.dewp)}°C`);
  }
  if (m.altim != null) bits.push(`Altimeter ${(m.altim / 33.8639).toFixed(2)}inHg`);

  // Mike's first briefing item: temperature + pressure altitude drive aircraft
  // performance. Density altitude is the number that actually matters.
  if (m.densityAltitude != null) {
    bits.push(`Density alt ${m.densityAltitude.toLocaleString()}ft`);
  }

  const lines = [`${label} (${icao}): ${bits.join(' · ')}`, `  ${m.raw}`];
  if (taf?.raw || typeof taf === 'string') lines.push(`  ${taf.raw || taf}`);
  return lines.join('\n');
}

function fallbackBriefing({ departure, arrival, altitude, aircraft, weather, routeWeather, winds, hazards, tfrs, notams, sua }) {
  // Fallback: return structured briefing without AI synthesis
  let weatherSummary = 'Unable to fetch weather data';
  let windSummary = 'Winds aloft unavailable';
  let hazardSummary = 'Adverse conditions not checked';
  let tfrSummary = 'TFRs not checked';

  try {
    const tf = typeof tfrs === 'string' ? JSON.parse(tfrs) : tfrs;
    if (tf) tfrSummary = describeTfrs(tf);
  } catch (e) {
    // Keep default
  }
  let routeSummary = 'Enroute stations not checked';

  try {
    const rw = typeof routeWeather === 'string' ? JSON.parse(routeWeather) : routeWeather;
    if (rw) routeSummary = describeRouteWeather(rw);
  } catch (e) {
    // Keep default
  }

  try {
    const h = typeof hazards === 'string' ? JSON.parse(hazards) : hazards;
    if (h) hazardSummary = describeHazards(h);
  } catch (e) {
    // Keep default
  }
  let notamSummary = 'No NOTAMs reported';
  let suaSummary = 'No special use airspace alerts';
  let cats = [];

  try {
    const wa = typeof winds === 'string' ? JSON.parse(winds) : winds;
    if (wa) {
      windSummary = [
        describeWinds(`Departure (${departure})`, wa.departure),
        describeWinds(`Arrival (${arrival})`, wa.arrival)
      ].join('\n');
    }
  } catch (e) {
    // Keep default
  }

  try {
    const w = typeof weather === 'string' ? JSON.parse(weather) : weather;
    weatherSummary = [
      describeStation('Departure', departure, w.departure?.metar, w.departure?.taf),
      describeStation('Arrival', arrival, w.arrival?.metar, w.arrival?.taf)
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

  const head = `BRIEFING: ${departure} to ${arrival} at ${altitude}` +
               (aircraft ? ` — ${aircraft}` : '');

  return `${head}

ADVERSE CONDITIONS:
${hazardSummary}

WEATHER:
${weatherSummary}

ENROUTE STATIONS:
${routeSummary}

WINDS ALOFT:
${windSummary}

TEMPORARY FLIGHT RESTRICTIONS:
${tfrSummary}

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

