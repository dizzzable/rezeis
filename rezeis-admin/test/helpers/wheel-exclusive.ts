import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../src/common/prisma/prisma.service';

/**
 * Serialises the live wheel specs against each other.
 *
 * ── Why a lock and not more careful fixtures ──────────────────────────────
 *
 * There is exactly ONE wheel: the sectors are a single global set, and so is
 * `Settings.wheelSettings`. Every spec that draws from it, or asks whether it
 * may be switched on, is therefore reading a set that another spec file — run
 * in its own process, at the same time, by the test runner — is editing. The
 * symptom is not a clean failure either: a draw lands on a foreign sector and
 * the spec reports the wrong prize, which reads like a bug in the draw.
 *
 * Prefixing ids only isolates the ROWS a spec created, never the wheel those
 * rows are part of. So the wheel specs take a PostgreSQL advisory lock instead
 * and run one after another. It is held for the whole file, released when the
 * connection closes even if the process dies, and costs nothing when only one
 * spec is running.
 *
 * Any new spec that creates an ENABLED sector, or writes `wheelSettings`,
 * belongs behind this lock.
 */
const WHEEL_LOCK_KEY = 8_140_921;

// `$executeRaw` and not `$queryRaw`: `pg_advisory_lock` returns `void`, and
// Prisma refuses to deserialize a void column. The execute path only wants a
// row count, which is exactly as much as this needs.
export async function lockWheel(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`SELECT pg_advisory_lock(${WHEEL_LOCK_KEY})`);
}

export async function unlockWheel(prisma: PrismaService): Promise<void> {
  await prisma
    .$executeRaw(Prisma.sql`SELECT pg_advisory_unlock(${WHEEL_LOCK_KEY})`)
    .catch(() => undefined);
}
