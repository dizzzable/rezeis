# Rezeis Admin v0.2.6

## Liquid Glass & Visual Effects Studio

### Liquid Glass — полная переработка

Система прозрачности и стеклянных эффектов полностью переписана с нуля.

- **Per-element glass controls** — индивидуальные toggle + blur slider для 7 элементов:
  - Sidebar, Header, Cards, Modals, Tabs, Buttons, Popover/Dropdowns
- **Background Studio** — выбор из 20 анимированных фонов (React Bits) с уникальными параметрами для каждого:
  - Silk, Aurora, Threads, Waves, Iridescence, Galaxy, Particles, DotGrid, LiquidChrome, Balatro, Beams, Plasma, Grainient, SoftAurora, Dither, LineWaves, RippleGrid, Lightning, Radar
  - Dropdown выбора + динамические controls из registry (slider/color/toggle/colorArray/rgbColor/select)
  - Live preview 300×200px с реальным компонентом
  - Draft → Apply workflow (настраивай без мгновенного применения)
- **Per-background props** — store хранит `{ id, opacity, props: Record<string, unknown> }` вместо generic speed/scale/color
- **CSS-driven transparency** — `data-liquid-glass-*` атрибуты на `<html>` + CSS `color-mix()` для полупрозрачности всех поверхностей
- **Header mode** — при включённом glass header по умолчанию полностью прозрачный (элементы на месте, фон просвечивает); toggle включает стеклянный blur
- **Global surface transparency** — `.bg-card`, `.bg-muted`, `.bg-background`, `.bg-accent`, inputs, `.rounded-lg.border` — всё становится полупрозрачным

### Visual Effects Studio (NEW)

Полноценная система кастомизации визуальных эффектов с 5 категориями:

- **Text Animation** (11 вариантов) — Shiny, Gradient, Glitch, Decrypted, Blur, Split, Scrambled, Fuzzy, Rotating, TrueFocus
  - `<TitleEffect>` / `<ShinyText>` автоматически рендерит выбранный эффект на заголовках
- **Cursor Effect** (6 вариантов) — Splash, Blob, Ghost, Crosshair, MagnetLines, PixelTrail
  - Глобальный overlay через `EffectsProvider`
- **Click Effect** (2 варианта) — ClickSpark, StarBorder
  - Canvas-based искры при клике в любом месте
- **Hover Effect** (4 варианта) — Spotlight, Glare, ElectricBorder, Magnet
  - `<HoverEffect>` wrapper для карточек
- **Content Animation** (3 варианта) — FadeContent, AnimatedContent, GradualBlur
  - `<AnimatedContent>` с поддержкой direction/delay

Каждая категория имеет:
- Dropdown выбора эффекта
- **Live preview** прямо в настройках (интерактивный — hover/click/анимация)
- Подсказка где эффект применяется
- Кнопка "Повторить" для анимаций

### UI/UX

- **Двухколоночный layout** настроек Glass и Effects (xl breakpoint)
- **Дефолтная тема зафиксирована**: dark mode, Liquid Chrome фон (opacity 50%), sidebar-primary `#aa1d8b`
- **i18n** — все новые ключи в ru.ts и en.ts (preview, replay, previewHint для каждой категории)
- **AppearanceProvider** расширен — устанавливает `data-liquid-glass-*` атрибуты и CSS-переменные `--liquid-glass-*-blur`

### Stores

- `glass-store.ts` — unified `setElementGlass(element, settings)` action, per-bg props
- `effects-store.ts` — 5 категорий эффектов, master toggle, persist в localStorage
- `theme-store.ts` — дефолт: dark + sidebar-primary override

### Файлы

| Новый файл | Назначение |
|-----------|-----------|
| `lib/theme/effects-store.ts` | Store визуальных эффектов |
| `components/EffectsProvider.tsx` | Глобальный cursor/click provider |
| `components/effects/TitleEffect.tsx` | Universal text animation renderer |
| `components/effects/HoverEffect.tsx` | Universal hover wrapper |
| `features/appearance/effects-settings-card.tsx` | UI настроек эффектов с live preview |
| `features/appearance/background-controls.ts` | Registry 20 фонов с ControlDef[] |

---

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
