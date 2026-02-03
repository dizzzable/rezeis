# Rezeis Panel - Docker Architecture Migration Guide

## Overview

This guide describes the migration from the old multi-port Docker architecture to the new secure single-port architecture using nginx reverse proxy.

## Architecture Changes

### Before (Old Architecture)
```
┌─────────────────────────────────────────────────────────────┐
│                         HOST                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  :5432   │ │  :6379   │ │  :4000   │ │  :4001   │ ...   │
│  │ Postgres │ │  Valkey  │ │  Backend │ │  Frontend│       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────────────────────────────────────────┘
```

**Problems:**
- Database and cache ports exposed publicly (security risk)
- Multiple ports to manage and firewall
- No unified SSL termination
- Direct container access from outside

### After (New Architecture)
```
┌─────────────────────────────────────────────────────────────┐
│                         HOST                                │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                     :443 ONLY                         │ │
│  │                    nginx (SSL)                        │ │
│  └───────────────────────────────────────────────────────┘ │
│                         │                                   │
│  ┌──────────────────────┼───────────────────────────────┐  │
│  │   remnawave-network  │   (external Docker network)   │  │
│  │                      │                               │  │
│  │  ┌──────────┐  ┌────┴───────┐  ┌──────────┐         │  │
│  │  │  Backend │  │  Frontend  │  │  MiniApp │         │  │
│  │  │  :4000   │  │   :4001    │  │  :4002   │         │  │
│  │  │  :4003   │  │            │  │          │         │  │
│  │  │  (WS)    │  │            │  │          │         │  │
│  │  └──────────┘  └────────────┘  └──────────┘         │  │
│  │       │                                              │  │
│  │  ┌────┴────┐    ┌──────────┐                        │  │
│  │  │ Postgres│    │  Valkey  │                        │  │
│  │  │ :5432   │    │  :6379   │                        │  │
│  │  └─────────┘    └──────────┘                        │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Benefits:**
- Only port 443 exposed externally
- Database and cache isolated (no public access)
- Unified SSL/TLS termination at nginx
- Single network (`remnawave-network`) for all services
- WebSocket on dedicated port 4003 (no conflict with Remnawave's 3000)

## Service Ports

| Service | Internal Port | Description |
|---------|---------------|-------------|
| Backend API | 4000 | HTTP API server |
| Frontend | 4001 | Web application |
| MiniApp | 4002 | Telegram Mini App |
| WebSocket | 4003 | Real-time monitoring (separate from API) |
| PostgreSQL | 5432 | Internal only |
| Valkey | 6379 | Internal only |

## Migration Steps

### Step 1: Backup Current Data

```bash
# Navigate to rezeis directory
cd /path/to/rezeis

# Backup database
docker exec rezeis-panel-db pg_dump -U rezeis rezeis_panel > backup_$(date +%Y%m%d_%H%M%S).sql

# Backup environment file
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
```

### Step 2: Stop Current Services

```bash
# Stop all rezeis services
docker-compose down

# Stop nginx if running
cd nginx && docker-compose down

# Verify no ports are in use
sudo netstat -tlnp | grep -E '4000|4001|4002|5432|6379'
```

### Step 3: Create Docker Network

```bash
# Ensure remnawave-network exists (created by remnawave)
docker network ls | grep remnawave-network

# If not exists, create it:
docker network create remnawave-network
```

**Note:** Only `remnawave-network` is used. No separate `rezeis-network` is created.

### Step 4: Setup ACME.sh for SSL Certificates

```bash
# Install acme.sh if not already installed
curl https://get.acme.sh | sh
source ~/.bashrc

# Issue certificate (standalone mode - port 443 must be free)
~/.acme.sh/acme.sh --issue --standalone -d your-domain.com --ecc

# Auto-renewal is configured automatically
# Certificates location: ~/.acme.sh/your-domain.com_ecc/
```

**Important:** Replace `your-domain.com` with your actual domain name in:
- `rezeis/nginx/nginx.conf` (server_name and SSL paths)
- `rezeis/nginx/docker-compose.yml` (volume path for certificates)
- `rezeis/.env` (APP_DOMAIN)

### Step 5: Update Environment Configuration

Update your `.env` file:

```bash
# Change APP_DOMAIN to your actual domain
APP_DOMAIN=your-domain.com

# Ports (all internal, accessed via nginx)
APP_BACKEND_PORT=4000
APP_FRONTEND_PORT=4001
APP_MINIAPP_PORT=4002
APP_WEBSOCKET_PORT=4003

# Update frontend URLs to use relative paths
VITE_API_URL=/api
VITE_WS_URL=wss://your-domain.com/ws

# Update CORS to allow only your domain
CORS_ORIGINS=https://your-domain.com

# Update Mini App URL
TELEGRAM_MINI_APP_URL=https://your-domain.com/miniapp/
```

### Step 6: Start Rezeis Services

```bash
# Start rezeis services (database, backend, frontend, miniapp)
cd /path/to/rezeis
docker-compose up -d

# Verify services are running
docker-compose ps
```

### Step 7: Start Nginx Reverse Proxy

```bash
# Start nginx
cd /path/to/rezeis/nginx
docker-compose up -d

# Verify nginx is running
docker-compose ps
docker logs rezeis-nginx
```

### Step 8: Verify Migration

```bash
# Check all services are running
docker ps | grep rezeis

# Test HTTPS access
curl -I https://your-domain.com
curl -I https://your-domain.com/api/health

# Test WebSocket (using wscat or similar)
npx wscat -c wss://your-domain.com/ws/monitoring

