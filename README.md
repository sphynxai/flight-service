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

## Quick Start (Local Dev)

```bash
npm install
cp .env.example .env
# Add ANTHROPIC_API_KEY to .env
npm start
```

Visit `http://localhost:3003` to test the briefing interface.

## Status — what is real

| Area | State |
|------|-------|
| Surface weather (METAR/TAF) | **Live** — NOAA `aviationweather.gov/api/data` |
| Winds & temps aloft | **Live** — NOAA FB product, standard levels to FL390 |
| NOTAMs | **Placeholder.** Hardcoded strings, badged in the UI. Not FAA data |
| Special Use Airspace | **Placeholder.** Nothing is queried; the UI says "not checked" |
| Geolocation | **Collected but unused.** No output depends on the reported position |
| Briefing synthesis | Deterministic formatter. Claude is wired but needs `ANTHROPIC_API_KEY` |

The service issues **no go/no-go verdict** and is not an official FAA briefing.

## Tests

```bash
npm test
```

The FB decoder and METAR formatter exist twice — once in `src/*.js`, once in
`deploy/kbmsolvedit/api.php` — and nothing in either language prevents them
drifting. `tests/conformance.mjs` runs shared fixtures through **both** and
fails on any disagreement. Requires `php` on PATH; if it is missing the PHP half
reports SKIPPED and the run exits non-zero rather than passing silently.

## Deployment

**Live demo:** <https://kbmsolvedit.net/demo/flight-service/>

That host is npulse PHP shared hosting with **no Node runtime**, so it runs the
PHP port in `deploy/kbmsolvedit/`, not this Express app. A pure client-side build
is not possible either — `aviationweather.gov` sends no CORS header, so NOAA must
be called server-side.

```bash
npm run build:php   # regenerate deploy/kbmsolvedit/index.php from web/index.html
npm test            # both implementations must agree before uploading
```

Then upload `index.php` and `api.php` to `/demo/flight-service/` over FTP, and
**verify byte sizes on read-back** — that host can truncate an upload and still
return `226`. Never hand-edit `deploy/kbmsolvedit/index.php`; it is generated.

### Other deployment paths (written, never used)

`Dockerfile`, `docker-compose.yml`, `ecosystem.config.js`,
`nginx-flight-service.conf`, `deploy-office-server.sh` and the
`OFFICE-SERVER-*` / `VNC-*` guides target a self-hosted Node deployment on
FreeBSD (77.111.115.58). None of it has been exercised. Treat it as a proposal,
not a runbook.

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
- [x] Weather briefing (METAR/TAF) — live NOAA
- [x] Winds & temps aloft (FB product) — live NOAA
- [x] Aircraft type and filed altitude carried into the briefing
- [~] Geolocation — captured in the browser, but **no output depends on it yet**
- [~] Claude synthesis — implemented, inactive without `ANTHROPIC_API_KEY`
- [~] NOTAMs — placeholder strings only, badged in the UI
- [~] SUA — not queried; reported as "not checked"
- [ ] Voice output (browser SpeechSynthesis fallback in place)
- [ ] Flight plan filing (NOT included — liability too high without FAA integration)

`[~]` means present in the codebase but not yet doing the job its name implies.

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
