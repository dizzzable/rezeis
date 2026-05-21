# Vue Official Guide Snapshot

This directory mirrors the official Vue Guide documentation source from:

- `https://vuejs.org/guide/`
- `https://github.com/vuejs/docs`

## Snapshot Details

- Collected on `2026-03-30`
- Source repository: `vuejs/docs`
- Source branch observed while collecting: `main`
- Source docs path: `src/guide`
- Mirrored markdown pages: `52`
- Total mirrored guide files: `93`

## Layout

- `guide/`: official Vue Guide markdown pages plus guide-local assets and demos
- `manifest.md`: generated table of contents for the mirrored guide pages

## Coverage

- Introduction and quick start
- Essentials: application instance, template syntax, reactivity, computed state, watchers, forms, lifecycle, refs, conditional/list rendering, class/style binding
- Components: registration, props, events, `v-model`, attrs, slots, provide/inject, async components
- Reusability: composables, custom directives, plugins
- Built-ins: `Teleport`, `KeepAlive`, `Suspense`, transitions
- Scaling up: SFCs, tooling, routing, state management, testing, SSR
- Best practices: accessibility, performance, security, production deployment
- TypeScript guidance for Vue
- Extras: usage modes, Composition API FAQ, reactivity internals, render functions, rendering mechanism, web components, removed reactivity transform notes, animation techniques

## Notes

- Files are copied from the official docs source, not rewritten summaries.
- The snapshot is scoped to the Vue Guide section requested by the user, rather than the whole API/reference site.
- The mirrored pages preserve upstream frontmatter, admonitions, embedded Vue/Vite references, and custom markdown components.
- The quick-start page currently states the recommended local build-tool prerequisite as Node.js `^20.19.0 || >=22.12.0`; treat version-sensitive details as snapshot-specific and re-check upstream if you need a newer answer.

## Useful Searches

```powershell
rg "create-vue|Node.js|Vite|Vue CLI|runtime-only" docs/vue-official/guide
rg "ref\\(|reactive\\(|computed|watchEffect|watch\\(" docs/vue-official/guide/essentials docs/vue-official/guide/extras
rg "props|emit|v-model|slot|provide|inject|Teleport|Suspense|KeepAlive" docs/vue-official/guide
rg "SSR|SSG|hydrate|state management|TypeScript|vue-tsc|security|deployment" docs/vue-official/guide
```
