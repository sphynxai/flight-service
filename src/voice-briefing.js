// Spoken briefing.
//
// A voice briefing is NOT the written one read aloud. "METAR KDFW 201953Z
// 21005KT 10SM FEW070" is unlistenable, and a synthesiser reads "210" as
// "two hundred ten" — wrong for a heading, which ATC and Flight Service speak
// digit by digit. This module renders the same data in aviation phraseology,
// ordered the way a briefer delivers it: hazards first, then the fields, then
// the route.
//
// Target is roughly 150 words / 60-90 seconds, matching the length a briefer
// actually gives on 1-800-WX-BRIEF.

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** 210 -> "two one zero". Headings, runways and flight levels are spoken this way. */
export function spokenDigits(n) {
  if (n == null) return '';
  const s = String(Math.abs(Math.round(Number(n))));
  return s.split('').map(d => DIGITS[Number(d)] ?? d).join(' ');
}

/** Wind direction padded to three digits, as spoken: 90 -> "zero nine zero". */
export function spokenHeading(deg) {
  if (deg == null) return '';
  const s = String(Math.round(Number(deg))).padStart(3, '0');
  return s.split('').map(d => DIGITS[Number(d)] ?? d).join(' ');
}

/**
 * Altitudes: at or above 18,000 ft it is a flight level spoken in digits;
 * below that it is spoken in thousands.
 */
export function spokenAltitude(ft) {
  if (ft == null) return '';
  const n = Math.round(Number(ft));
  if (n >= 18000) return `flight level ${spokenDigits(Math.round(n / 100))}`;
  if (n >= 1000 && n % 1000 === 0) return `${spokenDigits(n / 1000)} thousand feet`;
  return `${n.toLocaleString()} feet`;
}

