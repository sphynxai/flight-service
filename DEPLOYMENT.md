# Flight Service — Deployment Guide

**Status:** MVP ready for cloud deployment  
**Architecture:** Node.js + Express (standalone or containerized)  
**Data:** Public (NOAA, FAA); No user data storage

---

## Quick Start (Local)

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-v7-...
npm start
# Visit http://localhost:3003
```

---

## Cloud Deployment

### Option 1: Railway (Recommended)

[Railway.app](https://railway.app) — simplest Node.js deployment.

1. **Push to GitHub:**
   ```bash
   git remote add origin https://github.com/YOUR_ORG/flight-service.git
   git push -u origin main
   ```

2. **Connect Railway:**
   - Login to railway.app
   - Create new project → Connect GitHub repo
   - Select `flight-service` branch
   - Railway auto-detects Node.js + builds from `Dockerfile`

3. **Set environment variables (Railway dashboard):**
   ```
   ANTHROPIC_API_KEY=sk-ant-v7-...
   PORT=3003
   NODE_ENV=production
   ```

4. **Deploy:**
   - Railway auto-deploys on git push
   - Domain: `project-name.up.railway.app` (public URL)

### Option 2: Render

[Render.com](https://render.com) — free tier available.

1. **Create Web Service:**
   - GitHub repo URL → Select branch
   - Environment: Node
   - Build command: `npm install`
   - Start command: `npm start`

2. **Environment variables:**
   - Add `ANTHROPIC_API_KEY`
   - Add `NODE_ENV=production`

3. **Deploy:** Render auto-deploys on push

### Option 3: Vercel (With Adapter)

Vercel runs serverless functions, requires code changes.  
**Skip for now** — Railway/Render easier for traditional Node.js.

---

## Docker Build (Local/Self-hosted)

```bash
docker build -t flight-service:latest .
docker run -e ANTHROPIC_API_KEY=sk-ant-v7-... -p 3003:3003 flight-service:latest
# Visit http://localhost:3003
```

Push to Docker Hub:
```bash
docker tag flight-service:latest YOURUSERNAME/flight-service:latest
docker push YOURUSERNAME/flight-service:latest
```

---

## Integration with demo.afscdevs.com

**Option A: Reverse Proxy (Recommended)**

If deploying Flight Service to a cloud URL (e.g., `flight-service-prod.up.railway.app`):

1. Update `web/index.html` to call remote API:
   ```javascript
   const API_URL = 'https://flight-service-prod.up.railway.app/api/briefing';
   ```

2. Handle CORS:
   - Server: add CORS headers
   - Client: use `fetch()` (already in place)

3. Deploy HTML to demo.afscdevs.com:
   ```bash
   curl --ftp-ssl-control -k --ftp-pasv \
     --user "afscdevsftp@afsc:PASSWORD" \
     -T web/index.html \
     "ftp://ftp.npulse.net/flight-service/index.html"
   ```

**Option B: Self-hosted on Office Server**

Deploy Node.js server to office machine + nginx reverse proxy.  
Setup: `nginx-magellan.conf` pattern (reference from Magellan repo).

---

## Production Checklist

- [x] Code committed to git (`main` branch)
- [x] Dockerfile builds successfully
- [x] Environment variables configured
- [x] `npm start` runs without errors
- [x] `/health` endpoint returns `{"status":"ok"}`
- [ ] `ANTHROPIC_API_KEY` set in production env
- [ ] HTTPS enforced (cloud hosts provide free SSL)
- [ ] CORS headers added if calling from external origin
- [ ] Rate limiting configured (if expecting high volume)
- [ ] Logging/monitoring set up

---

## Monitoring

**Health check endpoint:**
```bash
curl https://your-deployment.up.railway.app/health
# {"status":"ok","service":"flight-service"}
```

**Cloud platform dashboards:**
- Railway: Dashboard shows logs, CPU, memory
- Render: Logs tab shows stdout/stderr
- Both auto-restart on failure

---

## Scaling

Current implementation:
- Single Node.js process (suitable for < 100 req/sec)
- Weather fetch: cached 10 min (reduces load)
- NOTAM fetch: cached 5 min
- Claude API: ~1 req/sec per pilot (reasonable cost)

If traffic grows:
1. Add Redis caching for NOAA results
2. Implement request queue (Bull/RabbitMQ)
3. Deploy multiple instances behind load balancer
4. Switch to managed Claude API (Anthropic Bedrock, etc.)

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Port 3003 in use | Another process | `lsof -i :3003` → kill, or use `PORT=3004` env var |
| NOAA API timeout | Network blocked | Works in cloud; dev machine isolated |
| No briefing text | Missing ANTHROPIC_API_KEY | Returns fallback; add key to production `.env` |
| CORS error | Browser → external API | Ensure API has CORS headers (already in place) |

---

## Next Steps (Post-MVP)

1. **Real FAA NOTAM API:** Research endpoint or wire scraper
2. **SUA database:** Integrate OpenFlight or FAA GIS layers
3. **Voice integration:** Wire Albert server (Twilio SIP)
4. **Aircraft lookup:** N-number → type/location database
5. **Analytics:** Track briefing requests for SAR audit trail

---

**Author:** Flight Service Team  
**Last Updated:** 2026-08-20
