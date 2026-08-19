# Operator Branding & PWA White-Label

How a white-label operator replaces the "Reiwa" identity end-to-end: the logo on
the cabinet auth screens and the icon + name used when a user installs the
cabinet as a PWA on their phone home screen.

## What an operator configures

In **Branding** (admin panel → `/web-reiwa`), the Identity, "How the logo is
shown", "App icon (PWA)" and Card-logo cards:

- **Brand logo** (`logoUrl`) — header / auth-screen mark. May be SVG, PNG or
  WebP, transparent, an external `https://` URL, a `data:` URI, or an uploaded
  `/uploads/branding/...` file. A non-square file is accepted and letterboxed
  inside a square tile; square is what the panel recommends. Used by `<BrandLogo>` on sign-in,
  web-home, TMA-bootstrap, claim, change-password, dashboard, and the side nav.
- **PWA / install icon** (`pwaIconUrl`) — a square PNG (512×512 recommended,
  1024 ok), opaque background, ~10% safe padding for Android's maskable mask.
  Used only for PWA install (manifest icons + iOS apple-touch-icon). Falls back
  to `logoUrl`, then the default Reiwa icons.

- **Card watermark** (`cardLogoUrl`) — the faint mark in the corner of every
  subscription and tariff card. A built-in glyph unless an image is set; SVG,
  PNG or WebP with a transparent background, square, 256 px or more. It is drawn
  semi-transparent, so detail and text on it will not read at any size.

Every one of the three accepts a dropped file as well as a pasted URL, and
reports the intrinsic dimensions of whatever is stored — measured in the
browser off the rendered image, so the read-out is there for a file uploaded
last month too. At most one advisory is raised, and it never blocks the upload: a
non-square file in a square slot, or a raster whose shortest side is below the
slot's recommendation (vectors are exempt from the size advisory — they scale
without loss whatever they measure).

### How big the logo actually renders

This is the question the panel used to have no answer to anywhere, and the
reason an operator uploading a 1024×1024 export reported that it "looks small".

`logoUrl` is drawn at five different sizes, and only the first two are
configurable:

| where | size at default settings | configurable |
|---|---|---|
| entry screens — sign-in, change password | 80 px tile, 46 px mark | yes |
| splash screens — `/`, `/tma` | 96 px tile, 56 px mark | yes |
| `/claim`, `/finish-setup` | 40 px tall, width free | no |
| dashboard header and side nav | 32 px | no |
| PWA install (falls back from `pwaIconUrl`) | 192 and 512 px | no |

The **Как показывать логотип / How the logo is shown** card governs the first
two:

- **Tile size** (100–175 %) scales the whole tile, plate included.
- **Fill** (40–100 %) is how much of that tile the mark occupies. This is the
  one that matters for an app-icon export: `object-fit: contain` fits the FILE,
  and an artboard with its own safe-area margin therefore renders a mark that
  looks small no matter how large the tile is. Raising the fill is what
  recovers that space; trimming the padding out of the file is better still.
- **Frame** — `glass` (the look every deployment had before this setting),
  `solid` (same plate, no backdrop blur — cheaper on iOS, where a
  backdrop-filtered layer is re-sampled per frame), `outline` (hairline only),
  `none` (no plate at all; the mark sits on the page background). The tile
  keeps its box in every case, so turning the plate off does not move the form
  below it.
- **Corner rounding** follows the cabinet theme's item radius by default —
  which is what the tile always did, since its corners were
  `calc(var(--radius) * 2.2)`. Switch **как в теме / from theme** off to set an
  explicit 0–50 % of the tile's width (50 % is a circle); switching off adopts
  whatever the theme is producing at that moment rather than jumping.
- **Glow** (0–100 %) scales the halo's radius. Its colour and opacity are fixed
  by the theme and do not change with the slider.

The panel previews the entry tile at true size next to the 32 px header mark,
because the same file has to survive both.

Watermark **size** (50–200 %) and **presence** (2–40 %) sit on the Subscription
card tab and apply to the built-in glyphs and a custom image alike. To remove
the watermark, pick **Нет / None** in the glyph list — which also clears an
uploaded custom mark, because a custom image otherwise wins over any glyph. The
opacity floor is deliberately above zero so "hidden" stays one decision made in
one place.