/** "Dallas-Ft Worth Intl, TX, US" -> "Dallas Fort Worth International". */
export function spokenPlace(name, icao) {
  if (!name) return spokenIcao(icao);
  return name
    .split(',')[0]
    .replace(/\bIntl\b/gi, 'International')
    .replace(/\bRgnl\b/gi, 'Regional')
    .replace(/\bMuni\b/gi, 'Municipal')
    .replace(/\bArpt\b/gi, 'Airport')
    .replace(/\bFt\b/gi, 'Fort')
    .replace(/\bSt\b/gi, 'Saint')
    .replace(/[-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Aviation contractions expanded for speech.
 *
 * A PIREP remark reads "LLWS +10 KT DURD RWY 22" on paper. Spoken verbatim by a
 * synthesiser that is "ell ell double-you ess" — the single most actionable line
 * in the briefing, delivered as noise. Longest keys first so DURD is not
 * partially matched by DUR.
 */
const CONTRACTIONS = [
  [/\bLLWS\b/g, 'low level wind shear'],
  [/\bDURGD\b/g, 'during descent'],
  [/\bDURD\b/g, 'during descent'],
  [/\bDURC\b/g, 'during climb'],
  [/\bINTMT\b/g, 'intermittent'],
  [/\bOCNL\b/g, 'occasional'],
  [/\bCONS\b/g, 'continuous'],
  [/\bMOD\b/g, 'moderate'],
  [/\bSEV\b/g, 'severe'],
  [/\bLGT\b/g, 'light'],
  [/\bNEG\b/g, 'negative'],
  [/\bMX\b/g, 'mixed'],
  [/\bRIME\b/g, 'rime'],
  [/\bCLR\b/g, 'clear'],
  [/\bCHOP\b/g, 'chop'],
  [/\bTURB\b/g, 'turbulence'],
  [/\bSKC\b/g, 'sky clear'],
  [/\bOVC\b/g, 'overcast'],
  [/\bBKN\b/g, 'broken'],
  [/\bSCT\b/g, 'scattered'],
  [/\bFEW\b/g, 'few'],
  [/\bTOPS?\b/g, 'tops'],
  [/\bBLO\b/g, 'below'],
  [/\bABV\b/g, 'above'],
  [/\bRWY\b/g, 'runway'],
  [/\bKTS?\b/g, 'knots'],
  [/\bFL(\d{3})\b/g, (_, n) => `flight level ${spokenDigits(n)}`],
  [/\bVIS\b/g, 'visibility'],
  [/\bWX\b/g, 'weather'],
  [/\bTSTM?S?\b/g, 'thunderstorms'],
  [/\bCB\b/g, 'cumulonimbus']
];

/** Expands aviation shorthand so a synthesiser produces intelligible speech. */
export function expandForSpeech(text) {
  if (!text) return '';
  let s = String(text).toUpperCase();
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  return s
    .replace(/\+\s*(\d+)/g, 'plus $1')
    .replace(/-\s*(\d+)/g, 'minus $1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const NATO = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot',
  G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliet', K: 'Kilo', L: 'Lima',
  M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
  S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey',
  X: 'X-ray', Y: 'Yankee', Z: 'Zulu'
};

/** KDFW -> "Kilo Delta Foxtrot Whiskey" — used when no plain name is known. */
export function spokenIcao(code) {
  return String(code || '').toUpperCase().split('')
    .map(c => NATO[c] || (DIGITS[Number(c)] ?? c))
    .join(' ');
}

// Flight categories must not be read as words — a pilot hears "V F R".
const CATEGORY_SPOKEN = {
  VFR: 'V F R', MVFR: 'marginal V F R', IFR: 'I F R', LIFR: 'low I F R'
};

function speakCategory(cat) {
  return CATEGORY_SPOKEN[cat] || cat || 'category unavailable';
}

function speakWind(m) {
  if (m.wdir === 0 && m.wspd === 0) return 'wind calm';
  if (m.wspd == null) return null;
  const dir = m.wdir === 'VRB' ? 'wind variable' : `wind ${spokenHeading(m.wdir)}`;
  const gust = m.wgst ? ` gusting ${spokenDigits(m.wgst)}` : '';
  return `${dir} at ${spokenDigits(m.wspd)}${gust}`;
}

function speakStation(role, icao, m) {
  if (!m) return `${role}, ${spokenIcao(icao)}, no observation available.`;

  const parts = [`${role}, ${spokenPlace(m.station, icao)}, is ${speakCategory(m.fltCat)}`];

  const wind = speakWind(m);
  if (wind) parts.push(wind);

  if (m.visib != null) {
    const v = String(m.visib).replace('+', ' or more');
    parts.push(`visibility ${v} miles`);
  }

  const ceil = (m.clouds || []).find(c => c.cover === 'BKN' || c.cover === 'OVC');
  if (ceil) parts.push(`ceiling ${ceil.cover === 'OVC' ? 'overcast' : 'broken'} ${spokenAltitude(ceil.base)}`);

  if (m.temp != null) parts.push(`temperature ${Math.round(m.temp)} Celsius`);

  // Density altitude only earns airtime when it is materially above the field —
  // that is when it changes takeoff performance.
  if (m.densityAltitude != null && m.elev != null) {
    const fieldFt = m.elev * 3.280839895;
    const excess = m.densityAltitude - fieldFt;
    if (excess >= 1000) {
      parts.push(`density altitude ${m.densityAltitude.toLocaleString()} feet, ` +
                 `about ${Math.round(excess / 100) * 100} feet above field elevation`);
    }
  }

  return parts.join(', ') + '.';
}

function speakHazards(h) {
  if (!h || !h.available) return ['Adverse conditions were not checked.'];

  const out = [];
  const conv = h.convectiveSigmets || [];
  const sigs = h.sigmets || [];
  const gair = h.gairmets || [];
  const urgent = (h.pireps || []).filter(p => p.urgent);

  if (conv.length) {
    const tops = conv.map(s => s.altitudeHigh).filter(v => v != null);
    const top = tops.length ? `, tops to ${spokenAltitude(Math.max(...tops))}` : '';
    // "SIGMET" is said as a word; the count is an ordinary number.
    out.push(`${conv.length === 1 ? 'One convective SIGMET' : `${conv.length} convective SIGMETs`} on route${top}.`);
  }

  for (const s of sigs.slice(0, 2)) {
    out.push(`SIGMET for ${String(s.hazard || 'hazardous weather').toLowerCase()} on route.`);
  }

  // Icing and turbulence are what a pilot needs from the G-AIRMET set.
  const byHaz = new Map();
  for (const g of gair) byHaz.set(g.hazard, g);
  for (const key of ['ICE', 'TURB-HI', 'TURB-LO']) {
    const g = byHaz.get(key);
    if (!g) continue;
    const label = key === 'ICE' ? 'icing' : 'turbulence';
    const top = g.top?.ft != null ? ` up to ${spokenAltitude(g.top.ft)}` : '';
    out.push(`Airmet for ${label}${top}.`);
  }

  for (const p of urgent.slice(0, 2)) {
    const at = p.flightLevel != null ? ` at ${spokenAltitude(p.flightLevel)}` : '';
    // Read the remark, not the coded report — and expand the contractions.
    const rm = /\/RM\s+(.+?)(?:\/[A-Z]{2}\s|$)/.exec(p.raw || '');
    const what = rm ? expandForSpeech(rm[1]) : 'see the full report';
    out.push(`Urgent pilot report${at}: ${what}.`);
  }

  if (!out.length) out.push('No SIGMETs or airmets on route.');
  return out;
}

export function buildVoiceBriefing(data) {
  const w = data.weather || {};
  const dep = w.departure || {};
  const arr = w.arrival || {};
  const lines = [];

  const from = spokenPlace(dep.metar?.station, dep.airport);
  const to = spokenPlace(arr.metar?.station, arr.airport);
  const lvl = data.altitude ? `, ${spokenAltitude(data.altitude)}` : '';

  lines.push(`Flight Service briefing. ${from} to ${to}${lvl}.`);

  // Hazards lead — this is the part that changes a decision.
  lines.push('Adverse conditions first.');
  lines.push(...speakHazards(data.hazards));

  lines.push(speakStation('Departure', dep.airport, dep.metar));
  lines.push(speakStation('Arrival', arr.airport, arr.metar));

  const dw = data.winds?.departure, aw = data.winds?.arrival;
  const useW = aw?.available ? aw : dw;
  if (useW?.available) {
    const wind = useW.lightVariable
      ? 'light and variable'
      : `${spokenHeading(useW.dir)} at ${spokenDigits(useW.speed)}`;
    // Winds-aloft temps are negative at cruise but POSITIVE at low level in
    // summer — the FB product signs them. Hardcoding "minus" told a GA pilot
    // at 6,000 ft it was minus 26 when the report said plus 26, which inverts
    // an icing assessment.
    const t = useW.temp != null
      ? `, temperature ${useW.temp < 0 ? 'minus' : 'plus'} ${spokenDigits(Math.abs(useW.temp))}`
      : '';
    lines.push(`Winds aloft at ${spokenAltitude(useW.level)}, ${wind}${t}.`);
  }

  // Counts and distances are ordinary numbers, NOT digit strings — a briefer
  // says "thirteen stations within fifty miles", never "one three stations".
  const rw = data.routeWeather;
  if (rw?.available && rw.total) {
    const within = `within ${Math.round(rw.corridorNm)} miles of track`;
    lines.push(rw.belowVfr
      ? `Enroute, ${rw.belowVfr} of ${rw.total} stations ${within} are below V F R.`
      : `Enroute, all ${rw.total} stations ${within} are reporting V F R.`);
  }

  // Scaffolding must be stated aloud too — a listener cannot see a badge.
  const notamsMock = (data.notams || []).some(n => n.source === 'placeholder');
  if (notamsMock || data.sua?.source === 'placeholder') {
    lines.push('NOTAMs and special use airspace are not connected in this demo, and were not checked.');
  }

  lines.push('This is advisory only and is not an official F A A briefing. ' +
             'The pilot in command remains responsible for the go, no go decision.');

  return lines.join(' ');
}
