# React Official Docs Snapshot

This directory mirrors the official React documentation and selected repository documentation from:

- `https://react.dev/learn`
- `https://react.dev/reference/react`
- `https://github.com/reactjs/react.dev`
- `https://github.com/facebook/react`

## Snapshot Details

- Collected on `2026-03-30`
- Source docs repository: `reactjs/react.dev`
- Source docs paths:
  - `src/content/learn`
  - `src/content/reference/react`
- Source code repository: `facebook/react`
- Mirrored React docs pages: `101`
  - `52` pages from `Learn`
  - `49` pages from `reference/react`
- Mirrored repository docs files: `41`
  - `6` root governance / orientation files
  - `2` React Compiler design docs
  - `33` top-level package `README.md` files
- Total mirrored local docs files: `142`

## Layout

- `learn/`: official `react.dev/learn` pages
- `reference/react/`: official `react.dev/reference/react` pages
- `repo/root/`: selected root docs from `facebook/react`
- `repo/compiler/docs/`: React Compiler design and development docs from `facebook/react`
- `repo/packages/*/README.md`: top-level package readmes from `facebook/react`
- `manifest.md`: generated table of contents for the mirrored corpus

## Coverage

- Learn section: installation, setup, JSX, components, props, rendering, state, reducers, context, refs, effects, custom Hooks, TypeScript, React DevTools, and React Compiler learn pages
- React package reference: built-in hooks, built-in components, core APIs, transitions, Suspense, StrictMode, Activity, ViewTransition, `use`, `useEffectEvent`, legacy APIs, and experimental taint APIs
- Repository orientation: root README, changelog, contributing and security docs, maintainers
- Repository package docs: `react`, `react-dom`, `react-reconciler`, `react-refresh`, `scheduler`, `eslint-plugin-react-hooks`, server packages, DevTools packages, test utilities, and related package readmes
- React Compiler repo docs: goals, design principles, architecture, and development guidance

## Notes

- Files are copied from official upstream repositories, not rewritten summaries.
- This snapshot is scoped to the exact sources requested by the user: `Learn`, `reference/react`, and official `facebook/react` repository docs.
- `react.dev/learn/installation` currently states that Create React App is deprecated and links to the React blog post dated `2025-02-14` ("Sunsetting Create React App").
- The React reference snapshot includes current APIs such as `useEffectEvent`, `useActionState`, `useOptimistic`, `use`, `<Activity>`, and `<ViewTransition>`.
- Repository docs include public package readmes plus internal or advanced packages; treat repo package docs as implementation-oriented context, not always stable end-user guidance.

## Useful Searches

```powershell
rg "Create React App|deprecated|framework|Vite|Next|existing project" docs/react-official/learn
rg "state|reducer|context|snapshot|preserving|resetting" docs/react-official/learn
rg "Effect|useEffectEvent|custom Hooks|refs|escape hatch" docs/react-official/learn docs/react-official/reference/react
rg "useState|useReducer|useEffect|use|Suspense|startTransition|Activity|ViewTransition" docs/react-official/reference/react
rg "react-reconciler|react-refresh|eslint-plugin-react-hooks|compiler|server-dom" docs/react-official/repo
```
