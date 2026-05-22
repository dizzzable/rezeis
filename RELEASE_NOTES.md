# Rezeis Admin v0.1.5

## Production-Ready Infrastructure Release

### BullMQ Job Queues (8 queues)
- **Broadcast** — async delivery (text/photo/video), edit, delete, retry, scheduled send
- **Backup** — pg_dump via BullMQ, auto-delivery to Telegram, restore from file
- **Imports** — async file processing (3xui, remnashop, altshop, remnawave), 202 pattern
- **Email** — SMTP delivery with branded templates, auto-send on events
- **Webhooks, Profile-Sync, Payments, Automations** — existing queues unified
- **Global QueueModule** — single Redis connection, no duplication

### Email Module (NEW)
- Full SMTP delivery via nodemailer + BullMQ
- Branded HTML templates (logo, colors from Settings)
- Auto-send on system events (subscription expired, payment completed, etc.)
- Admin UI: SMTP settings, verify connection, send test email
- Reiwa branding integration

### Health & Observability
- `GET /api/health` — DB + Redis + Queues + Disk status with latency
- `GET /api/health/live` / `GET /api/health/ready` — k8s probes
- Queue maintenance cron (every 6h): cleanup stale jobs, audit log rotation
- Graceful shutdown for BullMQ workers

### Security
- `@nestjs/throttler` — 60 req/min global, 5/min on login (brute-force protection)
- Request timeout middleware (30s default, 120s uploads, infinite SSE)
- Payment auto-retry (failed webhooks retried 3x with exponential backoff)

### Frontend
- **Sidebar drag-and-drop** — reorder items between categories, create custom categories
- **Header redesign** — GitHub update indicator (tiffany glow), Telegram link, Support/Donate
- **Backup page** — settings card (auto-backup, Telegram delivery, retention), restore button
- **Notifications** — Email SMTP settings tab alongside Telegram
- **Security tab** — password change form added
- **HWID device revoked** event — full Telegram notification with device block

### Infrastructure
- Redis: `volatile-lru` (protects BullMQ keys), 512MB, AOF persistence
- Dockerfile: `postgresql16-client` for pg_dump/psql
- Audit log rotation: 90 days retention (configurable via `AUDIT_RETENTION_DAYS`)
- Notification events cleanup: 30 days

### Docker
```bash
docker compose pull
docker compose up -d
```
