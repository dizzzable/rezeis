# Prisma Official Docs Snapshot

This directory mirrors the current official Prisma documentation source from:

- `https://www.prisma.io/docs`
- `https://www.prisma.io/docs/orm`
- `https://www.prisma.io/docs/postgres`
- `https://www.prisma.io/docs/cli`
- `https://www.prisma.io/docs/management-api`
- `https://github.com/prisma/docs`

## Snapshot Details

- Collected on `2026-03-30`
- Source repository: `prisma/docs`
- Source docs path: `apps/docs/content/docs`
- Mirrored markdown or MDX pages: `362`
- Mirrored navigation metadata files: `77` `meta.json` files
- Mirrored reference artifact files: `20` `.snagx` files
- Total mirrored docs content files: `459`

## Layout

- `docs/(index)/`: Prisma docs landing pages
- `docs/orm/`: Prisma ORM documentation
- `docs/postgres/`: Prisma Postgres documentation
- `docs/cli/`: Prisma CLI command and workflow documentation
- `docs/guides/`: framework, deployment, migration, and integration guides
- `docs/console/`: Prisma Console documentation
- `docs/studio/`: Prisma Studio documentation
- `docs/accelerate/`: Prisma Accelerate documentation
- `docs/query-insights/`: Query Insights documentation
- `docs/ai/`: Prisma AI tooling and prompt documentation
- `docs/management-api/`: Prisma Management API documentation
- `manifest.md`: generated file inventory for the mirrored corpus

## Coverage

- Full current docs-root corpus from the official Prisma docs app, not only the requested product subsets
- Prisma ORM sections for schema, Prisma Client, Prisma Migrate, references, and core concepts
- Prisma Postgres product docs, including database operations, integrations, IaC, and troubleshooting
- Prisma CLI docs for `db`, `migrate`, `dev`, `console`, and top-level commands
- Prisma Management API docs with SDK, authentication, partner integration, and endpoint reference pages
- Cross-product guides for frameworks, deployment targets, upgrades, data migration, authentication, and integrations
- Console, Studio, Accelerate, Query Insights, and AI documentation that the root docs site links into

## Notes

- Files are copied from the official upstream docs source, not rewritten summaries.
- This snapshot follows the current `apps/docs/content/docs` tree only.
- The current docs site still serves `https://www.prisma.io/docs/platform`, but it redirects to `Console`; the standalone `platform/` source directory exists only in archived `docs.v6`, so it is not merged into this current snapshot.
- The copied `meta.json` files are preserved because they define the official sidebar structure and page ordering.
- The copied `.snagx` files are preserved because Prisma stores some documentation walkthrough assets alongside the content tree.

## Useful Searches

```powershell
rg "Prisma Client|Prisma Migrate|Prisma schema|relation|datasource|generator" docs/prisma-official/docs/orm
rg "prisma init|prisma generate|db pull|db push|migrate dev|migrate deploy|prisma dev" docs/prisma-official/docs/cli docs/prisma-official/docs/orm/reference
rg "Prisma Postgres|connection pooling|backups|serverless driver|query insights" docs/prisma-official/docs/postgres docs/prisma-official/docs/guides/postgres
rg "Management API|authentication|SDK|projects|databases|connections|integrations|regions" docs/prisma-official/docs/management-api
rg "Console|Studio|Accelerate|AI|Query Insights|frameworks|deployment" docs/prisma-official/docs/console docs/prisma-official/docs/studio docs/prisma-official/docs/accelerate docs/prisma-official/docs/ai docs/prisma-official/docs/guides
```
