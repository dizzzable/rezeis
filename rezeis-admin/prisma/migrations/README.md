# Prisma migrations

Apply checked-in schema changes with `npm run prisma:migrate:deploy` from `rezeis-admin`.

The `20260418221000_login_first_credentials` migration is guarded for existing environments that still carry pre-login-first rows. It sanitizes legacy login sources into valid login-policy values (`[A-Za-z0-9._-]`, length `3..64`), then backfills `AdminUser.login` plus `loginNormalized` and keeps `WebAccount.login` plus `loginNormalized` aligned when legacy credential data already exists. Deterministic UUID-based suffixes are applied to both fields when collision resolution is required.
