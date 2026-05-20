# Prisma migrations

Apply checked-in schema changes with `npm run prisma:migrate:deploy` from `rezeis-admin`.

The project has no staging or production database yet, so migrations are intentionally squashed into a single baseline migration:

- `20260419000000_init`

Do not add compatibility/backfill logic for pre-baseline schemas until a real deployed database exists. While the project is still pre-stand, keep schema changes in `schema.prisma` and regenerate the baseline migration when we deliberately choose to squash again.
