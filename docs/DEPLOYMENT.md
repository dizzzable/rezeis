# Rezeis Panel - Deployment Guide

## System Requirements

### Minimum Requirements (Up to 100 users)

| Component | CPU | RAM | Storage |
|-----------|-----|-----|---------|
| **Total** | 2 cores | 2 GB | 20 GB SSD |
| PostgreSQL | 1 core | 512 MB | 10 GB |
| Backend | 1 core | 512 MB | - |
| Frontend | 0.5 cores | 128 MB | - |
| Valkey (Redis) | 0.5 cores | 128 MB | 2 GB |
| Nginx | 0.25 cores | 64 MB | - |

### Recommended Requirements (100-1000 users)

| Component | CPU | RAM | Storage |
|-----------|-----|-----|---------|
| **Total** | 4 cores | 4 GB | 50 GB SSD |
| PostgreSQL | 2 cores | 1 GB | 30 GB |
| Backend | 2 cores | 1 GB | - |
| Frontend | 1 core | 256 MB | - |
| Valkey (Redis) | 1 core | 256 MB | 5 GB |
| Nginx | 0.5 cores | 128 MB | - |

### High Load Requirements (1000+ users)

| Component | CPU | RAM | Storage |
|-----------|-----|-----|---------|
| **Total** | 8 cores | 8 GB | 100 GB SSD |
| PostgreSQL | 4 cores | 2 GB | 50 GB |
| Backend | 4 cores | 2 GB | - |
| Frontend | 2 cores | 512 MB | - |
| Valkey (Redis) | 2 cores | 512 MB | 10 GB |
| Nginx | 1 core | 256 MB | - |

## Quick Start

### 1. Server Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo apt install docker-compose-plugin -y

# Create network
docker network create remnawave-network
```

### 2. Project Setup

```bash
# Clone or upload project
cd /opt
mkdir -p rezeis && cd rezeis

# Copy project files (or clone from git)
# git clone <your-repo> .

# Set proper permissions
chmod +x scripts/*.sh
```

### 3. Environment Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env
```

Required variables:
```env
# Domain
APP_DOMAIN=your-domain.com

# Database
DATABASE_PASSWORD=secure_random_password
DATABASE_URL=postgresql://rezeis:secure_password@postgres:5432/rezeis_panel

# Valkey (Redis)
VALKEY_PASSWORD=another_secure_password

# JWT Secrets (generate strong random strings)
JWT_SECRET=your-super-secret-minimum-32-chars
JWT_REFRESH_SECRET=your-refresh-secret-minimum-32-chars

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
SUPER_ADMIN_TELEGRAM_ID=your_telegram_id

# Remnawave
REMNAWAVE_TOKEN=your_remnawave_api_token
REMNAWAVE_WEBHOOK_SECRET=random_webhook_secret
```

### 4. SSL Certificates

Using Let's Encrypt (recommended):

```bash
# Install certbot
sudo apt install certbot -y

# Generate certificates
sudo certbot certonly --standalone -d your-domain.com

# Create nginx ssl directory
mkdir -p nginx/ssl

# Copy certificates
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem nginx/ssl/your-domain.com.cer
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem nginx/ssl/your-domain.com.key
sudo cp /etc/letsencrypt/live/your-domain.com/chain.pem nginx/ssl/ca.cer

# Set permissions
sudo chown -R $USER:$USER nginx/ssl
chmod 600 nginx/ssl/*.key
```

### 5. First Deployment

```bash
# Build and start services
docker compose up -d --build

# Check logs
docker compose logs -f backend

# Verify all services are healthy
docker compose ps
```

### 6. Initial Setup

Open `https://your-domain.com` in browser. Since no admin exists yet, you'll be redirected to the setup page.

1. Enter desired username and password
2. Enter your Telegram ID (must match SUPER_ADMIN_TELEGRAM_ID in .env)
3. Click "Create Super Admin"
4. Login with created credentials

## Maintenance

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f postgres

# Last 100 lines
docker compose logs --tail=100 backend
```

### Update Application

```bash
# Pull latest changes
git pull origin main

# Rebuild and restart
docker compose down
docker compose up -d --build

# Database migrations (if needed)
docker compose exec backend npx prisma migrate deploy
```

### Backup Database

```bash
# Manual backup
docker compose exec postgres pg_dump -U rezeis rezeis_panel > backup_$(date +%Y%m%d_%H%M%S).sql

# Automated backups (enable in .env)
# BACKUP_ENABLED=true
# BACKUP_INTERVAL_HOURS=24
```

### Monitoring

```bash
# Resource usage
docker stats

# Container status
docker compose ps

# System health
curl https://your-domain.com/health
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs <service-name>

# Check resource limits
docker system df

# Restart service
docker compose restart <service-name>
```

### Database Connection Issues

```bash
# Check postgres is running
docker compose ps postgres

# Verify connection string in .env
# Format: postgresql://user:password@postgres:5432/dbname

# Reset database (WARNING: deletes all data!)
docker compose down -v
docker compose up -d
```

### Out of Memory

```bash
# Check memory usage
free -h
docker stats --no-stream

# Increase swap (temporary fix)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Permanent fix: Upgrade server RAM
```

### Build Fails

```bash
# Clear build cache
docker builder prune -f

# Rebuild from scratch
docker compose down
docker compose build --no-cache
docker compose up -d
```

## Production Checklist

- [ ] Strong passwords in .env
- [ ] SSL certificates configured
- [ ] Firewall enabled (only 443/tcp open)
- [ ] Regular backups configured
- [ ] Monitoring enabled
- [ ] Resource limits set in docker-compose.yml
- [ ] Non-root containers running
- [ ] Health checks configured

## Security Notes

1. **Never commit .env file to git**
2. **Use strong random passwords** (32+ characters)
3. **Keep Docker images updated**: `docker compose pull && docker compose up -d`
4. **Enable automatic security updates** on host
5. **Use fail2ban** to prevent brute force attacks
6. **Regular security audits** with `docker scan`

## Performance Tuning

### PostgreSQL

Add to docker-compose.yml for high load:
```yaml
command: >
  postgres
  -c shared_buffers=256MB
  -c effective_cache_size=768MB
  -c work_mem=8MB
  -c maintenance_work_mem=64MB
  -c max_connections=200
```

### Nginx

Enable caching for static assets:
```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## Support

For issues and questions:
- Check logs: `docker compose logs`
- Review this guide
- Check system resources: `htop`, `docker stats`
