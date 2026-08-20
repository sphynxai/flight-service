#!/bin/bash
# Flight Service Deployment Script (Office Server)
# Run via FreeBSD console/VNC as root
# Usage: bash deploy-office-server.sh [docker|pm2]

set -e

DEPLOY_METHOD=${1:-docker}
REPO_DIR="/srv/www/flight-service"
API_KEY="${ANTHROPIC_API_KEY:-}"

echo "========================================="
echo "Flight Service Deployment"
echo "Method: $DEPLOY_METHOD"
echo "Server: 77.111.115.58 (FreeBSD 15.1)"
echo "========================================="

# Check prerequisites
echo "[1/5] Checking prerequisites..."
which node > /dev/null || { echo "ERROR: Node.js not installed"; exit 1; }
which npm > /dev/null || { echo "ERROR: npm not installed"; exit 1; }
which nginx > /dev/null || { echo "ERROR: Nginx not installed"; exit 1; }

if [ "$DEPLOY_METHOD" = "docker" ]; then
    which docker > /dev/null || { echo "ERROR: Docker not installed"; exit 1; }
fi

if [ "$DEPLOY_METHOD" = "pm2" ]; then
    which pm2 > /dev/null || { echo "INFO: Installing PM2 globally..."; npm install -g pm2; }
fi

# Clone/update repo
echo "[2/5] Cloning/updating repository..."
if [ -d "$REPO_DIR" ]; then
    cd "$REPO_DIR"
    git fetch origin main
    git reset --hard origin/main
else
    mkdir -p /srv/www
    cd /srv/www
    git clone https://github.com/sphynxai/flight-service.git
    cd "$REPO_DIR"
fi

# Install dependencies
echo "[3/5] Installing dependencies..."
npm install --production

# Setup logging directory
echo "[4/5] Setting up logging..."
mkdir -p /srv/www/_logs
touch /srv/www/_logs/flight-service.out.log
touch /srv/www/_logs/flight-service.error.log

# Deploy based on method
echo "[5/5] Deploying ($DEPLOY_METHOD)..."

if [ "$DEPLOY_METHOD" = "docker" ]; then
    # Docker deployment
    docker-compose down 2>/dev/null || true
    docker-compose up -d
    echo ""
    echo "✓ Docker deployment complete"
    echo "Checking container status..."
    docker ps | grep flight-service
    sleep 2
    echo ""
    echo "Testing health endpoint..."
    curl -s http://localhost:3003/health || echo "WARNING: Health check failed (container may still be starting)"

elif [ "$DEPLOY_METHOD" = "pm2" ]; then
    # PM2 deployment
    pm2 delete flight-service 2>/dev/null || true

    # Update ecosystem config with correct API key
    cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'flight-service',
    script: './src/server.js',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3003,
      ANTHROPIC_API_KEY: '$API_KEY'
    },
    error_file: '/srv/www/_logs/flight-service.error.log',
    out_file: '/srv/www/_logs/flight-service.out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
EOF

    pm2 start ecosystem.config.js --name flight-service
    pm2 save
    pm2 startup

    echo ""
    echo "✓ PM2 deployment complete"
    echo "Process status:"
    pm2 status
    sleep 2
    echo ""
    echo "Testing health endpoint..."
    curl -s http://localhost:3003/health || echo "WARNING: Health check failed (process may still be starting)"
else
    echo "ERROR: Unknown deployment method: $DEPLOY_METHOD"
    echo "Usage: bash deploy-office-server.sh [docker|pm2]"
    exit 1
fi

# Configure Nginx reverse proxy
echo ""
echo "========================================="
echo "Configuring Nginx Reverse Proxy"
echo "========================================="

cp nginx-flight-service.conf /usr/local/etc/nginx/vhosts/flight-service.conf

echo "Testing Nginx configuration..."
nginx -t

if [ $? -eq 0 ]; then
    echo "✓ Nginx configuration valid"
    service nginx restart
    echo "✓ Nginx restarted"
else
    echo "ERROR: Nginx configuration failed"
    exit 1
fi

# Final verification
echo ""
echo "========================================="
echo "Deployment Complete ✓"
echo "========================================="
echo ""
echo "Health Check:"
curl -s http://localhost:3003/health | head -c 100
echo ""
echo ""
echo "Nginx Proxy Check:"
curl -s http://localhost/health | head -c 100
echo ""
echo ""
echo "Access:"
echo "  Direct: http://77.111.115.58:3003/health"
echo "  Proxy:  http://77.111.115.58/health"
echo ""
echo "Logs:"
if [ "$DEPLOY_METHOD" = "docker" ]; then
    echo "  docker logs -f flight-service"
else
    echo "  pm2 logs flight-service"
    echo "  tail -f /srv/www/_logs/flight-service.out.log"
fi
echo ""
echo "Restart:"
if [ "$DEPLOY_METHOD" = "docker" ]; then
    echo "  docker restart flight-service"
else
    echo "  pm2 restart flight-service"
fi
echo ""
echo "========================================="
