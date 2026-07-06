# Research: PostgreSQL 17 → 18 upgrade (rezeis)

**Status:** Research / not scheduled. This is a SEPARATE maintenance task — do
NOT bundle it with application patches. Requires a backup + maintenance window.

**Current stack (as of this doc):**
- DB: `postgres:17-alpine` (docker-compose `rezeis-db`, `memory: 512M`, SSD).
- Cache/broker: `valkey/valkey:9-alpine`.
- App: NestJS 11 + Prisma 7 (`@prisma/adapter-pg`) + BullMQ. Pool auto-sized per
  container tier (`resolveDbPoolMax`: small=5 / medium=10 / large=20).

---

## 1. Why (and why NOT) — expectation setting

PostgreSQL 18's headline is **Asynchronous I/O (AIO)** — the press kit claims
**up to ~3× faster reads from storage**
(https://www.postgresql.org/about/press/presskit18/en/). BUT the benefit is
scoped: AIO currently accelerates **sequential scans, bitmap heap scans, and
maintenance (VACUUM)** — i.e. large, cold, disk-bound reads
(https://betterstack.com/community/guides/databases/postgresql-asynchronous-io/).

**Our workload is OLTP:** small point-lookups by PK/index on `transactions`,
`subscriptions`, `users`, mostly cache-warm. The subscription-provisioning
latency the operator cares about is dominated by the **external Remnawave API**
and queue throughput (already addressed via BullMQ concurrency + fulfilment
idempotency), NOT by Postgres read latency.

**Realistic gain for us:** modest (warm-cache benchmarks show ~20–25%
https://blog.elest.io/postgresql-18-the-5-features-that-actually-matter-for-production/),
plus real value for VACUUM/maintenance and a few planner improvements. It is
**not** the fix for "provisioning is slow".

### Genuinely useful PG18 features for us
- **Skip scan for B-tree** — more multi-column-index queries can use the index.
- **Faster VACUUM / maintenance** (AIO).
- Improved `EXPLAIN`, UUIDv7 (`uuidv7()`), virtual generated columns.
- `io_method` = `sync` | `worker` (default) | `io_uring` (Linux, opt-in).

---

## 2. Blockers / breaking changes (Docker-specific)

1. **PGDATA layout changed in 18.** The official image moved the data dir to a
   version-specific path (`/var/lib/postgresql/18/docker`) — see
   docker-library/postgres PR #1259
   (https://github.com/docker-library/postgres/pull/1259). Simply switching the
   tag `postgres:17-alpine` → `postgres:18-alpine` on the existing volume
   mounted at `/var/lib/postgresql/data` will FAIL to start / not find the data.
   Refs:
   - https://aronschueler.de/blog/2025/10/30/fixing-postgres-18-docker-compose-startup/
   - https://www.virendrachandak.com/techtalk/postgresql-18-docker-upgrade-dump-and-restore-method/

2. **Major version = on-disk format change.** No in-place restart upgrade; use
   `pg_upgrade` (https://www.postgresql.org/docs/current/pgupgrade.html) or a
   **dump/restore**. Our small DB → dump/restore is simplest and safest.

3. **`pg_dump` client version must match the server major.** Our
   `docker-compose.yml` already warns: bumping the DB image REQUIRES updating
   `postgresql18-client` in the `rezeis-admin` Dockerfile, else backups
   (`pg_dump`) break with "server version mismatch".

4. **`io_uring` needs kernel support** (Linux ≥ 5.1, io_uring not disabled by
   the host/seccomp). If unavailable, keep `io_method=worker` (the safe default).

---

## 3. Proposed upgrade plan (dump/restore, small DB)

> Do in a maintenance window. Take a verified backup FIRST.

1. **Backup** the running PG17:
   `docker exec rezeis-db pg_dump -U <user> -Fc -d <db> > rezeis_pg17_<date>.dump`
   (or use the panel's built-in backup). Verify the dump is non-empty/restorable
   on a scratch instance.
2. **Prep the image change** in `docker-compose.yml`:
   - `rezeis-db.image: postgres:18-alpine`
   - Set `PGDATA` / mount explicitly to the new layout OR use a fresh named
     volume (`rezeis-db-data-18`) to avoid the PGDATA breaking change.
3. **Sync the client** in `rezeis-admin/Dockerfile`: `postgresql17-client` →
   `postgresql18-client` (backups + `migrate deploy` tooling).
4. Bring up the empty PG18 container, run `prisma migrate deploy` (schema), then
   **restore data**: `pg_restore -U <user> -d <db> --no-owner rezeis_pg17_<date>.dump`
   (or dump/restore data-only after migrate). Decide migrate-then-data vs
   full pg_restore during the dry run.
5. **Tune PG18**: keep the SSD/memory `-c` overrides already added for PG17;
   add `io_method=worker` (or `io_uring` if the VPS kernel supports it) and
   `effective_io_concurrency` (already 200).
6. **Verify**: app boots, `prisma migrate status` clean, smoke-test a payment →
   provisioning end-to-end, run gates, watch logs.
7. **Rollback**: keep the PG17 volume untouched until PG18 is proven; revert the
   image + volume + Dockerfile client to fall back.

### Zero-downtime alternative (only if needed later)
`pg_createsubscriber` on a physical standby → logical subscriber → `pg_upgrade`
that to 18 while the primary keeps taking writes
(https://nerdleveltech.com/postgres-18-zero-downtime-upgrade-pg-createsubscriber-tutorial).
Overkill for our size; noted for completeness.

---

## 4. Prisma / app compatibility checklist
- Confirm Prisma 7 + `@prisma/adapter-pg` support PG18 (test on scratch DB;
  Prisma tracks new majors quickly — verify at upgrade time).
- Re-run the full migration set on a PG18 scratch DB (`prisma migrate deploy`)
  before touching prod.
- Run the backend test suite against a PG18 container in CI before rollout.

---

## 5. Faster + safer wins we did NOT need a major upgrade for (already applied)
- BullMQ worker concurrency (`PAYMENT_RECONCILIATION_CONCURRENCY`,
  `PROFILE_SYNC_CONCURRENCY`) + lower profile-sync backoff.
- Postgres `-c` tuning for SSD + realistic cache estimate (docker-compose).
- Prisma pool is already auto-sized per container tier.

### Still-open quick wins (candidates, no major upgrade)
- `EXPLAIN ANALYZE` the hottest queries (transactions/subscriptions reconcile
  reads) and add/verify composite indexes if any seq-scan hot spots appear.
- Consider **PgBouncer (transaction pooling)** only if the deployment scales to
  many app instances and Postgres connection count becomes the ceiling
  (https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections).

---

## 6. Sources
- PG18 press kit: https://www.postgresql.org/about/press/presskit18/en/
- AIO guide: https://betterstack.com/community/guides/databases/postgresql-asynchronous-io/
- AIO tuning checklist: https://www.cybrosys.com/research-and-development/postgres/the-ultimate-postgresql-18-asynchronous-io-tuning-checklist-with-examples
- Cybertec AIO: https://www.cybertec-postgresql.com/en/postgresql-18-better-i-o-performance-with-aio/
- Production 5 features: https://blog.elest.io/postgresql-18-the-5-features-that-actually-matter-for-production/
- Docker PGDATA fix: https://aronschueler.de/blog/2025/10/30/fixing-postgres-18-docker-compose-startup/
- Docker dump/restore: https://www.virendrachandak.com/techtalk/postgresql-18-docker-upgrade-dump-and-restore-method/
- pg_upgrade: https://www.postgresql.org/docs/current/pgupgrade.html
- Upgrade guide 2026: https://dataegret.com/2026/03/postgresql-major-upgrades-ultimate-guide-in-2026/

> Content from external sources was rephrased/summarized for licensing compliance.
