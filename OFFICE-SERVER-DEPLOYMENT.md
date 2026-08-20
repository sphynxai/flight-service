# Flight Service — Office Server Deployment (FreeBSD 15.1)

**Target Server:** 77.111.115.58 (FreeBSD 15.1, Nginx + Node.js + PM2)  
**Reverse Proxy:** Nginx (already installed)  
**Process Manager:** PM2 (already installed)  
**SSL:** Certbot (ready, needs DNS pointed)

---

## Prerequisites (Verify on Server)

SSH to server (when unlocked):
```bash
ssh root@77.111.115.58
```

Check installed:
```bash
node --version          # Should be v20.20.2+
npm --version           # Should be 11.18.0+
docker --version        # If using Docker (optional)
nginx -v                # Should be 1.30.3+
pm2 --version           # Should be 7.0.3+
```

---

## Option A: Docker Deployment (Recommended)

### 1. Build Docker Image Locally

```bash
cd E:\GitHub\flight-service
docker build -t flight-service:latest .
```

### 2. Save Image as Tar (for transfer to server)

```bash
docker save flight-service:latest | gzip > flight-service-latest.tar.gz
# ~500MB compressed
```

### 3. Transfer to Server

**Via VNC Console (if SSH locked):**
- Open provider web console → VNC
- Copy file via web upload or mount USB

**Via git (when SSH unlocked):**
```bash
git clone https://github.com/YOUR_ORG/flight-service.git /srv/www/flight-service
cd /srv/www/flight-service
docker build -t flight-service:latest .
```

### 4. Run Container on Server (via VNC/console)

```bash
# Load image (if transferred as tar)
docker load < flight-service-latest.tar.gz

# Or build directly
cd /srv/www/flight-service
docker build -t flight-service:latest .

# Run container
docker run -d \
  --name flight-service \
  --restart always \
  -p 3003:3003 \
  -e ANTHROPIC_API_KEY=sk-ant-v7-... \
  -e NODE_ENV=production \
  flight-service:latest

# Or use docker-compose
docker-compose up -d
```

### 5. Verify Container Running

```bash
docker ps | grep flight-service
docker logs flight-service
curl http://localhost:3003/health
```

---

## Option B: PM2 Deployment (Simpler, No Docker)

### 1. Clone Repo to Server

```bash
cd /srv/www
git clone https://github.com/YOUR_ORG/flight-service.git
cd flight-service
npm install --production
```

### 2. Create PM2 Ecosystem File

Save as `/srv/www/flight-service/ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'flight-service',
      script: './src/server.js',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3003,
        ANTHROPIC_API_KEY: 'sk-ant-v7-...'
      },
      error_file: '/srv/www/_logs/flight-service.error.log',
      out_file: '/srv/www/_logs/flight-service.out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};
```

### 3. Start with PM2

```bash
cd /srv/www/flight-service
pm2 start ecosystem.config.js --name flight-service
pm2 save
pm2 startup
pm2 logs flight-service
```

### 4. Verify Running

```bash
pm2 status
pm2 logs flight-service | tail -20
curl http://localhost:3003/health
```

---

## Configure Nginx Reverse Proxy

### 1. Copy Nginx Config

```bash
cp /srv/www/flight-service/nginx-flight-service.conf \
   /usr/local/etc/nginx/vhosts/flight-service.conf
```

### 2. Edit Config (if domains needed)

```bash
vi /usr/local/etc/nginx/vhosts/flight-service.conf
# Update server_name to your domains:
# server_name flight-service.afscdevs.com flight-service.kbmsolvedit.net;
```

### 3. Test & Reload Nginx

```bash
nginx -t                    # Syntax check
service nginx restart       # Or: systemctl restart nginx
```

### 4. Verify Proxy Working

```bash
curl http://localhost:3003/health           # Direct
curl http://localhost/health                 # Via Nginx proxy
curl http://flight-service.afscdevs.com/health  # Via hostname (if DNS pointed)
```

---

## SSL Certificate (Certbot)

### 1. Point DNS First

Update DNS records to point to 77.111.115.58:
```
flight-service.afscdevs.com  A  77.111.115.58
flight-service.kbmsolvedit.net  A  77.111.115.58
```

### 2. Issue Cert

```bash
certbot certonly --webroot -w /srv/www -d flight-service.afscdevs.com -d flight-service.kbmsolvedit.net
```

### 3. Uncomment HTTPS Block in Nginx Config

```bash
vi /usr/local/etc/nginx/vhosts/flight-service.conf
# Uncomment the "HTTPS block" section
nginx -t && service nginx restart
```

### 4. Auto-Renew

```bash
certbot renew --dry-run  # Test
# Automatic renewal runs daily via cron
```

---

## Monitoring & Maintenance

### Health Check

```bash
curl https://flight-service.afscdevs.com/health
# {"status":"ok","service":"flight-service"}
```

### View Logs

**Docker:**
```bash
docker logs -f flight-service
```

**PM2:**
```bash
pm2 logs flight-service
tail -f /srv/www/_logs/flight-service.error.log
```

### Restart Service

**Docker:**
```bash
docker restart flight-service
```

**PM2:**
```bash
pm2 restart flight-service
pm2 restart ecosystem.config.js
```

### Update Code (when SSH unlocked)

```bash
cd /srv/www/flight-service
git pull origin main
npm install --production
pm2 restart flight-service
# or: docker-compose pull && docker-compose up -d
```

---

## Performance

Current single-instance setup handles:
- **~50 req/sec** comfortably
- **~500 concurrent users** (assuming 10 sec per briefing)
- **~1GB RAM** (Node.js + Nginx)

If traffic grows:
1. Increase PM2 instances: `instances: 'max'`
2. Add Redis cache for NOAA results
3. Scale horizontally (multiple servers behind load balancer)

---

## Troubleshooting

| Issue | Diagnosis | Fix |
|-------|-----------|-----|
| Port 3003 in use | `lsof -i :3003` | Kill process or use different port |
| Nginx proxy fails | `nginx -t` | Check config syntax |
| PM2 not starting | `pm2 logs` | Check NODE_ENV, ANTHROPIC_API_KEY |
| Docker image won't build | `docker build -t test .` (verbose) | Check Dockerfile, network |
| SSL cert expired | `certbot certificates` | Run `certbot renew` |
| High memory usage | `ps aux \| grep node` | Restart PM2 app |

---

## Post-Deployment Checklist

- [ ] Container/PM2 process running (`pm2 status` or `docker ps`)
- [ ] Health endpoint responds: `curl http://localhost:3003/health`
- [ ] Nginx proxy works: `curl http://localhost/health`
- [ ] Logs show no errors: `pm2 logs` or `docker logs`
- [ ] ANTHROPIC_API_KEY set in environment
- [ ] DNS pointed to 77.111.115.58 (if using domain)
- [ ] SSL cert issued (if domain-based)
- [ ] Auto-restart enabled (PM2 startup / Docker restart policy)
- [ ] Backups configured (`/srv/www/_logs/` monitored)

---

## Rollback

If deployment fails:

**Docker:**
```bash
docker stop flight-service
docker rm flight-service
docker run -d ... flight-service:old-version
```

**PM2:**
```bash
pm2 unstartup
pm2 kill
# Restore from backup or re-clone repo
pm2 start ecosystem.config.js
```

---

**Deployment by:** Flight Service Team  
**Server:** 77.111.115.58 (FreeBSD 15.1)  
**Last Updated:** 2026-08-20
