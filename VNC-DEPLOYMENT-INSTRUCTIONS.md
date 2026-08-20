# Flight Service — VNC Console Deployment

**Status:** SSH is locked on office server (77.111.115.58)  
**Solution:** Deploy via FreeBSD console/VNC web interface  
**Time:** ~5 minutes  

---

## Step 1: Access Server Console

1. **Open provider's web console** (hosting provider dashboard)
   - IP: 77.111.115.58
   - Login with your hosting account credentials
   - Find "VNC Console" or "IPMI Console" option

2. **Open VNC viewer** in web browser
   - Click "Launch Console" or similar
   - Terminal should appear (FreeBSD prompt)
   - If prompted for password, use: `BlsB1Tvo1QYT` (root password from SSH.txt)

---

## Step 2: Download & Run Deployment Script

In the VNC console, execute:

```bash
# Login as root (if not already)
su - root

# Download deployment script
cd /srv/www
wget https://raw.githubusercontent.com/YOUR_ORG/flight-service/main/deploy-office-server.sh
chmod +x deploy-office-server.sh

# Run deployment (choose one)
# Option A: Docker
./deploy-office-server.sh docker

# Option B: PM2
./deploy-office-server.sh pm2
```

---

## Step 3: Monitor Deployment

Script will:
1. ✅ Check Node.js + npm + nginx + docker/pm2
2. ✅ Clone/update flight-service repo
3. ✅ Install npm dependencies
4. ✅ Start container (Docker) or process (PM2)
5. ✅ Configure Nginx reverse proxy
6. ✅ Test health endpoints
7. ✅ Display access URLs + log commands

**Expected output:**
```
=========================================
Flight Service Deployment
Method: docker
Server: 77.111.115.58 (FreeBSD 15.1)
=========================================
[1/5] Checking prerequisites...
[2/5] Cloning/updating repository...
[3/5] Installing dependencies...
[4/5] Setting up logging...
[5/5] Deploying (docker)...
✓ Docker deployment complete
...
Deployment Complete ✓
```

---

## Step 4: Verify Deployment

Once script completes, test in VNC console:

```bash
# Health check (direct)
curl http://localhost:3003/health
# {"status":"ok","service":"flight-service"}

# Health check (via Nginx proxy)
curl http://localhost/health

# Full briefing test
curl -X POST http://localhost:3003/api/briefing \
  -H "Content-Type: application/json" \
  -d '{
    "departure": "KJFK",
    "arrival": "KLAX",
    "altitude": 8000,
    "latitude": 40.7128,
    "longitude": -74.0060
  }'
```

---

## Step 5: Verify Process Running

**Docker:**
```bash
docker ps | grep flight-service
docker logs flight-service
```

**PM2:**
```bash
pm2 status
pm2 logs flight-service
```

Both should show:
- Process running
- Port 3003 active
- No errors in logs

---

## Access Deployed Service

Once deployed, Flight Service is accessible at:

**Internal (office network):**
```
http://77.111.115.58:3003        (direct)
http://77.111.115.58/health      (via Nginx)
```

**Public (after DNS + SSL):**
```
https://flight-service.afscdevs.com
https://flight-service.kbmsolvedit.net
```

---

## Managing the Service

### Docker Method

```bash
# View logs
docker logs -f flight-service

# Restart
docker restart flight-service

# Stop
docker stop flight-service

# Update (new version)
cd /srv/www/flight-service
git pull origin main
docker-compose up -d
```

### PM2 Method

```bash
# View logs
pm2 logs flight-service

# Status
pm2 status

# Restart
pm2 restart flight-service

# Stop
pm2 stop flight-service

# Update (new version)
cd /srv/www/flight-service
git pull origin main
npm install --production
pm2 restart flight-service
```

---

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| Port 3003 in use | `lsof -i :3003` | Kill process or use different PORT |
| Container/process won't start | Docker: `docker logs flight-service`; PM2: `pm2 logs flight-service` | Check error output; may need permissions |
| Nginx proxy fails | `nginx -t` | Check `/usr/local/etc/nginx/vhosts/flight-service.conf` syntax |
| Health check fails | `curl -v http://localhost:3003/health` | Wait 10 sec for startup; check logs |
| Missing dependencies | `npm list` | Run `npm install --production` again |

---

## After Deployment

### Next Steps

1. **Configure DNS** (when ready for public access)
   - Point `flight-service.afscdevs.com` → `77.111.115.58`
   - Point `flight-service.kbmsolvedit.net` → `77.111.115.58`

2. **Issue SSL Certificate**
   ```bash
   certbot certonly --webroot -w /srv/www \
     -d flight-service.afscdevs.com \
     -d flight-service.kbmsolvedit.net
   ```

3. **Enable HTTPS in Nginx**
   - Edit `/usr/local/etc/nginx/vhosts/flight-service.conf`
   - Uncomment HTTPS block
   - Update cert paths
   - Restart: `service nginx restart`

4. **Set up monitoring** (optional)
   - Watch logs: `pm2 logs flight-service` or `docker logs -f flight-service`
   - Monitor CPU/memory: `top`, `vmstat`, `docker stats`
   - Health check cron: `*/5 * * * * curl -f http://localhost:3003/health || alert`

---

## Support

**Logs location:**
- Docker: `docker logs flight-service`
- PM2: `/srv/www/_logs/flight-service.out.log` and `.error.log`
- Nginx: `/var/log/nginx/error.log` (if proxy issues)

**Restart if needed:**
- Docker: `docker restart flight-service`
- PM2: `pm2 restart flight-service` or `pm2 restart ecosystem.config.js`

**SSH Access** (when enabled):
```bash
ssh root@77.111.115.58
# Then use same commands as above
```

---

**Deployment Method:** VNC Console  
**Estimated Time:** 5 minutes  
**Risk Level:** Low (rollback: delete container / `pm2 delete flight-service`)

🚀 **Ready to deploy via VNC console**
