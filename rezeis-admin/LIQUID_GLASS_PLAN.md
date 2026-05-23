# Liquid Glass + React Bits — Implementation Plan

## Промпт для следующей сессии

Скопируй и отправь это в новой сессии:

---

Реализуй Liquid Glass тему + интеграцию React Bits компонентов для rezeis-admin панели. Вот детальный план:

## Что нужно сделать

### 1. Liquid Glass CSS Preset

Создать новый пресет в `web/src/lib/theme/presets.ts` с названием "Liquid Glass". Ключевые свойства:

**Light mode:**
- `--background: oklch(0.97 0.01 240 / 85%)` — полупрозрачный фон
- `--card: oklch(1 0 0 / 60%)` — стеклянные карточки
- `--sidebar: oklch(0.98 0.005 240 / 70%)` — стеклянный sidebar
- `--border: oklch(1 0 0 / 30%)` — тонкие белые границы

**Dark mode:**
- `--background: oklch(0.15 0.02 260 / 90%)`
- `--card: oklch(0.2 0.015 260 / 50%)`
- `--sidebar: oklch(0.12 0.02 260 / 70%)`
- `--border: oklch(1 0 0 / 10%)`

**Дополнительные CSS правила (добавить в preset CSS string):**
```css
.glass-card,
[data-theme="liquid-glass"] .rounded-lg.border.bg-card {
  backdrop-filter: blur(12px) saturate(1.5);
  -webkit-backdrop-filter: blur(12px) saturate(1.5);
  box-shadow: 
    0 0 0 1px oklch(1 0 0 / 15%) inset,
    0 4px 24px oklch(0 0 0 / 8%);
}
```

### 2. React Bits компоненты для установки

Установить через CLI (TS + Tailwind вариант):

```bash
cd web
npx shadcn@latest add "https://reactbits.dev/r/SpotlightCard-TS-TW"
npx shadcn@latest add "https://reactbits.dev/r/ShinyText-TS-TW"
npx shadcn@latest add "https://reactbits.dev/r/AnimatedList-TS-TW"
npx shadcn@latest add "https://reactbits.dev/r/SplitText-TS-TW"
npx shadcn@latest add "https://reactbits.dev/r/Noise-TS-TW"
npx shadcn@latest add "https://reactbits.dev/r/Aurora-TS-TW"
npx shadcn@latest add "https://reactbits.dev/r/GlareHover-TS-TW"
npx shadcn@latest add "https://reactbits.dev/r/AnimatedContent-TS-TW"
```

Если CLI не работает — скопировать код вручную с сайта reactbits.dev в `web/src/components/effects/`.

### 3. Где использовать компоненты

| Компонент | Где | Как |
|-----------|-----|-----|
| `SpotlightCard` | Dashboard KPI карточки | Обернуть каждую KPI карточку — spotlight следует за курсором |
| `ShinyText` | Заголовки страниц (h1) | Металлический блеск на "Dashboard", "Analytics" и т.д. |
| `AnimatedList` | Activity Feed на дашборде | Плавное появление новых событий |
| `SplitText` | Заголовок на login page | Staggered entrance "Rezeis Admin" |
| `Noise` | Overlay поверх glass-карточек | Тонкая текстура плёнки (opacity 0.03) |
| `Aurora` | Фон login page | Анимированный градиентный фон |
| `GlareHover` | Кнопки Quick Actions | Блик при наведении |
| `AnimatedContent` | Все секции дашборда | Fade-in при скролле |

### 4. Toggle в настройках

В `web/src/lib/theme/appearance-store.ts` добавить:
```typescript
visualEffects: boolean  // default: true
```

В `AppearanceProvider` добавить `data-effects="on|off"` на `<html>`.

В CSS:
```css
:root[data-effects="off"] .spotlight-effect,
:root[data-effects="off"] .shiny-text-effect,
:root[data-effects="off"] .aurora-bg {
  animation: none !important;
  backdrop-filter: none !important;
  filter: none !important;
}
```

В UI (Appearance page → Layout tab) добавить switch "Visual Effects" рядом с "Animations".

### 5. Appearance page — добавить секцию "Effects"

В табе "Layout" добавить:
- Toggle "Visual Effects" (вкл/выкл все React Bits эффекты)
- Toggle "Glass Blur" (вкл/выкл backdrop-filter на карточках)
- Slider "Blur Intensity" (4px — 20px)
- Slider "Glass Opacity" (30% — 80%)

### 6. Login page — Aurora background

Заменить текущий `bg-muted/30` на:
```tsx
<div className="relative min-h-screen overflow-hidden">
  {visualEffects && <Aurora />}
  <div className="relative z-10 flex items-center justify-center min-h-screen p-4">
    {/* existing login card */}
  </div>
</div>
```

### 7. Зависимости

React Bits компоненты могут требовать:
- `motion` (framer-motion) — **уже есть** в проекте
- `gsap` — может понадобиться для SplitText. Установить: `npm install gsap`

### 8. Важные ограничения

- **НЕ ломать shadcn/ui** — все эффекты через дополнительные wrapper-компоненты или CSS classes
- **НЕ менять существующие компоненты в `web/src/components/ui/`** — только добавлять новые
- **Performance** — все эффекты должны быть отключаемы через toggle
- **Accessibility** — `prefers-reduced-motion: reduce` должен отключать все анимации
- **Mobile** — на мобильных backdrop-filter может быть тяжёлым, учитывать

### 9. Структура файлов

```
web/src/
├── components/
│   ├── effects/           # React Bits компоненты (новая папка)
│   │   ├── SpotlightCard.tsx
│   │   ├── ShinyText.tsx
│   │   ├── AnimatedList.tsx
│   │   ├── SplitText.tsx
│   │   ├── Noise.tsx
│   │   ├── Aurora.tsx
│   │   ├── GlareHover.tsx
│   │   └── AnimatedContent.tsx
│   └── ui/                # shadcn/ui (НЕ ТРОГАТЬ)
├── lib/
│   └── theme/
│       ├── presets.ts     # Добавить LIQUID_GLASS preset
│       └── appearance-store.ts  # Добавить visualEffects toggle
└── features/
    ├── auth/
    │   └── sign-in-page.tsx  # Aurora background
    └── dashboard/
        └── dashboard-kpi-grid.tsx  # SpotlightCard wrapper
```

### 10. Порядок реализации

1. Создать Liquid Glass CSS preset в `presets.ts`
2. Добавить `visualEffects` в appearance store
3. Установить/скопировать React Bits компоненты
4. Интегрировать Aurora на login page
5. Обернуть KPI карточки в SpotlightCard
6. Добавить ShinyText на заголовки
7. Добавить AnimatedContent на секции дашборда
8. Добавить Noise overlay на glass-карточки
9. Добавить toggle в Appearance page
10. Проверить build + ESLint + тесты
11. Commit + push + release

### 11. Текущее состояние проекта

- Версия: 0.2.3
- Стек: React 19 + TypeScript 5.9 + Vite 8 + Tailwind 4 + shadcn/ui
- Тема: OKLCH variables, 7 presets, per-token overrides
- Motion (framer-motion) уже установлен
- Appearance store: density, fontSize, animationsEnabled
- Путь к проекту: `v:\REZEIS_ADMIN_RUID_USER\rezeis\rezeis-admin\`
- Frontend: `web/` subfolder
- Git remote: `https://github.com/dizzzable/rezeis.git`

---

Используй skills и поиск в интернете для решения проблем. Убедись что shadcn/ui не сломан после интеграции.
