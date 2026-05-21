import { Logger } from '@nestjs/common';

/**
 * Process roles for the rezeis-admin runtime.
 *
 * The same Nest application bootstraps both the HTTP API container and
 * the background worker container. Most modules behave identically in
 * both — Prisma, services, BullMQ producers, the request pipeline — but
 * `@Cron` jobs MUST run in exactly one process to avoid double-firing
 * (every tick would be executed twice, leading to duplicated audit
 * entries, double Telegram alerts, double "mark expired" passes, etc.).
 *
 * Roles
 *   - `api`    — HTTP API only. Cron jobs are skipped.
 *   - `worker` — background processing only. HTTP routes are still
 *     registered (Nest doesn't `app.listen()` in the worker entrypoint),
 *     but cron jobs run.
 *   - `all`    — single-container deployments (dev, small installs).
 *     Cron jobs run, HTTP listens, BullMQ processors attach.
 *
 * The role is read once from `RUID_PROCESS_ROLE`, defaulting to `all`,
 * and cached so service code never has to re-parse the env variable.
 */
export type ProcessRole = 'api' | 'worker' | 'all';

const VALID_ROLES: ReadonlySet<ProcessRole> = new Set<ProcessRole>(['api', 'worker', 'all']);
const LOGGER = new Logger('ProcessRole');

let cachedRole: ProcessRole | null = null;

export function getProcessRole(): ProcessRole {
  if (cachedRole !== null) {
    return cachedRole;
  }
  const raw = (process.env.RUID_PROCESS_ROLE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'all') {
    cachedRole = 'all';
  } else if (VALID_ROLES.has(raw as ProcessRole)) {
    cachedRole = raw as ProcessRole;
  } else {
    LOGGER.warn(
      `Unknown RUID_PROCESS_ROLE "${raw}" — falling back to "all". ` +
        `Valid values: api, worker, all.`,
    );
    cachedRole = 'all';
  }
  return cachedRole;
}

/**
 * Should the current process run scheduled (`@Cron`) jobs?
 *
 * `worker` and `all` run cron; `api` skips it. The function is safe to
 * call from a cron handler — it simply reads the cached role.
 */
export function shouldRunSchedules(): boolean {
  const role = getProcessRole();
  return role === 'worker' || role === 'all';
}

/**
 * Should the current process expose HTTP routes? Currently every role
 * does (the worker process loads controllers but does not call
 * `app.listen()`), but the helper exists so future split-containers can
 * gate Nest's HTTP middleware without touching call sites.
 */
export function shouldExposeHttp(): boolean {
  const role = getProcessRole();
  return role === 'api' || role === 'all';
}

/**
 * Test-only — clears the cache so subsequent reads pick up a new env
 * variable. Production code never calls this.
 */
export function _resetProcessRoleCacheForTests(): void {
  cachedRole = null;
}
