# TypeScript Official Docs Snapshot

This directory mirrors the official TypeScript documentation source from:

- `https://www.typescriptlang.org/docs/`
- `https://github.com/microsoft/TypeScript-Website`

## Snapshot Details

- Collected on `2026-03-30`
- Source branch archive: `https://github.com/microsoft/TypeScript-Website/archive/refs/heads/v2.zip`
- Mirrored docs markdown pages: `308`

## Layout

- `content/`: main TypeScript docs content copied from `packages/documentation/copy/en`
- `tsconfig-reference/`: official TSConfig reference copied from `packages/tsconfig-reference/copy/en`
- `glossary/`: official glossary copied from `packages/glossary/copy/en`
- `manifest.md`: generated table of contents for the mirrored files

## Section Counts

- `content/`: `132` markdown pages
- `tsconfig-reference/`: `166` markdown pages
- `glossary/`: `10` markdown pages

## Notes

- Files are copied from the official docs source, not rewritten summaries.
- The docs use frontmatter and site-specific metadata such as `title`, `permalink`, and `oneline`; keep those as provenance markers from the upstream source.
- Some docs sections intentionally overlap. For example, `project-config/` explains how `tsconfig.json` works conceptually, while `tsconfig-reference/` documents specific flags in depth.
- `handbook-v2/` is the modern handbook. `handbook-v1/` remains mirrored because it is still part of the official source tree and can matter when tracking legacy links or older guidance.

## Useful Searches

```powershell
rg "strictNullChecks|noUncheckedIndexedAccess|exactOptionalPropertyTypes" docs/typescript-official
rg "moduleResolution|nodenext|bundler|verbatimModuleSyntax" docs/typescript-official
rg "declare module|typesVersions|exports|imports" docs/typescript-official
rg "TypeScript 5\\.9|TypeScript 5\\.8|Notable Behavioral Changes" docs/typescript-official/content/release-notes
```
