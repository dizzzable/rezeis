# Vite Official Guide Snapshot

This directory mirrors the official Vite Guide documentation source from:

- `https://vite.dev/guide/`
- `https://github.com/vitejs/vite`

## Snapshot Details

- Collected on `2026-03-30`
- Source repository: `vitejs/vite`
- Source docs paths:
  - `docs/guide/*.md`
  - `docs/changes/index.md`
- Site version observed while collecting: `v8.0.2`
- Mirrored markdown pages: `25`

## Layout

- `guide/`: official Vite Guide markdown pages
- `changes/`: official breaking changes landing page linked from the Guide sidebar
- `manifest.md`: generated table of contents for the mirrored pages

## Coverage

- Guide introduction and rationale
- Core workflow pages: features, CLI, plugins, dependency pre-bundling, assets, build, deployment, env/mode
- Advanced pages: SSR, backend integration, performance, troubleshooting
- APIs: plugin API, HMR API, JavaScript API, Environment API and its sub-pages
- Migration and breaking changes

## Notes

- Files are copied from the official docs source, not rewritten summaries.
- The Guide currently reflects the Rolldown/Oxc-based Vite 8 documentation.
- Some pages contain custom markdown components such as `::: tip`, `Badge`, or embedded links/assets. Keep them as upstream provenance markers.
- The Guide sidebar also links to `Config`, but this snapshot intentionally focuses on the `Guide` section plus the linked breaking-changes landing page.

## Useful Searches

```powershell
rg "Rolldown|Oxc|plugin-legacy|Baseline" docs/vite-official
rg "optimizeDeps|pre-bundling|cacheDir|hmr" docs/vite-official
rg "middleware mode|SSR|ModuleRunner|Environment API" docs/vite-official
rg "migration|deprecated|breaking changes|future option" docs/vite-official
```