# Test Mini App
curl -I https://your-domain.com/miniapp/
```

## URL Changes Reference

| Service | Old URL | New URL |
|---------|---------|---------|
| Frontend | `http://your-domain:4001` | `https://your-domain.com` |
| Backend API | `http://your-domain:4000/api` | `https://your-domain.com/api` |
| WebSocket | `ws://your-domain:4000/ws` | `wss://your-domain.com/ws` |
| Mini App | `http://your-domain:4002` | `https://your-domain.com/miniapp/` |
| Database | `your-domain:5432` | Internal only (not accessible) |
| Valkey/Redis | `your-domain:6379` | Internal only (not accessible) |

## SSL Certificate Management

### Automatic Renewal

ACME.sh automatically sets up cron job for renewal. To verify:

```bash
crontab -l | grep acme
```

### Manual Renewal

```bash
~/.acme.sh/acme.sh --renew -d your-domain.com --ecc --force

# Reload nginx to pick up new certificates
docker exec rezeis-nginx nginx -s reload
```

### Reload Nginx After Certificate Update

```bash
# Create a script for auto-reload after renewal
cat > /root/.acme.sh/reload-rezeis-nginx.sh << 'EOF'
#!/bin/bash
docker exec rezeis-nginx nginx -s reload 2>/dev/null || true
EOF
chmod +x /root/.acme.sh/reload-rezeis-nginx.sh

# Configure acme.sh to reload nginx after renewal
~/.acme.sh/acme.sh --install-cert -d your-domain.com --ecc \
  --reloadcmd "/root/.acme.sh/reload-rezeis-nginx.sh"
```

## Security Improvements

1. **No Database Exposure**: PostgreSQL is no longer accessible from outside
2. **No Cache Exposure**: Valkey/Redis is internal only
3. **Single Entry Point**: Only port 443 is exposed (port 80 is NOT used)
4. **SSL/TLS**: All traffic encrypted with modern cipher suites
5. **Security Headers**: HSTS, X-Frame-Options, X-Content-Type-Options, etc.
6. **WebSocket Security**: WSS (WebSocket Secure) enforced on port 4003
7. **Network Isolation**: All services use single external `remnawave-network`

## Rollback Plan

If you need to rollback to the old architecture:

```bash
# 1. Stop nginx
cd /path/to/rezeis/nginx
docker-compose down

# 2. Stop rezeis services
cd /path/to/rezeis
docker-compose down

# 3. Restore original docker-compose.yml from backup
cp docker-compose.yml.backup docker-compose.yml

# 4. Restore environment file
cp .env.backup.xxx .env

# 5. Start with old configuration
docker-compose up -d
```

## Troubleshooting

### Issue: "Cannot connect to database"

**Cause**: Database is now internal only
**Solution**: Applications must use internal Docker network (host: `postgres`, port: `5432`)

### Issue: "WebSocket connection fails"

**Check:**
```bash
# Verify WebSocket path in nginx.conf
# Should proxy to backend:4003 (not 4000)
docker logs rezeis-nginx | grep websocket

# Verify WebSocket server is listening on port 4003
docker logs rezeis-backend | grep "WebSocket server"
```

### Issue: "SSL certificate not found"

**Check:**
```bash
# Verify certificate paths
ls -la /root/.acme.sh/your-domain.com_ecc/

# Verify volume mount in nginx docker-compose.yml
docker inspect rezeis-nginx | grep -A5 Mounts
```

### Issue: "502 Bad Gateway"

**Check:**
```bash
# Verify backend is running
docker logs rezeis-backend

# Verify network connectivity
docker network inspect remnawave-network

# Test internal connection from nginx
docker exec rezeis-nginx wget -qO- http://backend:4000/health
```

### Issue: "CORS errors in browser"

**Solution**: Update `CORS_ORIGINS` in `.env` to match your domain:
```
CORS_ORIGINS=https://your-domain.com
```

Then restart:
```bash
docker-compose restart backend
```

### Issue: "Network not found"

**Solution**: Create the remnawave-network:
```bash
docker network create remnawave-network
```

## File Structure After Migration

```
rezeis/
├── docker-compose.yml          # Main services (no exposed ports, uses remnawave-network)
├── .env                        # Environment configuration
├── nginx/
│   ├── docker-compose.yml      # Nginx reverse proxy (port 443 only)
│   ├── nginx.conf              # Nginx configuration
│   └── ssl/                    # SSL certificates (acme.sh managed)
├── backend/
│   └── ...
└── docs/
    └── DOCKER_MIGRATION_GUIDE.md  # This file
```

## Network Configuration

### Only Network Used: `remnawave-network`

All services connect through the external `remnawave-network`:

```yaml
networks:
  remnawave-network:
    external: true
    name: remnawave-network
```

**No separate `rezeis-network` is created.**

## Maintenance Commands

```bash
# View all rezeis logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f backend
docker-compose logs -f nginx

# Restart all services
docker-compose restart
docker-compose -f nginx/docker-compose.yml restart

# Update images and restart
docker-compose pull
docker-compose up -d

# Clean up unused images
docker image prune -f

# Verify all services on remnawave-network
docker network inspect remnawave-network
```

## Summary

This migration improves security by:
- Eliminating public database/cache access
- Using a single external port (443) - port 80 is NOT exposed
- Implementing SSL/TLS termination at nginx
- Using single external network (`remnawave-network`)
- Running WebSocket on dedicated port 4003 (avoiding conflict with Remnawave's 3000)

All services remain fully functional with improved security posture.
