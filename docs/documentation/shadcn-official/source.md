# shadcn/ui Official Docs Snapshot

This directory mirrors the official shadcn/ui documentation source from:

- `https://ui.shadcn.com/docs`
- `https://github.com/shadcn-ui/ui`

## Snapshot Details

- Collected on `2026-03-30`
- Source repository: `shadcn-ui/ui`
- Source docs path: `apps/v4/content/docs`
- Mirrored documentation pages: `204`
- Mirrored navigation metadata files: `11` `meta.json` files
- Total mirrored docs content files: `215`

## Layout

- `docs/(root)/`: overview and core documentation pages
- `docs/installation/`: framework-specific and manual installation guides
- `docs/forms/`: forms guides
- `docs/dark-mode/`: dark mode guides
- `docs/rtl/`: right-to-left support guides
- `docs/registry/`: registry, schema, namespaces, auth, and examples
- `docs/components/base/`: Base UI component docs
- `docs/components/radix/`: Radix-based component docs
- `docs/changelog/`: official release notes and migration history
- `manifest.md`: generated table of contents for the mirrored corpus

## Coverage

- Core docs: introduction, CLI, `components.json`, directory structure, Figma, JavaScript support, legacy notes, MCP, monorepo, new styles, React 19, skills, Tailwind v4, theming, and v0 integration
- Installation docs for Next.js, Vite, Astro, Remix, React Router, TanStack Router / Start, Laravel, Gatsby, and manual setup
- Workflow docs for forms, dark mode, RTL, MCP, and coding-agent usage
- Full registry docs including `registry.json`, `registry-item.json`, auth, namespace, examples, and registry MCP
- Full component catalog for both Base and Radix variants
- Changelog through `2026-03-06` entry for CLI v4

## Notes

- Files are copied from the official docs source, not rewritten summaries.
- This snapshot follows the current v4 docs app in the upstream repository.
- The docs now explicitly include pages for coding agents (`skills.mdx`), MCP (`mcp.mdx`), registry MCP, presets, CLI v4, and cross-framework setup.
- Both Base and Radix component tracks are mirrored completely because the docs ship them as parallel first-class component catalogs.
- The copied `meta.json` files are preserved because they define docs navigation and section ordering in the official site source.

## Useful Searches

```powershell
rg "init|add|view|search|info|docs|migrate" docs/shadcn-official/docs
rg "components.json|theming|tailwind v4|react 19|monorepo|javascript" docs/shadcn-official/docs
rg "registry.json|registry-item.json|namespace|authentication|mcp|preset" docs/shadcn-official/docs/registry docs/shadcn-official/docs/changelog
rg "dark mode|RTL|react-hook-form|tanstack-form" docs/shadcn-official/docs
rg "Installation|Usage|Examples|Manual" docs/shadcn-official/docs/components/base docs/shadcn-official/docs/components/radix
```