### What an upgrade changes before anyone touches a control

Defaults were chosen to reproduce the previous rendering, and they very nearly
do. Four differences are deliberate and worth knowing before you upgrade:

- the entry-screen mark grows **44 → 46.4 px** and the splash mark shrinks
  **56 → 55.68 px** — one fill ratio now serves both tiles, and 0.58 is the
  value that keeps the splash within a third of a pixel;
- the mark's own corners inside the tile go **19.6 → 19.6 px** while the
  rounding is inherited (unchanged), and become concentric with the tile only
  once you set an explicit radius;
- the entry tile gains a **1 px hairline**. It was declared in the markup all
  along (`ring-1`) and never painted, because an inline `box-shadow` on the same
  element overrode the class. It is painted now for every frame except `none`;
- a **custom** card watermark on the subscription picker goes **0.12 → 0.10**
  opacity, matching the other two surfaces, which had always been 0.10.

Everything else — tile sizes, corner rounding, glow, glyph watermarks — is
unchanged.

**The cabinet must be upgraded too.** A cabinet older than this release ignores
these settings entirely: every control still saves, and nothing changes on
screen. Install the cabinet first, then the panel, so the controls appear only
once the renderer behind them understands them.

All three image slots are uploaded via `POST /admin/settings/branding/logo-upload`
(`BrandingAssetUploadService`), stored on the admin disk under
`<BRANDING_UPLOADS_DIR or data/uploads/branding>/<hash>.<ext>`, and the
returned relative URL is saved into `Settings.brandingSettings`
(`logoUrl` / `pwaIconUrl` / `cardLogoUrl`). SVG uploads are sanitised before
hitting disk.

## How it reaches the cabinet (and survives an admin outage)

```
admin upload → /uploads/branding/<hash>.png (admin disk)
            → brandingSettings.{logoUrl|pwaIconUrl}
            → GET /internal/branding/public-config  (admin)
            → reiwa GET /api/v1/public-config       (60s cache + SWR + webhook)
            → cabinet BrandingProvider / dynamic manifest
```

- **Dynamic manifest** — reiwa serves `GET /manifest.webmanifest` built from the
  operator branding (`name`/`short_name` = brandName, theme from the palette,
  icons from `pwaIconUrl`→`logoUrl`→default). Registered before the static SPA
  handler so it overrides the baked `web/dist/manifest.webmanifest`. Never
  5xx — a default Reiwa manifest is served on any cache error so installability
  is preserved.
- **Resilient asset delivery** — reiwa serves `GET /uploads/branding/:file` from
  a local disk cache (`BRANDING_CACHE_DIR`, default `<cwd>/.cache/branding`,
  mounted as the `reiwa-branding-cache` docker volume). On first request it
  fetches the file once from the admin host and caches it. If the admin host is
  down and the file is cached, the cached copy is served; if it's not cached, the
  route redirects to the default Reiwa icon (never a broken image). The
  `reiwa.branding.invalidate` webhook (fired on every branding save) evicts the
  cache so a re-uploaded asset is re-fetched fresh.
- **iOS** — `BrandingProvider` updates `<link rel="apple-touch-icon">` at runtime
  to the operator icon, since iOS reads it from the DOM at "Add to Home Screen"
  time (the dynamic manifest covers Android/Chromium).

## Install prompt

The cabinet Settings page shows an **"Install app"** item:

- **Android / Chromium** — captures `beforeinstallprompt` and triggers the
  native install prompt.
- **iOS Safari** — shows a branded "Share → Add to Home Screen" instruction
  sheet (no programmatic prompt exists on iOS).
- Hidden when already running standalone (installed) or inside the Telegram Mini
  App (neither signal fires there).

## Env

No new required env for the core. Optional overrides:

- rezeis: `BRANDING_UPLOADS_DIR` (where branding files are stored; defaults to
  `data/uploads/branding`, served under `/uploads`).
- reiwa: `BRANDING_CACHE_DIR` (disk mirror dir; set to `/data/branding-cache`
  with the `reiwa-branding-cache` volume in docker).
