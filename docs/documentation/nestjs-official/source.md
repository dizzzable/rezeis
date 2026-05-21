# NestJS Official Docs Snapshot

This directory mirrors the official NestJS documentation source from:

- `https://docs.nestjs.com/`
- `https://github.com/nestjs/docs.nestjs.com`

## Snapshot Details

- Collected on `2026-03-30`
- Source archive used: `https://github.com/nestjs/docs.nestjs.com/archive/refs/heads/master.zip`
- Mirrored markdown pages: `136`
- Mirrored content files: `137`

## Layout

- `content/`: official markdown sources copied from the NestJS docs repository
- `manifest.md`: generated table of contents for every mirrored file

## Section Counts

- `content/`: 16 core pages
- `content/cli/`: 5 pages
- `content/devtools/`: 2 pages
- `content/discover/`: 1 page and 1 JSON file
- `content/faq/`: 9 pages
- `content/fundamentals/`: 12 pages
- `content/graphql/`: 18 pages
- `content/microservices/`: 12 pages
- `content/openapi/`: 8 pages
- `content/recipes/`: 20 pages
- `content/security/`: 7 pages
- `content/techniques/`: 20 pages
- `content/websockets/`: 6 pages

## Notes

- Files are copied from the official markdown source, not re-written summaries.
- Some pages include docs-site markers such as `@@filename`, `@@switch`, custom HTML blocks, and asset paths. Keep them as provenance markers from the upstream docs source.
- Use `rg` against `docs/nestjs-official/content` when you need to find an exact official pattern quickly.

## Useful Searches

```powershell
rg "ValidationPipe|ParseIntPipe|PartialType" docs/nestjs-official/content
rg "JwtModule|AuthGuard|Passport" docs/nestjs-official/content
rg "GraphQLModule|ApolloDriver|graphiql" docs/nestjs-official/content
rg "Transport\\.|ClientProxy|MessagePattern|EventPattern" docs/nestjs-official/content
```
