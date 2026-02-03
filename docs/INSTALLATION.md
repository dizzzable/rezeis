# Installation Guide

This guide covers complete installation of Rezeis for various environments.

## 📋 Table of Contents

- [Requirements](#requirements)
- [Local Development](#local-development)
- [Docker Installation](#docker-installation)
- [Production Deployment](#production-deployment)
- [Environment Variables](#environment-variables)
- [Post-Installation Setup](#post-installation-setup)
- [Troubleshooting](#troubleshooting)

## 🔧 Requirements

### Minimum System Requirements

| Resource | Minimum | Recommended |
|----------|---------|------------|
| CPU | 2 cores | 4 cores |
| RAM | 2 GB | 4 GB |
| Storage | 20 GB SSD | 50 GB SSD |
| Network | 10 Mbps | 100 Mbps |

### Software Requirements

- Docker Engine 24+
- Docker Compose V2
- PostgreSQL 16+ (if not using Docker)
- Valkey 8+ (if not using Docker)

## 🖥️ Local Development

### Option 1: Full Docker Stack

```bash
# 1. Clone the repository
git clone https://github.com/dizzable/rezeis.git
cd rezeis

# 2. Start infrastructure
docker network create remnawave-network
docker-compose up -d postgres valkey

# 3. Install dependencies
cd backend && npm install
cd ../ && npm install

# 4. Configure environment
cp backend/.env.example backend/.env
cp .env.example .env

# 5. Run migrations
cd backend && npx prisma migrate dev

# 6. Start development servers
# Terminal 1 - Backend
cd backend && npm run dev

# Terminal 2 - Frontend
npm run dev
```

### Option 2: Manual Installation

```bash
# 1. Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# 2. Install Valkey
sudo apt install valkey

# 3. Create database
sudo -u postgres psql
CREATE DATABASE rezeis_panel;
CREATE USER rezeis WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE rezeis_panel TO rezeis;

# 4. Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 5. Clone and setup
git clone https://github.com/dizzable/rezeis.git
cd rezeis
npm install
```

## 🐳 Docker Installation

### Quick Start with Docker Compose

```bash
# 1. Clone repository
git clone https://github.com/dizzable/rezeis.git
cd rezeis

# 2. Configure environment
cp .env.example .env
nano .env  # Edit with your values

# 3. Start services
docker-compose up -d

# 4. Check logs
docker-compose logs -f

# 5. Verify services
docker-compose ps
```

### Production Docker Setup

```bash
# 1. Create dedicated directory
mkdir -p /opt/rezeis
cd /opt/rezeis

# 2. Clone repository
git clone https://github.com/dizzable/rezeis.git .

# 3. Configure production environment
cp .env.example .env.production
nano .env.production

# 4. Setup SSL certificates
mkdir -p nginx/ssl
# Copy your SSL certificates here

# 5. Start with production config
docker-compose -f docker-compose.yml up -d

# 6. Setup initial admin (see Post-Installation)
```

## 🚀 Production Deployment

### Prerequisites

1. **Domain Name** - Point DNS to your server IP
2. **SSL Certificate** - Let's Encrypt or purchased certificate
3. **Firewall** - Configure ports 80, 443

### Step 1: Server Preparation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt install docker-compose-plugin -y

# Create network
docker network create remnawave-network
```

### Step 2: Project Setup

```bash
# Create directory
sudo mkdir -p /opt/rezeis
sudo chown $USER:$USER /opt/rezeis
cd /opt/rezeis

# Clone repository
git clone https://github.com/dizzable/rezeis.git .

# Set permissions
chmod +x scripts/*.sh
```

### Step 3: SSL Configuration

```bash
# Install certbot
sudo apt install certbot -y

# Generate certificate
sudo certbot certonly --standalone -d your-domain.com

# Copy certificates
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem nginx/ssl/
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem nginx/ssl/

# Set permissions
sudo chown -R $USER:$USER nginx/ssl
chmod 600 nginx/ssl/*.key
```

### Step 4: Environment Configuration

Edit `.env` with production values:

```env
NODE_ENV=production
APP_DOMAIN=your-domain.com

# Database
DATABASE_PASSWORD=secure_password

# Valkey
VALKEY_PASSWORD=secure_password

# JWT Secrets (generate strong random strings)
JWT_SECRET=your-super-secret-minimum-32-characters-long
JWT_REFRESH_SECRET=your-refresh-secret-minimum-32-characters

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
SUPER_ADMIN_TELEGRAM_ID=your_telegram_id

# Remnawave
REMNAWAVE_TOKEN=your_remnawave_token
REMNAWAVE_WEBHOOK_SECRET=your_webhook_secret
```

### Step 5: Deploy

```bash
# Build and start
docker-compose up -d --build

# Check status
docker-compose ps

# View logs
docker-compose logs -f backend
```

## 📝 Environment Variables

### Core Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | `production` | Environment mode |
| `APP_DOMAIN` | Yes | - | Your domain name |
| `APP_BACKEND_PORT` | No | `4000` | Backend port |
| `APP_FRONTEND_PORT` | No | `4001` | Frontend port |

### Database

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_HOST` | Yes | `postgres` | Database host |
| `DATABASE_PORT` | Yes | `5432` | Database port |
| `DATABASE_NAME` | Yes | `rezeis_panel` | Database name |
| `DATABASE_USER` | Yes | `rezeis` | Database user |
| `DATABASE_PASSWORD` | Yes | - | Database password |
| `DATABASE_URL` | Yes | - | Full connection URL |

### Valkey (Cache)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VALKEY_HOST` | Yes | `valkey` | Cache host |
| `VALKEY_PORT` | Yes | `6379` | Cache port |
| `VALKEY_PASSWORD` | No | - | Cache password |
| `VALKEY_DB` | No | `0` | Database number |

### Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | - | JWT signing secret (32+ chars) |
| `JWT_EXPIRES_IN` | No | `7d` | Token expiration |
| `JWT_REFRESH_SECRET` | Yes | - | Refresh token secret |
| `JWT_REFRESH_EXPIRES_IN` | No | `30d` | Refresh token expiration |

### Integrations

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | No | - | Webhook secret |
| `REMNAWAVE_HOST` | Yes | `remnawave` | Remnawave panel host |
| `REMNAWAVE_PORT` | Yes | `3000` | Remnawave port |
| `REMNAWAVE_TOKEN` | Yes | - | Remnawave API token |

### Feature Flags

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEATURE_PAYMENTS_ENABLED` | No | `true` | Enable payments |
| `FEATURE_REFERRAL_ENABLED` | No | `true` | Enable referrals |
| `FEATURE_PARTNER_ENABLED` | No | `true` | Enable partner program |
| `FEATURE_WEBSOCKET_ENABLED` | No | `true` | Enable WebSocket |

## ✅ Post-Installation Setup

### 1. Create Super Admin

1. Open `https://your-domain.com`
2. You will be redirected to setup page
3. Enter:
   - Username
   - Password
   - Telegram ID (must match `SUPER_ADMIN_TELEGRAM_ID`)
4. Click "Create Super Admin"

### 2. Verify Services

```bash
# Check container status
docker-compose ps

# Test API health
curl https://your-domain.com/health

# Check backend logs
docker-compose logs backend
```

### 3. Configure Telegram Bot

1. Open Telegram and talk to @BotFather
2. Create new bot or select existing
3. Copy bot token to `TELEGRAM_BOT_TOKEN`
4. Set webhook: `https://your-domain.com/api/telegram/webhook`

## 🔧 Troubleshooting

### Containers Won't Start

```bash
# Check logs
docker-compose logs <service-name>

# Check resource usage
docker stats

# Restart service
docker-compose restart <service-name>
```

### Database Connection Failed

```bash
# Verify postgres is running
docker-compose ps postgres

# Test connection
docker-compose exec postgres psql -U rezeis -d rezeis_panel

# Check connection string in .env
```

### Out of Memory

```bash
# Check memory
free -h
docker stats --no-stream

# Increase swap
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### SSL Certificate Issues

```bash
# Check certificate
openssl s_client -connect your-domain.com:443

# Renew certificate
sudo certbot renew

# Restart nginx
docker-compose restart frontend
```

## 📚 Next Steps

- [User Guide](USER_GUIDE.md) - Learn to use the panel
- [API Documentation](API.md) - API reference
- [Features](FEATURES.md) - Detailed feature descriptions
- [Deployment](DEPLOYMENT.md) - Advanced deployment options