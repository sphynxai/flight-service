# Flight Service Briefing — AlbertAI-Powered Nationwide Service

Nationwide preflight briefing service using AlbertAI voice, replacing the broken area-code-based routing of the current Flight Service Station network.

## Overview

**Problem:** Flight Service Station routing is based on caller's phone area code, not actual location. Pilots in Alaska get Fort Worth FSS. The service has been outsourced and degraded.

**Solution:** AlbertAI-driven briefing via proper geolocation (GPS, filed route, or manual). Provides:
- Weather (METAR/TAF)
- NOTAMs (Notices to Airmen)
- Special Use Airspace awareness
- Voice interface (natural language, multi-turn conversation)
- Nationwide coverage (no regional boundaries)

## Stack

- **Node.js** (Express + WebSocket for voice)
- **Claude** (briefing synthesis via Anthropic API)
- **NOAA Aviation Weather** (free METAR/TAF)
- **FAA NOTAM Search** (public data)
- **AlbertAI voice** (reused from Magellan; Twilio SIP + DeepL + ElevenLabs)
- **Geolocation** (browser GPS, optional aircraft location lookup)

## Quick Start

```bash
npm install
cp .env.example .env
# Add ANTHROPIC_API_KEY to .env
npm start
```

Visit `http://localhost:3003` to test the briefing interface.

## Architecture

### Web Interface (`web/index.html`)
- Browser geolocation (GPS) or manual coordinate entry
- Departure/arrival ICAO codes
- Optional cruising altitude
- Real-time briefing display + voice output

### API (`src/server.js`)
- `POST /api/briefing` — Accepts geolocation + route, returns structured briefing

### Briefing Agent (`src/briefing-agent.js`)
- Claude-powered synthesis of weather/NOTAMs/SUA data
- Pilot-friendly language (under 2 min of speech)
- Can be streamed to Albert voice server for live TTS

### Data Fetchers
- **`weather-fetcher.js`** — NOAA METAR/TAF (no auth, cached 10min)
- **`notam-fetcher.js`** — FAA NOTAM Search (TODO: wire actual API)

### Voice Integration (Future)
- Wire to Magellan's Albert voice server (`files/server.js`)
- Twilio Media Streams for live conversation
- STT → Claude briefing agent → TTS

## Scope: MVP vs. Future

### MVP (v0.1 — current)
- [x] Geolocation (browser GPS)
- [x] Weather briefing (METAR/TAF fetch)
- [x] NOTAM placeholder
- [x] SUA awareness stub
- [x] Claude briefing synthesis
- [ ] Voice output (browser SpeechSynthesis fallback in place)
- [ ] Flight plan filing (NOT included — liability too high without FAA integration)

### Phase 2
- [ ] Real-time FAA NOTAM API integration
- [ ] SUA database integration (OpenFlight or FAA)
- [ ] Albert voice server integration (live phone briefing)
- [ ] Aircraft tail-number lookup (N-number → location + type)
- [ ] Filed flight plan awareness (pre-filled briefing)

### Phase 3
- [ ] Flight plan filing (VFR/IFR, with FAA integration)
- [ ] Search & Rescue (SAR) activation
- [ ] Dispatch integration (crews get briefing before departure)
- [ ] Mobile-native app

## Operator Liability & Legal

**This is an advisory service, not a substitute for official Flight Service.**

Every briefing must include:
> "This briefing is for reference only and does not replace official FAA Flight Service Station briefings. Pilot in command retains full responsibility for flight safety decisions."

The FAA oversees Flight Service operations. We're building an alternative — check regulatory status before commercial launch.

## Geolocation Strategy

| Source | Use Case | Accuracy |
|--------|----------|----------|
| Browser GPS | Pre-flight on ground | ~50m |
| Aircraft GPS feed | En-route | Variable |
| Tail-number lookup | Pre-flight dispatch | City-level |
| Manual entry | Fallback | Exact |

Start with browser GPS; add tail-number + aircraft-GPS in phase 2.

## Dev Notes

- **Windows path note:** Use PowerShell for npm/node commands. Git Bash works but PATH quirks may require `npm.cmd`.
- **NOAA caching:** Weather is cached 10min; NOTAMs 5min. Can be tuned.
- **Anthropic key:** Must set `ANTHROPIC_API_KEY` in `.env` for briefing synthesis.

## Related Projects

- **Magellan** (1A): EAP portal + Albert voice server (reused)
- **CREW Downtime** (20): Layover concierge; can integrate Flight Service as "next leg briefing"
- **Aerovox** (5): ATIS playback; complementary service

## License

Internal KBM project. See `A:\AFSC Devs Projects\11-Flight-Service\` for governance docs.
