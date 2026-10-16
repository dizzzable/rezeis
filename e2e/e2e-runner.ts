/**
 * End-to-end smoke runner for the rezeis-admin ↔ reiwa pair.
 *
 * The runner assumes the docker-compose.e2e.yml stack is up; it does NOT
 * manage container lifecycle (that's `run-e2e.mts`). It walks through a
 * sequence of "scenarios" — each scenario is a small named function that
 * either resolves (pass) or throws (fail). The script prints a coloured
 * summary at the end and exits with a non-zero status on any failure.
 *
 * Every scenario carries ONE tag (`ScenarioTag` below), and E2E_SCENARIOS
 * chooses what runs: `all` (the default) or `core`. A MIXED pair — a new
 * panel with the released cabinet, or the other way round — runs `core`.
 * With E2E_RESULTS_FILE set, the outcome of every scenario is written there
 * as JSON for the orchestrator and the CI job summary.
 *
 * Every scenario here speaks HTTP to the two APIs; none drives the admin SPA
 * in a browser. One that does must, after signing in, wait for an element of
 * the admin shell (the sidebar) before acting, not for the URL: from this
 * branch on the shell loads lazily after sign-in, behind a «Загрузка»
 * spinner. The same wait holds on a released 0.9.7.70 panel, which has no
 * lazy shell.
 *
 * Stages
 *   1. Bootstrap — sign in as the first DEV admin. run-e2e.mts registers it
 *      on the fresh database before the cabinet starts; against an empty
 *      panel this scenario registers it itself.
 *   2. Auth — login + token introspection.
 *   3. Phase 5 — 2FA enroll (verifies AES-GCM cipher + Base32).
 *   4. Phase 5 — Login Guard records attempts.
 *   5. Phase 5 — IP allowlist CRUD.
 *   6. Phase 6 — Webhook subscription + test delivery (BullMQ → HTTP).
 *   7. Phase 7 — Analytics overview / cohorts / top-payers.
 *   8. Phase 8 — Config export + dry-run import roundtrip.
 *   9. Phase 8 — System logs viewer + change log level.
 *  10. Phase 8 — Bulk users (no-op on empty user table; verifies validation).
 *  11. Phase 9 — Update checker.
 *  12. Reiwa side — health, branding, public-config proxy, bootstrap user.
 *  13. Relay — a branding save reaches the cabinet through the panel's signed
 *      webhook, and a webhook the panel did not sign is refused.
 *  14. Money — a subscriber signs in on the cabinet the way a browser does, a
 *      subscription on a monthly-reset plan, the traffic add-on «до сброса»
 *      offered and bought through the cabinet. What each pairing must show is
 *      read off the PAIR TABLE (`TABLE_RELEASES`, `PAIR_FEATURES`), never off a
 *      list of pairings.
 *  15. Pair — what each half knows about the other: the panel's record of its
 *      cabinet (`/api/admin/reiwa-peers`), its «до сброса» gate asked directly
 *      with a signed call, the cabinet's stored view of its panel, and a panel
 *      log with no internal call refused. These read the stack's containers
 *      (Redis, logs) through `docker compose`, with E2E_PROJECT and
 *      E2E_COMPOSE_FILE from run-e2e.mts.
 *
 * Add new scenarios as plain functions and append them to SCENARIOS. Forgetting
 * the second half is caught before the first request goes out — see
 * `assertEveryScenarioIsRegistered`.
 */

import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import axios, { AxiosInstance } from 'axios';

const REZEIS_BASE = process.env.REZEIS_BASE ?? 'http://localhost:18000';
const REIWA_BASE = process.env.REIWA_BASE ?? 'http://localhost:15000';

const BOOTSTRAP_LOGIN = 'e2eadmin';
const BOOTSTRAP_PASSWORD = 'e2eadmin-pass-9876';

interface ScenarioContext {
  readonly admin: AxiosInstance;
  readonly reiwa: AxiosInstance;
  bearerToken: string;
  apiToken: string | null;
  apiTokenId: string | null;
  webhookSubscriptionId: string | null;
  webhookSubscriptionSecret: string | null;
  ipAllowlistEntryId: string | null;
  /** Both halves' versions, read once before the first scenario; `pairProblem` says why when it is null. */
  pair: PairInfo | null;
  pairProblem: string | null;
  /** The money scenarios hand these on, in order. */
  subscriber: Subscriber | null;
  money: MoneyFixture | null;
  offer: OfferSeen | null;
  /** An API token of the runner's own, for its signed calls to the panel's internal API. Never printed. */
  directToken: string | null;
  /** Names this run's own marks in the panel's log (`provoke`); random per run. */
  readonly runId: string;
  /**
   * Internal calls this run made the panel refuse ON PURPOSE. The last
   * scenario requires every one of them in the panel's log, and accepts no
   * other refusal.
   */
  expectedRefusals: ProvokedRefusal[];
}

/** A refusal provoked on purpose, marked with its own request id (`provoke`). */
interface ProvokedRefusal {
  readonly status: number;
  readonly path: string;
  readonly requestId: string;
  readonly what: string;
}

/**
 * A scenario that cannot apply to this pairing — it is outside the pair table —
 * says so instead of failing. Never thrown for a pairing the table covers.
 */
class ScenarioSkip extends Error {}

/**
 * WHERE A SCENARIO RUNS.
 *
 *   core  Runs in EVERY pairing, same-version or mixed. A scenario is `core`
 *         when it crosses the halves (the cabinet reads through the panel, or
 *         the panel pushes to the cabinet), when the rest needs it (the admin
 *         signs in, the cabinet answers), or when it is a boundary that must
 *         hold whatever the other half is (a forged relay call is refused).
 *         An operator who updated only one half relies on exactly these.
 *   pair  Runs only when both halves are the same version (`all`). Every one
 *         of these today checks the panel ALONE: nothing in it depends on the
 *         cabinet, so a mixed run would only re-test the panel image that the
 *         same-version run of the same build tests in full. Tagging one `pair`
 *         does not claim it breaks across versions.
 *
 * A mixed-pair assertion — a new panel holding a feature back from an older
 * cabinet — is `core` by definition.
 */
type ScenarioTag = 'core' | 'pair';
type Selection = 'all' | 'core';

interface ScenarioResult {
  readonly name: string;
  readonly tag: ScenarioTag;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly durationMs: number;
  readonly error?: string;
  readonly note?: string;
}

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function fmt(ok: boolean, value: string): string {
  return `${ok ? colors.green : colors.red}${value}${colors.reset}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describeAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 'no-status';
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    // Which call: a 5xx or a timeout names no endpoint by itself, and a CI log
    // is read without the source open next to it.
    const request = err.config
      ? `${(err.config.method ?? 'get').toUpperCase()} ${err.config.baseURL ?? ''}${err.config.url ?? ''} → `
      : '';
    return `${request}[${status}] ${body}`;
  }
  return (err as Error).message ?? String(err);
}

/**
 * THE ONE ASSERTION EVERY REQUEST MAKES FIRST.
 *
 * Both clients below are created with `validateStatus: (s) => s < 500`, so a
 * 4xx RESOLVES: the promise does not reject, `res.data` holds the error
 * envelope rather than the payload, and nothing downstream knows. What each
 * scenario did with that varied, and all of it was wrong:
 *
 *   - `scenarioApiToken` read `created.data.id` off a refusal, got `undefined`,
 *     and returned "issued undefined" — a PASS against a 403.
 *   - `scenarioBootstrap` read `hasAdmins` off a refusal, got `undefined`, took
 *     the register branch, stored an `undefined` bearer and PASSED; the failure
 *     surfaced one scenario later as an unexplained 401 on /me.
 *   - most of the rest dereferenced a field that was not there, so the run
 *     reported "Cannot read properties of undefined (reading 'login')" for what
 *     was a plain 401.
 *
 * The status is therefore checked before the body is touched, everywhere, and
 * the message carries the status AND the body the server actually sent.
 */
function expectStatus(
  res: { readonly status: number; readonly data: unknown },
  expected: number | readonly number[],
  what: string,
): void {
  const allowed = typeof expected === 'number' ? [expected] : expected;
  if (allowed.includes(res.status)) return;
  throw new Error(
    `${what}: expected HTTP ${allowed.join(' or ')}, got ${res.status} — ${JSON.stringify(res.data)}`,
  );
}

// ── Scenarios ──────────────────────────────────────────────────────────────

async function scenarioBootstrap(ctx: ScenarioContext): Promise<string> {
  // Idempotent: if an admin already exists from a previous run on the
  // same volume, skip registration and just login.
  const status = await ctx.admin.get<{ hasAdmins: boolean }>('/admin/auth/status');
  expectStatus(status, 200, 'GET /admin/auth/status');
  if (!status.data.hasAdmins) {
    const reg = await ctx.admin.post<{ accessToken: string }>('/admin/auth/register', {
      username: BOOTSTRAP_LOGIN,
      password: BOOTSTRAP_PASSWORD,
    });
    // 200, not 201: the controller carries @HttpCode(HttpStatus.OK) because it
    // answers with a session, not with a created resource.
    expectStatus(reg, 200, 'POST /admin/auth/register');
    ctx.bearerToken = reg.data.accessToken;
    return 'registered';
  }
  const login = await ctx.admin.post<{ accessToken: string }>('/admin/auth/login', {
    username: BOOTSTRAP_LOGIN,
    password: BOOTSTRAP_PASSWORD,
  });
  expectStatus(login, 200, 'POST /admin/auth/login');
  ctx.bearerToken = login.data.accessToken;
  return 'reused existing admin';
}

async function scenarioAuthMe(ctx: ScenarioContext): Promise<string> {
  const me = await ctx.admin.get<{ admin: { login: string; role: string } }>(
    '/admin/auth/me',
    { headers: { Authorization: `Bearer ${ctx.bearerToken}` } },
  );
  expectStatus(me, 200, 'GET /admin/auth/me');
  assert(me.data.admin.login === BOOTSTRAP_LOGIN, `unexpected login: ${me.data.admin.login}`);
  assert(me.data.admin.role === 'DEV', `unexpected role: ${me.data.admin.role}`);
  return `${me.data.admin.login} (${me.data.admin.role})`;
}

async function scenarioApiToken(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  // The list is a bare array. This used to read `list.data.items`, which is
  // always undefined, so its "reuse the existing token" branch never ran and
  // the scenario issued a token every time while claiming idempotency. Every
  // run now starts from an empty database, and run-e2e.mts mints the token
  // the cabinet uses before the cabinet starts; what is left to check here is
  // the list itself and a fresh issue.
  const list = await ctx.admin.get<Array<Record<string, unknown>>>('/admin/api-tokens', {
    headers: auth,
  });
  expectStatus(list, 200, 'GET /admin/api-tokens');
  assert(Array.isArray(list.data), `GET /admin/api-tokens: expected an array, got ${JSON.stringify(list.data)}`);
  // The list is what an admin page renders; a token value in it is a leak.
  const leaking = list.data.filter((t) => 'token' in t);
  assert(leaking.length === 0, `GET /admin/api-tokens exposes ${leaking.length} token value(s)`);
  const created = await ctx.admin.post<{ id: string; token: string }>(
    '/admin/api-tokens',
    { name: 'reiwa-e2e' },
    { headers: auth },
  );
  expectStatus(created, 201, 'POST /admin/api-tokens');
  assert(typeof created.data.token === 'string' && created.data.token.length > 0, 'the issued token is empty');
  ctx.apiToken = created.data.token;
  ctx.apiTokenId = created.data.id;
  return `listed ${list.data.length} without values · issued ${created.data.id}`;
}

async function scenarioTwoFactorEnroll(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const status = await ctx.admin.get<{ enabled: boolean }>('/admin/2fa/status', {
    headers: auth,
  });
  expectStatus(status, 200, 'GET /admin/2fa/status');
  if (status.data.enabled) {
    return 'already enabled (skipped)';
  }
  // Minting a second factor is a privilege-raising act, so since the August
  // hardening it demands the one credential a hijacked session does not carry.
  // The refusal is a 401 that NAMES the factor rather than a validation error,
  // because that is what the SPA turns into a password prompt — assert both,
  // or a regression to "enroll on a stolen session" reads as green.
  const refused = await ctx.admin.post<{ factor?: string }>(
    '/admin/2fa/enroll',
    {},
    { headers: auth },
  );
  expectStatus(refused, 401, 'POST /admin/2fa/enroll without a password');
  assert(refused.data.factor !== undefined, 'the refusal must name the factor to ask for');

  const enroll = await ctx.admin.post<{
    secret: string;
    otpauthUri: string;
    recoveryCodes: string[];
  }>('/admin/2fa/enroll', { password: BOOTSTRAP_PASSWORD }, { headers: auth });
  expectStatus(enroll, 200, 'POST /admin/2fa/enroll with the password');
  assert(enroll.data.secret.length === 32, `unexpected secret length: ${enroll.data.secret.length}`);
  assert(enroll.data.recoveryCodes.length === 10, 'expected 10 recovery codes');
  assert(enroll.data.otpauthUri.startsWith('otpauth://totp/'), 'malformed otpauth URI');
  return `password demanded · secret=${enroll.data.secret.length}ch · ${enroll.data.recoveryCodes.length} recovery codes`;
}

async function scenarioLoginGuard(ctx: ScenarioContext): Promise<string> {
  // Trigger 3 invalid logins; the guard records each attempt.
  //
  // These used to sit in a `try { } catch { /* expected 401 */ }`, which under
  // `validateStatus: (s) => s < 500` never runs: a 401 resolves. So the loop
  // accepted ANY answer under 500 — a 200 to `nobody`/`wrong-password-xxx`
  // included, which is the single worst regression this file could witness.
  //
  // BUDGET: `POST /admin/auth/login` carries @Throttle({ ttl: 60s, limit: 5 }).
  // This scenario spends four of the five (three refusals plus the login
  // below), and `scenarioBootstrap` spends one more when it reuses an existing
  // admin. A 429 here means the budget was exceeded, and the assertion below
  // now says so by name instead of swallowing it.
  for (let i = 0; i < 3; i++) {
    const refused = await ctx.admin.post('/admin/auth/login', {
      username: 'nobody',
      password: 'wrong-password-xxx',
    });
    expectStatus(refused, 401, `POST /admin/auth/login with bad credentials (attempt ${i + 1})`);
  }
  // The records aren't surfaced via REST yet, so we just confirm the
  // endpoint stays responsive (no 500s) and the original admin can
  // still log in afterwards.
  const ok = await ctx.admin.post<{ accessToken: string }>('/admin/auth/login', {
    username: BOOTSTRAP_LOGIN,
    password: BOOTSTRAP_PASSWORD,
  });
  expectStatus(ok, 200, 'POST /admin/auth/login after three refusals');
  assert(ok.data.accessToken.length > 50, 'login still works');
  return '3 failed attempts recorded; admin can still log in';
}

async function scenarioIpAllowlist(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const list = await ctx.admin.get<{ items: Array<{ id: string; address: string }> }>(
    '/admin/ip-allowlist',
    { headers: auth },
  );
  expectStatus(list, 200, 'GET /admin/ip-allowlist');
  assert(Array.isArray(list.data.items), 'GET /admin/ip-allowlist: `items` is not an array');
  // Idempotent: drop any leftover entries first so the list stays empty
  // and the allowlist itself doesn't accidentally lock out the runner.
  for (const entry of list.data.items) {
    const gone = await ctx.admin.delete(`/admin/ip-allowlist/${entry.id}`, { headers: auth });
    expectStatus(gone, 204, `DELETE /admin/ip-allowlist/${entry.id} (leftover)`);
  }
  // Add a never-matching CIDR with `isActive: false` so we don't lock
  // ourselves out, then read it back, then delete.
  const created = await ctx.admin.post<{ id: string; address: string }>(
    '/admin/ip-allowlist',
    { address: '203.0.113.0/24', label: 'e2e-test', isActive: false },
    { headers: auth },
  );
  expectStatus(created, 201, 'POST /admin/ip-allowlist');
  ctx.ipAllowlistEntryId = created.data.id;
  const after = await ctx.admin.get<{ total: number }>('/admin/ip-allowlist', {
    headers: auth,
  });
  expectStatus(after, 200, 'GET /admin/ip-allowlist (after create)');
  assert(after.data.total === 1, `expected 1 entry, got ${after.data.total}`);
  const removed = await ctx.admin.delete(`/admin/ip-allowlist/${created.data.id}`, {
    headers: auth,
  });
  // A refused DELETE left the entry behind and the scenario still returned its
  // happy string, so the next run started with a dirty allowlist.
  expectStatus(removed, 204, `DELETE /admin/ip-allowlist/${created.data.id}`);
  return 'add → list → delete roundtrip';
}

async function scenarioWebhookSubscriptionRoundtrip(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  // Reuse existing test subscription on retry runs.
  const existing = await ctx.admin.get<{ items: Array<{ id: string; name: string }> }>(
    '/admin/webhooks/subscriptions',
    { headers: auth },
  );
  expectStatus(existing, 200, 'GET /admin/webhooks/subscriptions');
  assert(
    Array.isArray(existing.data.items),
    'GET /admin/webhooks/subscriptions: `items` is not an array',
  );
  for (const sub of existing.data.items) {
    if (sub.name === 'e2e-test') {
      const gone = await ctx.admin.delete(`/admin/webhooks/subscriptions/${sub.id}`, {
        headers: auth,
      });
      expectStatus(gone, 204, `DELETE /admin/webhooks/subscriptions/${sub.id} (leftover)`);
    }
  }
  const created = await ctx.admin.post<{
    id: string;
    secret: string | null;
    eventTypes: string[];
  }>(
    '/admin/webhooks/subscriptions',
    {
      name: 'e2e-test',
      url: 'https://httpbin.org/status/200',
      eventTypes: ['*'],
      isActive: true,
    },
    { headers: auth },
  );
  expectStatus(created, 201, 'POST /admin/webhooks/subscriptions');
  ctx.webhookSubscriptionId = created.data.id;
  ctx.webhookSubscriptionSecret = created.data.secret;
  assert(created.data.secret && created.data.secret.length === 64, 'secret must be 64-char hex');

  // Trigger a test delivery and poll until the BullMQ worker finishes.
  const test = await ctx.admin.post<{ deliveryId: string }>(
    `/admin/webhooks/subscriptions/${created.data.id}/test`,
    {},
    { headers: auth },
  );
  // 202: the controller hands the delivery to BullMQ and answers before it
  // runs. Unasserted, a refusal here left `deliveryId` undefined, the poll
  // below never matched a row, and the run spent thirty seconds arriving at
  // "expected SUCCEEDED, got status=PENDING" — a queue diagnosis for an auth
  // failure.
  expectStatus(test, 202, `POST /admin/webhooks/subscriptions/${created.data.id}/test`);
  let status = 'PENDING';
  let httpStatus: number | null = null;
  let attempt = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const list = await ctx.admin.get<{
      items: Array<{ id: string; status: string; httpStatus: number | null; attempt: number }>;
    }>(`/admin/webhooks/deliveries?subscriptionId=${created.data.id}`, { headers: auth });
    expectStatus(list, 200, 'GET /admin/webhooks/deliveries');
    const row = list.data.items.find((d) => d.id === test.data.deliveryId);
    if (row) {
      status = row.status;
      httpStatus = row.httpStatus;
      attempt = row.attempt;
      if (status === 'SUCCEEDED' || status === 'FAILED') break;
    }
  }
  assert(
    status === 'SUCCEEDED',
    `expected SUCCEEDED, got status=${status} http=${httpStatus} attempts=${attempt}`,
  );
  return `delivered (status=${status}, http=${httpStatus}, attempt=${attempt})`;
}

async function scenarioAnalytics(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const overview = await ctx.admin.get<{
    kpis: { windowDays: number; totalRevenue: number; totalUsers: number };
    daily: unknown[];
    funnel: unknown[];
  }>('/admin/analytics/overview?days=30', { headers: auth });
  expectStatus(overview, 200, 'GET /admin/analytics/overview');
  assert(overview.data.kpis.windowDays === 30, 'window mismatch');
  assert(Array.isArray(overview.data.daily), 'daily must be an array');
  assert(Array.isArray(overview.data.funnel), 'funnel must be an array');
  const cohorts = await ctx.admin.get<{ cohorts: unknown[] }>(
    '/admin/analytics/cohorts',
    { headers: auth },
  );
  expectStatus(cohorts, 200, 'GET /admin/analytics/cohorts');
  const top = await ctx.admin.get<{ payers: unknown[] }>(
    '/admin/analytics/top-payers?limit=5',
    { headers: auth },
  );
  expectStatus(top, 200, 'GET /admin/analytics/top-payers');
  // Since 0.9.7.61 the bins follow the data: about eight round-width bins up
  // to the 95th percentile plus an open tail — and none at all without a
  // single payer, which is what a fresh stack has. Eight fixed buckets were the
  // old contract.
  const ltv = await ctx.admin.get<{
    buckets: Array<{ from: number; to: number | null; users: number }>;
    stats: { payers: number };
  }>('/admin/analytics/ltv-distribution', { headers: auth });
  expectStatus(ltv, 200, 'GET /admin/analytics/ltv-distribution');
  const { buckets, stats } = ltv.data;
  assert(Array.isArray(buckets), 'LTV buckets must be an array');
  assert(typeof stats?.payers === 'number', 'LTV stats.payers must be a number');
  assert(
    (stats.payers === 0) === (buckets.length === 0),
    `LTV: ${buckets.length} bucket(s) for ${stats.payers} payer(s) — none exactly when nobody paid`,
  );
  assert(buckets.length <= 13, `LTV: ${buckets.length} buckets, at most 12 bins and a tail`);
  buckets.forEach((bucket, index) => {
    const next = buckets[index + 1];
    if (next !== undefined) assert(bucket.to === next.from, `LTV bucket ${index} does not meet the next one`);
  });
  return `overview ${overview.data.kpis.windowDays}d · cohorts=${cohorts.data.cohorts.length} · top=${top.data.payers.length} · ltv=${buckets.length} (payers ${stats.payers})`;
}

async function scenarioConfigPortability(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const sections = await ctx.admin.get<{ sections: string[] }>(
    '/admin/config/sections',
    { headers: auth },
  );
  expectStatus(sections, 200, 'GET /admin/config/sections');
  assert(sections.data.sections.length >= 9, 'expected >= 9 sections');
  // Export ONLY the small ones to keep the test snappy.
  const targeted = ['roles', 'webhooks', 'adminIpAllowlist'];
  const params = new URLSearchParams();
  for (const s of targeted) params.append('sections', s);
  const exp = await ctx.admin.get<{
    version: number;
    sections: Record<string, Array<Record<string, unknown>>>;
  }>(`/admin/config/export?${params.toString()}`, { headers: auth });
  expectStatus(exp, 200, 'GET /admin/config/export');
  assert(exp.data.version >= 1, 'version must be >= 1');

  // Dry-run import — must not mutate. Roles go in their own request below:
  // a payload carrying a SYSTEM role is refused by design since the August
  // hardening, and one refused section would otherwise hide the rest.
  const importable = ['webhooks', 'adminIpAllowlist'];
  const imp = await ctx.admin.post<{
    summaries: Array<{ section: string; created: number; updated: number; skipped: number }>;
    dryRun: boolean;
  }>(
    '/admin/config/import',
    { payload: exp.data, sections: importable, strategy: 'overwrite', dryRun: true },
    { headers: auth },
  );
  expectStatus(imp, 200, 'POST /admin/config/import');
  assert(imp.data.dryRun === true, 'dryRun flag must roundtrip');

  // The roles of a freshly bootstrapped panel are nothing but system roles,
  // and a system role is defined by the code that ships it, never by a file.
  // Either outcome is asserted, so this reads the same on a panel that has
  // custom roles too — what may never happen is a silent acceptance, and what
  // may never happen either is a THIRD status slipping through: 401, 403 and
  // 404 all used to land in the `else` branch and be reported as an
  // "unexpected roles import result", which is true but says nothing.
  const roleNames = (exp.data.sections['roles'] ?? []).map((row) => String(row['name'] ?? ''));
  const roles = await ctx.admin.post<{ message?: string; dryRun?: boolean }>(
    '/admin/config/import',
    { payload: exp.data, sections: ['roles'], strategy: 'overwrite', dryRun: true },
    { headers: auth },
  );
  expectStatus(roles, [200, 400], 'POST /admin/config/import (roles)');
  let rolesVerdict: string;
  if (roles.status === 400) {
    assert(
      String(roles.data.message ?? '').includes('reserved for a system role'),
      `roles were refused for the wrong reason: ${JSON.stringify(roles.data)}`,
    );
    rolesVerdict = `${roleNames.length} role(s) exported, refused as system roles`;
  } else {
    assert(
      roles.data.dryRun === true,
      `roles import answered 200 without dryRun: ${JSON.stringify(roles.data)}`,
    );
    rolesVerdict = `${roleNames.length} role(s) exported, none reserved`;
  }
  return `${importable.length} sections roundtrip (${imp.data.summaries.length} summaries) · ${rolesVerdict}`;
}

async function scenarioSystemLogs(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const before = await ctx.admin.get<{ entries: unknown[]; latestId: number }>(
    '/admin/system-logs?limit=10',
    { headers: auth },
  );
  expectStatus(before, 200, 'GET /admin/system-logs');
  const setLevel = await ctx.admin.patch<{ level: string }>(
    '/admin/system-logs/level',
    { level: 'debug' },
    { headers: auth },
  );
  expectStatus(setLevel, 200, 'PATCH /admin/system-logs/level (debug)');
  assert(setLevel.data.level === 'debug', 'level change failed');
  // Reset to log. Unasserted, a refusal here left the panel at `debug` for
  // every later scenario and for whatever a -KeepAlive run does next.
  const reset = await ctx.admin.patch('/admin/system-logs/level', { level: 'log' }, {
    headers: auth,
  });
  expectStatus(reset, 200, 'PATCH /admin/system-logs/level (log)');
  return `${before.data.entries.length} entries, latestId=${before.data.latestId}`;
}

async function scenarioBulkUsers(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  // No real users in DB — pass in fake IDs and verify the endpoint reports
  // them as `skipped: User not found`.
  const result = await ctx.admin.post<{
    total: number;
    succeeded: number;
    skipped: number;
    items: Array<{ status: string; message?: string }>;
  }>(
    '/admin/users/bulk',
    {
      userIds: ['fakecuid000000000000000001', 'fakecuid000000000000000002'],
      action: 'block',
    },
    { headers: auth },
  );
  expectStatus(result, 200, 'POST /admin/users/bulk');
  assert(result.data.total === 2, `expected total=2, got ${result.data.total}`);
  assert(result.data.succeeded === 0, 'no users in DB');
  assert(result.data.skipped === 2, 'both rows should be skipped');
  return `2 ids · 0 succeeded · 2 skipped`;
}

async function scenarioUpdateChecker(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const status = await ctx.admin.get<{ current: string; source: string; hasUpdate: boolean }>(
    '/admin/update-checker/status',
    { headers: auth },
  );
  expectStatus(status, 200, 'GET /admin/update-checker/status');
  assert(typeof status.data.current === 'string', 'current must be string');
  // Without REZEIS_UPDATE_REPO the source is `unknown` — that's correct.
  return `current=${status.data.current}, source=${status.data.source}, hasUpdate=${status.data.hasUpdate}`;
}

async function scenarioReiwaHealth(ctx: ScenarioContext): Promise<string> {
  const health = await ctx.reiwa.get<{ status: string; service: string }>(
    '/api/v1/health',
  );
  expectStatus(health, 200, 'GET reiwa /api/v1/health');
  assert(health.data.status === 'ok', 'reiwa health not ok');
  assert(health.data.service === 'reiwa-api', 'unexpected service id');
  return `${health.data.service} · ${health.data.status}`;
}

async function scenarioReiwaProxiesBranding(ctx: ScenarioContext): Promise<string> {
  // reiwa proxies branding from rezeis-admin. If the admin is reachable
  // and the api_token works, this returns a 200 with brandName etc.
  const branding = await ctx.reiwa.get<{
    branding: { brandName: string };
    locales: string[];
    defaultLocale: string;
  }>('/api/v1/public-config');
  // A bad api_token answers 401 here, and reading `.branding.brandName` off
  // that envelope reported a missing property rather than a rejected token.
  expectStatus(branding, 200, 'GET reiwa /api/v1/public-config');
  assert(typeof branding.data.branding.brandName === 'string', 'brandName missing');
  assert(branding.data.locales.length > 0, 'locales must not be empty');
  return `brand=${branding.data.branding.brandName} · locales=[${branding.data.locales.join(',')}] · default=${branding.data.defaultLocale}`;
}

async function scenarioReiwaPlansProxy(ctx: ScenarioContext): Promise<string> {
  // The plans endpoint goes admin → rezeis-admin → DB. On a fresh DB
  // we expect an empty list, not a 500. This is the smoke for the
  // admin client + Bearer auth flow.
  //
  // `validateStatus: () => true` is wider than the client default on purpose:
  // a 5xx here is the interesting answer and is worth a named status in the
  // message rather than an axios rejection.
  const plans = await ctx.reiwa.get<{ plans?: unknown[] } | unknown[]>(
    '/api/v1/plans',
    { validateStatus: () => true },
  );
  // The reiwa plans route may shape the body differently; we accept
  // either an array or `{ plans: [] }`. As long as the status is 200,
  // the entire round-trip (Bearer → admin → DB) is healthy.
  expectStatus(plans, 200, 'GET reiwa /api/v1/plans');
  const body = plans.data as { plans?: unknown[] } | unknown[];
  const count = Array.isArray(body) ? body.length : (body.plans?.length ?? -1);
  return `200 OK · plans=${count}`;
}

// ── Panel → cabinet relay ──────────────────────────────────────────────────

/**
 * How long reiwa serves public-config from memory before asking the panel
 * again: `CACHE_TTL_MS` in reiwa's `src/api/routes/branding.ts`. Restated here
 * only to size the deadline below and to print next to the measured times.
 */
const CABINET_PUBLIC_CONFIG_TTL_MS = 60_000;

/**
 * How long a saved brand name may take to show in the cabinet. Far below the
 * cache TTL on purpose: arriving by expiry is exactly what must not pass.
 */
const RELAY_DEADLINE_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cabinetBrandName(ctx: ScenarioContext): Promise<string> {
  const res = await ctx.reiwa.get<{ branding: { brandName: string } }>('/api/v1/public-config');
  expectStatus(res, 200, 'GET reiwa /api/v1/public-config');
  return res.data.branding.brandName;
}

/** Saves `name` on the panel and returns how long the cabinet took to show it. */
async function saveBrandNameAndWaitForCabinet(
  ctx: ScenarioContext,
  auth: Record<string, string>,
  name: string,
): Promise<number> {
  const started = Date.now();
  const saved = await ctx.admin.patch<{ brandName: string }>(
    '/admin/settings/branding',
    { brandName: name },
    { headers: auth },
  );
  expectStatus(saved, 200, `PATCH /admin/settings/branding (brandName "${name}")`);
  assert(saved.data.brandName === name, `the panel stored "${saved.data.brandName}", not "${name}"`);

  let shown = '';
  while (Date.now() - started < RELAY_DEADLINE_MS) {
    shown = await cabinetBrandName(ctx);
    if (shown === name) return Date.now() - started;
    await sleep(250);
  }
  throw new Error(
    `the cabinet still shows "${shown}" ${RELAY_DEADLINE_MS} ms after the panel saved "${name}": ` +
      'the relay did not arrive. Check that WEBHOOK_SECRET_HEADER on BOTH panel containers equals ' +
      "reiwa's REZEIS_WEBHOOK_SECRET, and look for `reiwa relay` in the admin and worker logs " +
      'and for "rezeis webhook: rejected" in reiwa\'s.',
  );
}

/**
 * THE RELAY CARRIES AN OPERATOR'S SAVE TO THE CABINET.
 *
 * Everything the cabinet caches from the panel — theme, access mode, the
 * connect screen — and every notification and broadcast reaches it over
 * one hop: the panel queues the event (`reiwa-relay`), a processor POSTs it to
 * `<REIWA_URL>/api/v1/webhooks/rezeis` signed with WEBHOOK_SECRET_HEADER, and
 * reiwa checks that signature against REZEIS_WEBHOOK_SECRET before acting.
 * Each half has unit tests; nothing checked that the halves agree. When they
 * do not, nothing errors where anyone looks: the save succeeds, the relay job
 * fails in a queue, and the cabinet shows the change a minute later, by cache
 * expiry. This stack did not even set the secret until this scenario existed.
 *
 * Observed through the brand name reiwa serves from its 60 s public-config
 * cache: a save must show up well inside that minute.
 *
 * WHY THE NAME IS CHANGED TWICE. The first change can arrive by plain expiry:
 * scenario 14 filled that cache, and it may be nearly a minute old by now. The
 * second change cannot. The payload that showed the first change was fetched
 * from the panel AFTER the first save, so without the relay the cabinet keeps
 * serving it until at least a minute after that save — while the second change
 * has to appear within `RELAY_DEADLINE_MS` of a save made no more than
 * `RELAY_DEADLINE_MS` after the first. The second change is therefore the
 * proof, and it also puts the operator's name back.
 */
async function scenarioRelayCarriesBrandingToCabinet(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const current = await ctx.admin.get<{ brandName: string }>('/admin/settings/branding', {
    headers: auth,
  });
  expectStatus(current, 200, 'GET /admin/settings/branding');
  const original = current.data.brandName;
  // Something for the first save to replace: the cabinet has a cached copy.
  await cabinetBrandName(ctx);

  const marker = `e2e relay ${Date.now().toString(36)}`;
  assert(marker !== original, 'the marker name must differ from the saved one');
  let restored = false;
  try {
    const away = await saveBrandNameAndWaitForCabinet(ctx, auth, marker);
    const back = await saveBrandNameAndWaitForCabinet(ctx, auth, original);
    restored = true;
    return `save → cabinet: ${away} ms, ${back} ms (cache TTL ${CABINET_PUBLIC_CONFIG_TTL_MS} ms)`;
  } finally {
    if (!restored) {
      // Leave the panel's name as it was even when the relay is broken; the
      // cabinet then catches up by expiry, which is the failure being reported.
      await ctx.admin
        .patch('/admin/settings/branding', { brandName: original }, { headers: auth })
        .catch(() => undefined);
    }
  }
}

/**
 * A WEBHOOK THE PANEL DID NOT SIGN CHANGES NOTHING.
 *
 * `POST /api/v1/webhooks/rezeis` is on reiwa's PUBLIC domain by design (the
 * panel may run on another host), and what it accepts drops caches and makes
 * the bot message subscribers. Its signature check is therefore the whole
 * boundary. Both refusals are the same 401, so this cannot tell "wrong secret"
 * from "no secret configured" — scenario 17 is what proves the right one is.
 * What this pins is the regression neither unit suite would put in front of a
 * running process: a receiver that answers 2xx to anyone.
 */
async function scenarioRelayRefusesForgedEvents(ctx: ScenarioContext): Promise<string> {
  const body = JSON.stringify({
    event: 'reiwa.branding.invalidate',
    metadata: { reason: 'e2e-forged' },
  });
  const json = { 'Content-Type': 'application/json' };

  const unsigned = await ctx.reiwa.post('/api/v1/webhooks/rezeis', body, { headers: json });
  expectStatus(unsigned, 401, 'POST reiwa /api/v1/webhooks/rezeis with no signature');

  // Well-formed and fresh, keyed by a secret nobody configured: this reaches the
  // HMAC comparison itself instead of failing in the header parser.
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', randomBytes(32).toString('hex')).update(`${t}.${body}`).digest('hex');
  const forged = await ctx.reiwa.post('/api/v1/webhooks/rezeis', body, {
    headers: { ...json, 'X-Rezeis-Signature': `t=${t},v1=${v1}` },
  });
  expectStatus(forged, 401, 'POST reiwa /api/v1/webhooks/rezeis signed with the wrong secret');
  return 'unsigned → 401 · wrong secret → 401';
}

// ── The pair table ─────────────────────────────────────────────────────────

type Half = 'panel' | 'cabinet';

/**
 * WHAT EACH RELEASE OF EACH HALF CAN DO. What a pairing must show is read off
 * this table and nothing else, so a pairing nobody wrote down — a dispatch with
 * any two images — is checked as carefully as the ones the workflows run.
 *
 * A half's version is what its health endpoint reports. It counts as `next`,
 * newer than every release listed, when it is not a release build (a working
 * tree reports `dev`; an image built from `main` reports the LAST release's
 * number, which is why run-e2e.mts passes the build kind it read off the
 * image label in E2E_PANEL_BUILD / E2E_CABINET_BUILD), or when its release is
 * newer than the newest listed. A release OLDER than the oldest listed is
 * outside the table: the scenarios that read the table skip with that reason
 * rather than guess.
 *
 * WHEN A RELEASE IS CUT: append it to its half below, and turn every `next`
 * that release delivered into its number.
 */
const TABLE_RELEASES: Readonly<Record<Half, readonly string[]>> = {
  panel: ['0.9.7.70', '0.9.7.71', '0.9.7.72', '0.9.7.73', '0.9.7.74', '0.9.7.75'],
  cabinet: ['0.9.7.52', '0.9.7.53', '0.9.7.54', '0.9.7.55', '0.9.7.56', '0.9.7.57'],
};

/**
 * The capability ids Reiwa 0.9.7.56 declares and Rezeis Admin 0.9.7.74 is the
 * first to know (`panel.knows-autopay-ids`, `cabinet.declares-autopay-ids`).
 */
const AUTOPAY_CAPABILITY_IDS = ['web.autopay-first-charge-delay', 'web.aurapay-autopay'] as const;

/**
 * The capability id Reiwa 0.9.7.57 declares and Rezeis Admin 0.9.7.75 is the
 * first to know (`panel.knows-connect-walk-id`, `cabinet.declares-connect-walk-id`).
 */
const CONNECT_WALK_CAPABILITY_IDS = ['web.connect-interactive'] as const;

/** Each feature: the half that has it and the first release that did. */
const PAIR_FEATURES = {
  /** «Доп. услуги» → «Настройки»: the stage switches answer at PATCH /admin/add-on-settings. */
  'panel.add-on-switches': { half: 'panel', since: '0.9.7.70' },
  /**
   * Traffic on a resetting plan is sold «до сброса» by default, and the offer
   * says until when: endsBound / nextResetAt / resetSoon.
   */
  'panel.sells-until-reset': { half: 'panel', since: '0.9.7.70' },
  /** The offer's `dated` survives the cabinet's schema and reaches the customer. */
  'cabinet.dated': { half: 'cabinet', since: '0.9.7.52' },
  /**
   * endsBound / nextResetAt / resetSoon survive the cabinet's schema: it can
   * say «до сброса трафика …» and warn when the reset is less than a day away.
   * An older cabinet strips them — the «Действует до …» of the 0.9.7.70 order
   * box. Its capability id is `web.addon-reset-end`.
   */
  'cabinet.reset-end': { half: 'cabinet', since: '0.9.7.53' },
  /**
   * The panel keeps a record of the cabinet processes that call it
   * (`GET /api/admin/reiwa-peers`) and judges the «до сброса» sale by what the
   * CALLER can show: a caller that declares `web.addon-reset-end` gets it, a
   * silent one only on live evidence of a 0.9.7.53 cabinet (its version poll or
   * heartbeat), and without evidence nothing — the floor.
   */
  'panel.knows-cabinet': { half: 'panel', since: '0.9.7.71' },
  /**
   * The cabinet declares itself on every internal call (`x-reiwa-client`,
   * `x-reiwa-capabilities`) and keeps what the panel says about itself at
   * `reiwa:panel-capabilities:v1` in its Redis.
   */
  'cabinet.declares': { half: 'cabinet', since: '0.9.7.54' },
  /**
   * The cabinet polls `/api/internal/config-versions` (first 5 s after boot,
   * then every 20 s). A silent cabinet's poll is what tells a newer panel it is
   * a 0.9.7.53 one. Every cabinet in the table also sends its version
   * heartbeat at boot, then hourly.
   */
  'cabinet.polls-versions': { half: 'cabinet', since: '0.9.7.53' },
  /**
   * The cabinet keeps the panel's last good answer of each settings group in
   * its own Redis (`reiwa:lkg:<group>:v<shape>`) and serves it while the panel
   * is down. For the landing that copy had no TTL.
   */
  'cabinet.saved-copies': { half: 'cabinet', since: '0.9.7.53' },
  /**
   * The web landing is gone from the panel (D2): the builder and its admin API
   * (`/api/admin/landing-config*` → 404) are deleted, and the one route a
   * cabinet reads, `GET /api/internal/landing-config/effective`, stays as a
   * shim that always answers `{"enabled":false}` — whatever the tables hold —
   * with the `landing` settings-version group computed from that constant.
   */
  'panel.landing-retired': { half: 'panel', since: '0.9.7.71' },
  /**
   * The cabinet shows no landing (D2): no `/api/v1/landing` (404), no landing
   * head on `/` and `/welcome`, no landing version group, no read of its saved
   * landing copy; a `reiwa.landing.invalidate` hint is acked with 204. In the
   * landing's place every document it serves is named after the operator:
   * `<title>`, `og:title` and `og:site_name` (`document-title.ts`).
   */
  'cabinet.landing-retired': { half: 'cabinet', since: '0.9.7.54' },
  /**
   * The panel's capability registry knows {@link AUTOPAY_CAPABILITY_IDS}
   * (Antilopay's delayed first charge, AuraPay's subscription). An older panel
   * counts a cabinet's declaration of them as ids it does not know
   * (`unknownToPanel`) and ignores them — what an operator who updates the
   * cabinet first runs until the panel follows.
   */
  'panel.knows-autopay-ids': { half: 'panel', since: '0.9.7.74' },
  /** The cabinet declares {@link AUTOPAY_CAPABILITY_IDS} on every internal call. */
  'cabinet.declares-autopay-ids': { half: 'cabinet', since: '0.9.7.56' },
  /**
   * The panel's capability registry knows {@link CONNECT_WALK_CAPABILITY_IDS}
   * (the guided «Интерактивный» connect walk); an older panel counts it as
   * unknown, the same way as the autopay ids above.
   */
  'panel.knows-connect-walk-id': { half: 'panel', since: '0.9.7.75' },
  /** The cabinet declares {@link CONNECT_WALK_CAPABILITY_IDS} on every internal call. */
  'cabinet.declares-connect-walk-id': { half: 'cabinet', since: '0.9.7.57' },
} as const satisfies Record<string, { readonly half: Half; readonly since: string }>;

type PairFeature = keyof typeof PAIR_FEATURES;

interface HalfVersion {
  /** What the health endpoint said. */
  readonly reported: string;
  readonly build: 'release' | 'next';
  /** A release from TABLE_RELEASES, or `next`. */
  readonly effective: string;
  /**
   * `next` features PROBED absent. Only ever set for the OTHER half's unreleased
   * `:main` (E2E_PROBE), which may predate the pair change the suite knows.
   */
  readonly lacks: readonly PairFeature[];
}

interface PairInfo {
  readonly panel: HalfVersion;
  readonly cabinet: HalfVersion;
  /** Set when a half is older than the table: the reason the table cannot speak. */
  readonly outside: string | null;
  /** What the job summary must say about how the pair was read (unlisted release, probed :main). */
  readonly notes: readonly string[];
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function resolveHalf(
  half: Half,
  reported: string,
  buildHint: string | undefined,
): HalfVersion & { outside?: string; note?: string } {
  const version = reported.trim().replace(/^v/i, '');
  const numeric = /^\d+(\.\d+)+$/.test(version);
  const build: 'release' | 'next' =
    buildHint === 'release' || buildHint === 'next' ? buildHint : numeric ? 'release' : 'next';
  if (build === 'next' || !numeric) return { reported, build: 'next', effective: 'next', lacks: [] };
  const releases = TABLE_RELEASES[half];
  if (compareVersions(version, releases[releases.length - 1]!) > 0) {
    // Right while `next` holds nothing this release lacks — and wrong the day a
    // later `next` feature arrives, hence the note (R1-10b).
    return {
      reported,
      build,
      effective: 'next',
      lacks: [],
      note: `${half} ${version} is a release the pair table does not list; it is counted as next (every feature) — add it to TABLE_RELEASES`,
    };
  }
  // A release between two listed ones (a hotfix nobody added) has what the
  // listed release below it has.
  const known = [...releases].reverse().find((release) => compareVersions(release, version) <= 0);
  if (known === undefined) {
    return {
      reported,
      build,
      effective: version,
      lacks: [],
      outside: `${half} ${version} is older than the oldest ${half} in the pair table (${releases[0]})`,
    };
  }
  if (known !== version) {
    return {
      reported,
      build,
      effective: known,
      lacks: [],
      note: `${half} ${version} is not in the pair table; it is counted as ${known}, the listed release below it`,
    };
  }
  return { reported, build, effective: known, lacks: [] };
}

function pairHas(pair: PairInfo, feature: PairFeature): boolean {
  const half: Half = PAIR_FEATURES[feature].half;
  if (pair[half].lacks.includes(feature)) return false;
  // Widened: a feature may be `next` only, which no entry is at this moment.
  const since: string = PAIR_FEATURES[feature].since;
  const effective = pair[half].effective;
  if (effective === 'next') return true;
  if (since === 'next') return false;
  return compareVersions(effective, since) >= 0;
}

/**
 * HOW TO TELL WHETHER AN UNRELEASED `:main` HAS A `next` FEATURE (R1-03).
 *
 * The next pair of each workflow runs the image just built against the OTHER
 * half's `:main`. When a pair change lands in both repositories, whichever E2E
 * runs first meets the other `:main` from before that change: counted as
 * `next` it would be expected to do things it cannot, and every such push
 * would go red. So the other half's `:main` — never the image being built — is
 * asked. Every `next`-only feature must have a probe here; the startup check
 * holds it to that.
 */
const NEXT_PROBES: Readonly<Partial<Record<PairFeature, (ctx: ScenarioContext) => Promise<{ has: boolean; how: string }>>>> = {
  // The route exists on a panel that keeps peer records: unauthenticated, it
  // answers 401; a panel without it answers 404.
  'panel.knows-cabinet': async (ctx) => {
    const answer = await ctx.admin.get('/admin/reiwa-peers');
    return { has: answer.status !== 404, how: `GET /api/admin/reiwa-peers → ${answer.status}` };
  },
  // A declaring cabinet carries the header name in its build (reiwa
  // `src/core/capabilities.ts`, the one file allowed to spell it).
  'cabinet.declares': async () => {
    const found = composeRun([
      'exec',
      '-T',
      'reiwa-e2e-api',
      'sh',
      '-c',
      'grep -rqs x-reiwa-client /app/dist && echo yes || echo no',
    ]);
    if (found.code !== 0) throw new Error(`could not look into the cabinet image: ${found.stderr.trim()}`);
    return { has: found.stdout.trim() === 'yes', how: `x-reiwa-client ${found.stdout.trim() === 'yes' ? 'in' : 'not in'} its dist/` };
  },
  // The builder's admin API: a panel that still has it answers 401 to an
  // unauthenticated read; one that retired the landing has no route (404).
  'panel.landing-retired': async (ctx) => {
    const answer = await ctx.admin.get('/admin/landing-config');
    return { has: answer.status === 404, how: `GET /api/admin/landing-config → ${answer.status}` };
  },
  // The cabinet's public landing route: 200 on a cabinet that still has it.
  'cabinet.landing-retired': async (ctx) => {
    const answer = await ctx.reiwa.get('/api/v1/landing');
    return { has: answer.status === 404, how: `GET reiwa /api/v1/landing → ${answer.status}` };
  },
};

/** Reads both halves' versions off their health endpoints, and probes the other half's `:main`. */
async function resolvePair(ctx: ScenarioContext): Promise<PairInfo> {
  const panel = await ctx.admin.get<{ version?: unknown }>('/health');
  expectStatus(panel, 200, 'GET /health');
  const cabinet = await ctx.reiwa.get<{ version?: unknown }>('/api/v1/health');
  expectStatus(cabinet, 200, 'GET reiwa /api/v1/health');
  let panelHalf = resolveHalf('panel', String(panel.data.version ?? ''), process.env.E2E_PANEL_BUILD);
  let cabinetHalf = resolveHalf('cabinet', String(cabinet.data.version ?? ''), process.env.E2E_CABINET_BUILD);
  const notes = [panelHalf.note, cabinetHalf.note].filter((note): note is string => note !== undefined);

  // E2E_PROBE names the OTHER half of a workflow's next pair: probed only when
  // it is an unreleased build, which the table would credit with every `next`.
  const probed = process.env.E2E_PROBE;
  if ((probed === 'panel' || probed === 'cabinet') && (probed === 'panel' ? panelHalf : cabinetHalf).effective === 'next') {
    const lacks: PairFeature[] = [];
    const found: string[] = [];
    for (const feature of Object.keys(PAIR_FEATURES) as PairFeature[]) {
      const row: { readonly half: Half; readonly since: string } = PAIR_FEATURES[feature];
      if (row.half !== probed || row.since !== 'next') continue;
      const result = await NEXT_PROBES[feature]!(ctx);
      found.push(`${feature}: ${result.how}`);
      if (!result.has) lacks.push(feature);
    }
    if (probed === 'panel') panelHalf = { ...panelHalf, lacks };
    else cabinetHalf = { ...cabinetHalf, lacks };
    notes.push(
      lacks.length > 0
        ? `the other half's :main (${probed}) lacks ${lacks.join(', ')}; this run tested new + old; the other repo's E2E covers new + new (${found.join('; ')})`
        : `the other half's :main (${probed}) has every next feature (${found.join('; ')})`,
    );
  }

  const outside = [panelHalf.outside, cabinetHalf.outside].filter((reason) => reason !== undefined);
  return {
    panel: panelHalf,
    cabinet: cabinetHalf,
    outside: outside.length > 0 ? outside.join('; ') : null,
    notes,
  };
}

function describeHalf(half: HalfVersion): string {
  return half.effective === 'next'
    ? `${half.reported || '?'} (${half.build === 'next' ? 'unreleased build' : 'newer than the table'}: next)`
    : `${half.effective}${half.reported.replace(/^v/i, '') === half.effective ? '' : ` (reports ${half.reported})`}`;
}

/** The pairing, or a skip when the table cannot speak for it. */
function requirePair(ctx: ScenarioContext): PairInfo {
  if (ctx.pair === null) throw new Error(`the pair's versions could not be read: ${ctx.pairProblem ?? 'unknown'}`);
  if (ctx.pair.outside !== null) throw new ScenarioSkip(ctx.pair.outside);
  return ctx.pair;
}

// ── Money: what the pair sells, as a subscriber sees it ────────────────────

/** Test values. The subscriber exists only on a stack this run creates. */
const SUBSCRIBER_PASSWORD = 'e2e-subscriber-pass-1234';
const SESSION_COOKIE = 'reiwa_web_session';
const MONEY_PLAN_TRAFFIC_GB = 100;
const MONEY_ADDON_GB = 10;
/**
 * Any gateway would do: the add-on is priced at 0, and a zero checkout is the
 * panel's own no-provider path (addon-purchase.service.ts: drafted, completed
 * and fulfilled at once, `providerMode: NONE`). The gateway must still be
 * active and look configured, because that is checked first. Its settings are
 * placeholders that nothing ever sends anywhere.
 */
const MONEY_GATEWAY = 'YOOKASSA';
const MONEY_CURRENCY = 'RUB';
/** Long enough to outlive the next monthly reset from any day of any month. */
const MONEY_SUBSCRIPTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Subscriber {
  readonly username: string;
  readonly userId: string;
  /** `reiwa_web_session=<id>`, sent back the way a browser would. */
  readonly cookie: string;
}

interface MoneyFixture {
  readonly planId: string;
  readonly addOnId: string;
  readonly subscriptionId: string;
}

interface OfferSeen {
  readonly listed: boolean;
  readonly revision: number | null;
  readonly lifetime: string | null;
  readonly expiresAt: string | null;
}

/** The origin a browser on the cabinet sends; the cabinet refuses writes from any other. */
function cabinetOrigin(): string {
  return new URL(REIWA_BASE).origin;
}

function requireSubscriber(ctx: ScenarioContext): Subscriber {
  if (ctx.subscriber === null) throw new Error('needs scenario 18: no subscriber signed in on the cabinet');
  return ctx.subscriber;
}

function requireMoney(ctx: ScenarioContext): MoneyFixture {
  if (ctx.money === null) throw new Error('needs scenario 19: no subscription on a monthly-reset plan');
  return ctx.money;
}

/** What the cabinet must offer for the «до сброса» traffic add-on in this pairing. */
function expectedOffer(pair: PairInfo): {
  /** False when the panel holds the sale back from this cabinet (the capability gate). */
  readonly listed: boolean;
  readonly lifetime: 'UNTIL_NEXT_RESET' | 'UNTIL_SUBSCRIPTION_END';
  readonly resetEndShown: boolean;
  readonly dated: boolean;
  readonly hazard: string | null;
} {
  const sellsUntilReset = pairHas(pair, 'panel.sells-until-reset');
  const cabinetSaysReset = pairHas(pair, 'cabinet.reset-end');
  const withheld = sellsUntilReset && !cabinetSaysReset && pairHas(pair, 'panel.knows-cabinet');
  return {
    listed: !withheld,
    lifetime: sellsUntilReset ? 'UNTIL_NEXT_RESET' : 'UNTIL_SUBSCRIPTION_END',
    resetEndShown: sellsUntilReset && cabinetSaysReset,
    dated: pairHas(pair, 'cabinet.dated'),
    hazard:
      sellsUntilReset && !cabinetSaysReset && !withheld
        ? 'sold «до сброса», and this cabinet cannot say so (no endsBound/nextResetAt/resetSoon reach it)'
        : null,
  };
}

// ── Talking to the stack itself ────────────────────────────────────────────

/**
 * The stack's compose project and file, from run-e2e.mts. Scenarios that read
 * a container's Redis or log need them, and skip without them — the runner
 * started by hand against some stack cannot know where it is.
 */
const E2E_PROJECT = process.env.E2E_PROJECT ?? '';
const E2E_COMPOSE_FILE = process.env.E2E_COMPOSE_FILE ?? '';

function composeRun(
  args: readonly string[],
  input?: string,
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  if (E2E_PROJECT === '' || E2E_COMPOSE_FILE === '') {
    // Run by run-e2e.mts — it sets E2E_RESULTS_FILE — the stack is right there,
    // and a lost wiring must not turn the pair scenarios into green skips (R1-10a).
    if ((process.env.E2E_RESULTS_FILE ?? '') !== '') {
      throw new Error('run-e2e.mts passed no E2E_PROJECT / E2E_COMPOSE_FILE: the pair scenarios cannot reach the stack');
    }
    throw new ScenarioSkip('needs the stack itself (E2E_PROJECT, E2E_COMPOSE_FILE): run it through run-e2e.mts');
  }
  const r = spawnSync('docker', ['compose', '-p', E2E_PROJECT, '-f', E2E_COMPOSE_FILE, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? `${r.error?.message ?? ''}` };
}

/** A shell line inside one of the two Valkey containers. */
function inValkey(service: 'rezeis-e2e-redis' | 'reiwa-e2e-redis', script: string): string {
  const r = composeRun(['exec', '-T', service, 'sh', '-c', script]);
  if (r.code !== 0) throw new Error(`${service}: \`${script}\` exited ${r.code}: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * SQL through `psql` in the panel's database container, from stdin, stopping
 * at the first error; the rows come back unaligned, tuples only. For what no
 * API of the panel can do any more (the retired landing's rows).
 */
function inPanelDatabase(sql: string): string {
  const r = composeRun(
    ['exec', '-T', 'rezeis-e2e-db', 'psql', '-U', 'rezeis', '-d', 'rezeis', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'],
    sql,
  );
  if (r.code !== 0) throw new Error(`psql in rezeis-e2e-db exited ${r.code}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The value of one key in the cabinet's Valkey, or null when there is none. */
function cabinetRedisGet(key: string): string | null {
  const r = composeRun(['exec', '-T', 'reiwa-e2e-redis', 'valkey-cli', '--raw', 'GET', key]);
  if (r.code !== 0) throw new Error(`reiwa-e2e-redis: GET ${key} exited ${r.code}: ${r.stderr.trim()}`);
  const value = r.stdout.replace(/\r?\n$/, '');
  return value === '' ? null : value;
}

/** Writes `value` to one key of the cabinet's Valkey, passed on stdin (`-x`), so no shell quotes it. */
function cabinetRedisSet(key: string, value: string): void {
  const r = composeRun(['exec', '-T', 'reiwa-e2e-redis', 'valkey-cli', '-x', 'SET', key], value);
  if (r.code !== 0 || !/^OK/.test(r.stdout.trim())) {
    throw new Error(`reiwa-e2e-redis: SET ${key} exited ${r.code}: ${`${r.stdout}${r.stderr}`.trim()}`);
  }
}

/** One `&anchor value` line of the compose file the stack was started from. */
function composeAnchor(name: string): string {
  // The file the stack was started from; beside this runner when run by hand.
  const compose = readFileSync(
    E2E_COMPOSE_FILE !== '' ? E2E_COMPOSE_FILE : new URL('./docker-compose.e2e.yml', import.meta.url),
    'utf8',
  );
  const found = new RegExp(`^x-${name}: &${name} (\\S+)\\s*$`, 'm').exec(compose);
  assert(found !== null, `docker-compose.e2e.yml has no \`x-${name}: &${name} …\` line`);
  return found[1]!;
}

/**
 * The secret the cabinet signs its internal calls with. Read off the compose
 * file's `x-internal-secret` anchor, the one place it is written — a copy here
 * would drift the way the compose file's own header warns about.
 */
function internalSecret(): string {
  return composeAnchor('internal-secret');
}

/**
 * A settings hint as the panel's relay sends it: `POST /api/v1/webhooks/rezeis`,
 * signed with the relay secret (the compose file's `x-relay-secret` anchor,
 * `WEBHOOK_SECRET_HEADER` on the panel, `REZEIS_WEBHOOK_SECRET` on reiwa) over
 * `<t>.<raw body>`. Scenario 16 proves a wrong secret is refused; this one is
 * the right secret, so the cabinet acts on it.
 */
async function sendRelayHint(ctx: ScenarioContext, event: string): Promise<number> {
  const body = JSON.stringify({ event, metadata: { reason: 'e2e' } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', composeAnchor('relay-secret')).update(`${t}.${body}`).digest('hex');
  const answer = await ctx.reiwa.post('/api/v1/webhooks/rezeis', body, {
    headers: { 'Content-Type': 'application/json', 'X-Rezeis-Signature': `t=${t},v1=${v1}` },
    // The exact bytes that were signed.
    transformRequest: [(data: unknown) => data],
  });
  return answer.status;
}

async function directToken(ctx: ScenarioContext): Promise<string> {
  if (ctx.directToken !== null) return ctx.directToken;
  const created = await ctx.admin.post<{ token: string }>(
    '/admin/api-tokens',
    { name: 'e2e-direct' },
    { headers: { Authorization: `Bearer ${ctx.bearerToken}` } },
  );
  expectStatus(created, 201, 'POST /admin/api-tokens (e2e-direct)');
  ctx.directToken = created.data.token;
  return ctx.directToken;
}

/**
 * A call to the panel's internal API made the way a cabinet makes it: bearer
 * token plus `x-request-timestamp` / `x-request-signature`, an HMAC over the
 * method, the path WITH its query, the timestamp and the sha256 of the exact
 * body bytes (reiwa `src/lib/internal-hmac.ts`). With no `headers`, a SILENT
 * caller — the 0.9.7.53 cabinet and every older one.
 */
async function internalCall<T>(
  ctx: ScenarioContext,
  method: 'GET' | 'POST',
  path: string,
  options: { readonly body?: unknown; readonly headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T }> {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const timestamp = Date.now().toString();
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', internalSecret())
    .update([method, path, timestamp, digest].join('\n'))
    .digest('hex');
  return ctx.admin.request<T>({
    method,
    // The admin client's base URL ends in /api; the path signed is the full one.
    baseURL: REZEIS_BASE,
    url: path,
    data: options.body === undefined ? undefined : body,
    headers: {
      Authorization: `Bearer ${await directToken(ctx)}`,
      'x-request-timestamp': timestamp,
      'x-request-signature': signature,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers ?? {}),
    },
    // The exact bytes that were signed.
    transformRequest: [(data: unknown) => data],
  });
}

/**
 * THE MARK OF A REFUSAL PROVOKED ON PURPOSE, for scenario 27 — the headers to
 * send with the call. Its `x-request-id` reaches the panel's refusal line
 * (`requestId=… status=… path=…`): sent to the panel directly, or to the
 * cabinet, which forwards it on its own call to the panel (reiwa
 * `buildTraceHeaders`, every cabinet release in the table). The run id keeps
 * an earlier run's provocations on a kept-alive stack apart from this run's.
 */
function provoke(ctx: ScenarioContext, status: number, path: string, what: string): Record<string, string> {
  const requestId = `e2e-provoked-${ctx.runId}-${ctx.expectedRefusals.length + 1}`;
  ctx.expectedRefusals.push({ status, path, requestId, what });
  return { 'x-request-id': requestId };
}

/** What a cabinet that can show the reset end sends (reiwa `src/core/capabilities.ts`). */
function declaringHeaders(pair: PairInfo): Record<string, string> {
  const version = pair.cabinet.reported.replace(/^v/i, '') || '0.0.0';
  return {
    'x-reiwa-client': `surface=api; version=${version}; commit=e2e; instance=e2e-direct`,
    'x-reiwa-capabilities': 'web.addon-reset-end',
  };
}

interface PeersSnapshot {
  readonly panelVersion: string;
  readonly floorVersion: string;
  readonly surfaces: Record<
    'api' | 'bot',
    {
      readonly state: string;
      readonly behind: boolean;
      readonly version: string | null;
      readonly declared: boolean;
      readonly missing: ReadonlyArray<{ readonly id: string }>;
      readonly unknownToPanel: number;
      readonly instances: ReadonlyArray<{ readonly instance: string; readonly source: string; readonly live: boolean }>;
    }
  >;
}

/**
 * Waits until the panel has heard from the cabinet the way this pairing says it
 * will: a declaration, or a silent heartbeat — sent at the cabinet's boot —
 * and, from a cabinet that polls, its first poll five seconds later.
 */
async function waitForCabinetEvidence(ctx: ScenarioContext, pair: PairInfo): Promise<PeersSnapshot> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const wanted = pairHas(pair, 'cabinet.declares')
    ? ['declared']
    : pairHas(pair, 'cabinet.polls-versions')
      ? ['heartbeat', 'poll']
      : ['heartbeat'];
  const deadline = Date.now() + 45_000;
  let last: PeersSnapshot | null = null;
  for (;;) {
    const answer = await ctx.admin.get<PeersSnapshot>('/admin/reiwa-peers', { headers: auth });
    expectStatus(answer, 200, 'GET /admin/reiwa-peers');
    last = answer.data;
    const live = new Set(last.surfaces.api.instances.filter((i) => i.live).map((i) => i.source));
    if (last.surfaces.api.state === 'live' && wanted.every((source) => live.has(source))) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `the panel has not heard ${wanted.join(' + ')} from the cabinet within 45 s: ${JSON.stringify(last.surfaces.api)}`,
      );
    }
    await sleep(1_000);
  }
}

/**
 * A SUBSCRIBER SIGNS IN ON THE CABINET, THE WAY A BROWSER DOES.
 *
 * Registers through the cabinet's public API with the browser's Origin, keeps
 * the session cookie the cabinet sets and sends it back. The cookie is
 * `Secure` (production), which a browser would drop over plain http; this
 * client keeps it itself (docker-compose.e2e.yml, next to the cookie flags).
 * The cabinet's other boundary is checked on the way: a write that carries the
 * session but no Origin is refused, whoever made it.
 */
async function scenarioSubscriberSignsInOnCabinet(ctx: ScenarioContext): Promise<string> {
  const username = `e2esub${Date.now().toString(36)}`;
  const passwordHash = createHash('sha256').update(SUBSCRIBER_PASSWORD).digest('hex');
  const registered = await ctx.reiwa.post<{ success?: boolean }>(
    '/api/v1/auth/register',
    { username, passwordHash },
    { headers: { Origin: cabinetOrigin() } },
  );
  expectStatus(registered, 200, 'POST reiwa /api/v1/auth/register');
  assert(registered.data.success === true, `registration answered ${JSON.stringify(registered.data)}`);

  const setCookie = ([] as string[]).concat(registered.headers['set-cookie'] ?? []);
  const session = setCookie.find((line) => line.startsWith(`${SESSION_COOKIE}=`));
  assert(session !== undefined, `the cabinet set no ${SESSION_COOKIE}: ${JSON.stringify(setCookie)}`);
  const flags = session.split(';').map((part) => part.trim().toLowerCase());
  assert(flags.includes('httponly'), `${SESSION_COOKIE} is readable by scripts: ${session.split(';').slice(1).join(';')}`);
  assert(flags.includes('samesite=lax'), `${SESSION_COOKIE} is not SameSite=Lax`);
  const cookie = session.split(';')[0]!;

  const me = await ctx.reiwa.get<{ id?: unknown }>('/api/v1/me', { headers: { Cookie: cookie } });
  expectStatus(me, 200, 'GET reiwa /api/v1/me');
  assert(typeof me.data?.id === 'string' && me.data.id.length > 0, `/me answered ${JSON.stringify(me.data)}`);

  const noOrigin = await ctx.reiwa.post('/api/v1/add-ons/purchase', {}, { headers: { Cookie: cookie } });
  expectStatus(noOrigin, 403, 'POST reiwa /api/v1/add-ons/purchase with the session and no Origin');

  ctx.subscriber = { username, userId: me.data.id, cookie };
  return `${username} (${me.data.id}) · session cookie HttpOnly, SameSite=Lax · a write without Origin → 403`;
}

/**
 * A SUBSCRIPTION ON A PLAN WITH A MONTHLY TRAFFIC RESET, SEEN BY THE CABINET.
 *
 * Everything through the panel's admin API, nothing in SQL:
 *  - «Докупка трафика до сброса» on (and the new accounting it needs), where
 *    the panel has the switch;
 *  - a plan: 100 GB, reset `MONTH` (calendar), no squads — squads would make
 *    the panel ask Remnawave, and there is none here;
 *  - a traffic add-on sold «до следующего сброса», priced 0;
 *  - one gateway active, with placeholder settings (see MONEY_GATEWAY);
 *  - the subscription, given by the admin to the subscriber of scenario 18.
 *
 * NO REMNAWAVE IS NEEDED, and this is why. Giving a subscription writes the
 * row and its first term in one transaction and only QUEUES the Remnawave
 * profile: the sync job then fails and retries in the panel's log
 * («ProfileSyncProcessor … panel unreachable»), and the subscription stays
 * ACTIVE with no Remnawave id for the few seconds these scenarios need. A
 * `MONTH` term is anchored at its own start, so the next reset is the panel's
 * arithmetic alone. A `MONTH_ROLLING` plan would need the Remnawave profile's
 * creation date, and without it the panel withholds the add-on — which is why
 * the plan here is calendar-monthly.
 */
async function scenarioSubscriptionOnMonthlyResetPlan(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  const subscriber = requireSubscriber(ctx);
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const notes: string[] = [];

  if (pairHas(pair, 'panel.add-on-switches')) {
    const switches = await ctx.admin.patch<{ switches: Array<{ name: string; enabled: boolean; locked: boolean }> }>(
      '/admin/add-on-settings',
      { durableAccounting: true, trafficResetExpiry: true },
      { headers: auth },
    );
    expectStatus(switches, 200, 'PATCH /admin/add-on-settings');
    for (const name of ['durableAccounting', 'trafficResetExpiry']) {
      const row = switches.data.switches.find((s) => s.name === name);
      assert(row?.enabled === true, `switch ${name} is not on: ${JSON.stringify(row)}`);
    }
    notes.push('«Докупка трафика до сброса» on');
  }

  const suffix = Date.now().toString(36);
  const plan = await ctx.admin.post<{ id: string; trafficLimitStrategy: string; trafficLimit: number }>(
    '/admin/plans',
    {
      name: `e2e monthly ${suffix}`,
      type: 'TRAFFIC',
      availability: 'ALL',
      isActive: true,
      trafficLimit: MONEY_PLAN_TRAFFIC_GB,
      deviceLimit: 3,
      trafficLimitStrategy: 'MONTH',
      internalSquads: [],
      externalSquad: null,
      durations: [{ days: 30, prices: [{ currency: MONEY_CURRENCY, price: '100' }] }],
    },
    { headers: auth },
  );
  expectStatus(plan, 201, 'POST /admin/plans');
  assert(plan.data.trafficLimitStrategy === 'MONTH', `the plan resets ${plan.data.trafficLimitStrategy}, not MONTH`);

  const addOn = await ctx.admin.post<{ id: string; lifetime: string }>(
    '/admin/add-ons',
    {
      name: `e2e +${MONEY_ADDON_GB} GB до сброса ${suffix}`,
      type: 'EXTRA_TRAFFIC',
      lifetime: 'UNTIL_NEXT_RESET',
      value: MONEY_ADDON_GB,
      isActive: true,
      applicablePlanIds: [plan.data.id],
      prices: [{ currency: MONEY_CURRENCY, price: '0' }],
    },
    { headers: auth },
  );
  expectStatus(addOn, 201, 'POST /admin/add-ons');

  const gateways = await ctx.admin.post<Array<{ id: string; type: string }>>(
    '/admin/payments/gateways/defaults',
    {},
    { headers: auth },
  );
  expectStatus(gateways, [200, 201], 'POST /admin/payments/gateways/defaults');
  const gateway = gateways.data.find((g) => g.type === MONEY_GATEWAY);
  assert(gateway !== undefined, `no ${MONEY_GATEWAY} among the default gateways`);
  const activated = await ctx.admin.patch<{ isActive: boolean; currency: string }>(
    `/admin/payments/gateways/${gateway.id}`,
    {
      isActive: true,
      currency: MONEY_CURRENCY,
      settings: { shopId: 'e2e-shop', secretKey: 'e2e-placeholder-never-sent' },
    },
    { headers: auth },
  );
  expectStatus(activated, 200, `PATCH /admin/payments/gateways/${gateway.id}`);
  assert(
    activated.data.isActive === true && activated.data.currency === MONEY_CURRENCY,
    `${MONEY_GATEWAY} is not active in ${MONEY_CURRENCY}: ${JSON.stringify(activated.data)}`,
  );

  const given = await ctx.admin.post<{ id: string; status: string; expiresAt: string }>(
    `/admin/users/${subscriber.userId}/give-subscription`,
    { planId: plan.data.id, durationDays: MONEY_SUBSCRIPTION_DAYS },
    { headers: auth },
  );
  expectStatus(given, 200, 'POST /admin/users/:id/give-subscription');
  assert(given.data.status === 'ACTIVE', `the given subscription is ${given.data.status}`);

  // The cabinet's own view of it: its main page reads this.
  const seen = await ctx.reiwa.get<{ id?: string; status?: string } | null>('/api/v1/subscription', {
    headers: { Cookie: subscriber.cookie },
  });
  expectStatus(seen, 200, 'GET reiwa /api/v1/subscription');
  assert(
    seen.data?.id === given.data.id,
    `the cabinet shows ${JSON.stringify(seen.data)} instead of subscription ${given.data.id}`,
  );

  ctx.money = { planId: plan.data.id, addOnId: addOn.data.id, subscriptionId: given.data.id };
  notes.push(
    `plan ${MONEY_PLAN_TRAFFIC_GB} GB reset MONTH`,
    `+${MONEY_ADDON_GB} GB «до сброса» at 0 ${MONEY_CURRENCY}`,
    `subscription ${given.data.id} until ${given.data.expiresAt.slice(0, 10)}, shown by the cabinet`,
  );
  return notes.join(' · ');
}

/**
 * THE CABINET OFFERS THE TRAFFIC ADD-ON «ДО СБРОСА», AND SAYS UNTIL WHEN.
 *
 * The screen «Дополнительные опции» reads exactly this answer. Which lifetime
 * is sold is the panel's decision; whether the customer is TOLD that it ends
 * at the traffic reset depends on the cabinet too, because the cabinet parses
 * the offer with its own schema and drops the fields it does not know. Both
 * halves' parts come from the pair table.
 */
async function scenarioAddOnOfferedByCabinet(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  const subscriber = requireSubscriber(ctx);
  const money = requireMoney(ctx);
  const expected = expectedOffer(pair);
  // A panel that knows its cabinet decides by what it has heard from it; the
  // answer below must not race the cabinet's first word.
  if (pairHas(pair, 'panel.knows-cabinet')) await waitForCabinetEvidence(ctx, pair);

  const asked = Date.now();
  const answer = await ctx.reiwa.get<{
    contractVersion: number;
    availability: string;
    addOns?: Array<{
      id: string;
      revision: number;
      lifetime: string;
      eligibility: Record<string, unknown>;
    }>;
  }>(`/api/v1/add-ons/subscriptions/${money.subscriptionId}`, { headers: { Cookie: subscriber.cookie } });
  const answered = Date.now();
  expectStatus(answer, 200, 'GET reiwa /api/v1/add-ons/subscriptions/:id');
  assert(answer.data.contractVersion === 2, `contract ${answer.data.contractVersion}, not 2`);
  const offer = answer.data.addOns?.find((a) => a.id === money.addOnId);
  if (!expected.listed) {
    // The capability gate: this cabinet would show «Действует до …» with no
    // word about the reset, so the panel does not sell it through it at all.
    assert(
      offer === undefined,
      `the panel sells «до сброса» through a cabinet that cannot show its end: ${JSON.stringify(offer)}`,
    );
    ctx.offer = { listed: false, revision: null, lifetime: null, expiresAt: null };
    return `withheld: this cabinet cannot show the reset end (no web.addon-reset-end), so the panel does not offer it`;
  }
  assert(offer !== undefined, `the cabinet does not offer the add-on: ${JSON.stringify(answer.data)}`);

  const e = offer.eligibility;
  assert(e['eligible'] === true && e['activation'] === 'NOW', `not offered for now: ${JSON.stringify(e)}`);
  assert(offer.lifetime === expected.lifetime, `sold ${offer.lifetime}, the table expects ${expected.lifetime}`);
  assert(
    e['explanationCode'] ===
      (expected.lifetime === 'UNTIL_NEXT_RESET' ? 'ELIGIBLE_UNTIL_NEXT_RESET' : 'ELIGIBLE_UNTIL_SUBSCRIPTION_END'),
    `explanation ${String(e['explanationCode'])} for ${offer.lifetime}`,
  );
  assert(
    expected.dated ? e['dated'] === true : e['dated'] === undefined,
    `dated=${String(e['dated'])}, the table expects ${expected.dated ? 'true' : 'absent'}`,
  );
  const expiresAt = Date.parse(String(e['expiresAt']));
  assert(Number.isFinite(expiresAt) && expiresAt > answered, `expiresAt ${String(e['expiresAt'])} is not ahead`);

  let shown: string;
  if (expected.resetEndShown) {
    assert(e['endsBound'] === 'reset', `endsBound ${String(e['endsBound'])}: the subscription outlives the reset`);
    const reset = Date.parse(String(e['nextResetAt']));
    assert(Number.isFinite(reset), `nextResetAt ${String(e['nextResetAt'])} is not a date`);
    assert(reset > asked && reset - asked <= 32 * DAY_MS, `nextResetAt ${String(e['nextResetAt'])} is not the next monthly reset`);
    // `MONTH` is the calendar month, in the zone Remnawave resets in, which
    // the fixture leaves at its default: UTC.
    assert(new Date(reset).getUTCDate() === 1, `a monthly reset on ${String(e['nextResetAt'])}, not on the 1st`);
    assert(
      expiresAt >= reset && expiresAt - reset <= 60 * 60 * 1000,
      `the add-on ends at ${String(e['expiresAt'])}, not at the reset ${String(e['nextResetAt'])}`,
    );
    // «Сброс скоро» is the owner's 24 hours; a request that straddles the
    // edge may read either way.
    const toReset = reset - answered;
    if (Math.abs(toReset - DAY_MS) > 10_000) {
      assert(e['resetSoon'] === toReset < DAY_MS, `resetSoon=${String(e['resetSoon'])} with the reset ${Math.round(toReset / 3_600_000)} h away`);
    }
    shown = `until the reset ${String(e['nextResetAt'])} (resetSoon ${String(e['resetSoon'])})`;
  } else {
    for (const field of ['endsBound', 'nextResetAt', 'resetSoon']) {
      assert(e[field] === undefined, `${field} reached the customer, the table says this pairing cannot carry it`);
    }
    shown = `«Действует до ${String(e['expiresAt']).slice(0, 10)}», no word about the reset`;
  }

  ctx.offer = {
    listed: true,
    revision: offer.revision,
    lifetime: offer.lifetime,
    expiresAt: String(e['expiresAt']),
  };
  return (
    `${offer.lifetime} · ${shown}` + (expected.hazard === null ? '' : ` · ORDER-BOX HAZARD: ${expected.hazard}`)
  );
}

/**
 * THE CHECKOUT OPENS AND DELIVERS WITHOUT A PAYMENT PROVIDER.
 *
 * The add-on is priced 0, so the panel drafts the transaction, completes and
 * fulfils it at once — its own path for a free add-on — and no provider is
 * asked anything: `providerMode: NONE`, no checkout URL. Every rule a paid
 * checkout passes before the provider is on this path too: the access mode,
 * the gateway, the owner, the plan, the finite baseline, the LIFETIME the
 * add-on is sold for, the price and the catalogue revision.
 *
 * Then what the subscriber holds: «Мои опции» lists it ending where the offer
 * said, and the subscription carries the extra gigabytes.
 */
async function scenarioAddOnCheckoutWithoutProvider(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  const subscriber = requireSubscriber(ctx);
  const money = requireMoney(ctx);
  const offer = ctx.offer;
  if (offer === null) throw new Error('needs scenario 20: the offer was not read');
  if (!offer.listed) return checkoutOfWithheldAddOn(ctx, subscriber, money);

  const bought = await ctx.reiwa.post<{
    transactionStatus: string;
    providerMode: string;
    checkoutUrl: string | null;
    amount: string;
    purchaseType: string;
  }>(
    '/api/v1/add-ons/purchase',
    {
      addOnId: money.addOnId,
      subscriptionId: money.subscriptionId,
      gatewayType: MONEY_GATEWAY,
      expectedAddOnRevision: offer.revision,
      idempotencyKey: randomUUID(),
      contractVersion: 2,
    },
    { headers: { Cookie: subscriber.cookie, Origin: cabinetOrigin() } },
  );
  expectStatus(bought, 200, 'POST reiwa /api/v1/add-ons/purchase');
  const receipt = bought.data;
  assert(
    receipt.transactionStatus === 'COMPLETED' && receipt.providerMode === 'NONE' && receipt.checkoutUrl === null,
    `not the no-provider completion: ${JSON.stringify(receipt)}`,
  );
  assert(receipt.amount === '0' && receipt.purchaseType === 'ADDITIONAL', `charged: ${JSON.stringify(receipt)}`);

  const held = await ctx.reiwa.get<{
    entitlements?: Array<{
      addOnId: string | null;
      lifetime: string;
      state: string;
      expiresAt: string | null;
      endsBound?: string | null;
      resetAt?: string | null;
    }>;
  }>('/api/v1/activity/add-on-entitlements', { headers: { Cookie: subscriber.cookie } });
  expectStatus(held, 200, 'GET reiwa /api/v1/activity/add-on-entitlements');
  const entitlement = held.data.entitlements?.find((x) => x.addOnId === money.addOnId);
  assert(entitlement !== undefined, `«Мои опции» does not list it: ${JSON.stringify(held.data)}`);
  assert(entitlement.state === 'ACTIVE', `the bought add-on is ${entitlement.state}`);
  assert(entitlement.lifetime === offer.lifetime, `bought ${entitlement.lifetime}, offered ${String(offer.lifetime)}`);
  assert(
    entitlement.expiresAt === offer.expiresAt,
    `held until ${String(entitlement.expiresAt)}, offered until ${String(offer.expiresAt)}`,
  );
  // This route hands the panel's answer on as it is, whatever the cabinet
  // knows, so what it says about the reset is the panel's part alone.
  if (pairHas(pair, 'panel.sells-until-reset')) {
    assert(entitlement.endsBound === 'reset', `ends ${String(entitlement.endsBound)}, not at the reset`);
    assert(
      typeof entitlement.resetAt === 'string' && new Date(entitlement.resetAt).getUTCDate() === 1,
      `resetAt ${String(entitlement.resetAt)}`,
    );
  }

  const subscription = await ctx.reiwa.get<{ trafficLimit?: number } | null>('/api/v1/subscription', {
    headers: { Cookie: subscriber.cookie },
  });
  expectStatus(subscription, 200, 'GET reiwa /api/v1/subscription (after)');
  assert(
    subscription.data?.trafficLimit === MONEY_PLAN_TRAFFIC_GB + MONEY_ADDON_GB,
    `the subscription carries ${String(subscription.data?.trafficLimit)} GB, not ${MONEY_PLAN_TRAFFIC_GB} + ${MONEY_ADDON_GB}`,
  );
  const transactions = await transactionsOf(ctx, subscriber.userId);
  assert(transactions === 1, `the panel holds ${transactions} transactions for the subscriber, not the one completed`);
  return (
    `COMPLETED at 0 ${MONEY_CURRENCY}, providerMode NONE · held ${entitlement.lifetime} until ` +
    `${String(entitlement.expiresAt)} · subscription ${MONEY_PLAN_TRAFFIC_GB + MONEY_ADDON_GB} GB · 1 transaction`
  );
}

/** How many transactions the panel holds for a user, from its admin list. */
async function transactionsOf(ctx: ScenarioContext, userId: string): Promise<number> {
  const listed = await ctx.admin.get<{ items?: unknown[]; total?: number } | unknown[]>('/admin/payments/transactions', {
    params: { userId },
    headers: { Authorization: `Bearer ${ctx.bearerToken}` },
  });
  expectStatus(listed, 200, 'GET /admin/payments/transactions');
  const data = listed.data;
  if (Array.isArray(data)) return data.length;
  if (typeof data.total === 'number') return data.total;
  assert(Array.isArray(data.items), `the transaction list has no items: ${JSON.stringify(data).slice(0, 300)}`);
  return data.items.length;
}

/**
 * THE CHECKOUT OF A WITHHELD ADD-ON IS REFUSED, AND NOTHING IS DRAFTED.
 *
 * A page opened before the gate still posts the purchase. The cabinet must get
 * a refusal — it answers only «Add-on purchase failed», whatever the panel's
 * reason (`sendSafeError`) — so the reason is read from the panel itself, asked
 * the way this cabinet asks: silent. The panel must refuse BEFORE the draft:
 * no transaction, no add-on, no extra gigabytes.
 */
async function checkoutOfWithheldAddOn(
  ctx: ScenarioContext,
  subscriber: Subscriber,
  money: MoneyFixture,
): Promise<string> {
  const purchase = {
    addOnId: money.addOnId,
    subscriptionId: money.subscriptionId,
    gatewayType: MONEY_GATEWAY,
    contractVersion: 2,
  };
  const refused = await ctx.reiwa.post(
    '/api/v1/add-ons/purchase',
    { ...purchase, idempotencyKey: randomUUID() },
    {
      headers: {
        Cookie: subscriber.cookie,
        Origin: cabinetOrigin(),
        ...provoke(ctx, 400, '/api/internal/add-ons/purchase', "the cabinet's checkout of the withheld add-on"),
      },
    },
  );
  expectStatus(refused, 400, 'POST reiwa /api/v1/add-ons/purchase of a withheld add-on');

  const direct = await internalCall<Record<string, unknown>>(ctx, 'POST', '/api/internal/add-ons/purchase', {
    body: { userId: subscriber.userId, ...purchase, idempotencyKey: randomUUID() },
    headers: provoke(ctx, 400, '/api/internal/add-ons/purchase', 'the silent direct checkout of the withheld add-on'),
  });
  expectStatus(direct, 400, 'POST /api/internal/add-ons/purchase, silent');
  // The gate's own code, on the wire, where a client can act on it. Only a
  // panel with the gate refuses here — one that keeps records of its cabinet
  // (`panel.knows-cabinet`) — and the release that brings the gate also lists
  // the code in its safe error filter (`SAFE_PRODUCT_CODES`). Before that the
  // filter stripped it to `errorCode: BAD_REQUEST`, and no client could tell
  // this refusal from a 400 for a price, a gateway or a revision. A panel up to
  // 0.9.7.70 has no gate and never refuses here, so no older panel needs a
  // fallback: a gate without its code is a regression, and fails here.
  assert(
    direct.data['code'] === 'ADDON_LIFETIME_UNAVAILABLE',
    `refused without the gate's code ADDON_LIFETIME_UNAVAILABLE on the wire: ${JSON.stringify(direct.data)}`,
  );

  const transactions = await transactionsOf(ctx, subscriber.userId);
  assert(transactions === 0, `the refused checkout left ${transactions} transaction(s) behind`);
  const held = await ctx.reiwa.get<{ entitlements?: Array<{ addOnId: string | null }> }>(
    '/api/v1/activity/add-on-entitlements',
    { headers: { Cookie: subscriber.cookie } },
  );
  expectStatus(held, 200, 'GET reiwa /api/v1/activity/add-on-entitlements');
  assert(
    !(held.data.entitlements ?? []).some((x) => x.addOnId === money.addOnId),
    '«Мои опции» lists an add-on that was refused',
  );
  const subscription = await ctx.reiwa.get<{ trafficLimit?: number } | null>('/api/v1/subscription', {
    headers: { Cookie: subscriber.cookie },
  });
  expectStatus(subscription, 200, 'GET reiwa /api/v1/subscription (after the refusal)');
  assert(
    subscription.data?.trafficLimit === MONEY_PLAN_TRAFFIC_GB,
    `the subscription carries ${String(subscription.data?.trafficLimit)} GB after a refused add-on`,
  );
  return (
    `refused: the cabinet 400 (its generic answer), the panel 400 ADDON_LIFETIME_UNAVAILABLE ` +
    `«${String(direct.data['message'])}» · 0 transactions · ${MONEY_PLAN_TRAFFIC_GB} GB`
  );
}

// ── The pair: what each half knows about the other ─────────────────────────

/**
 * THE PANEL KNOWS WHICH CABINET CALLS IT, AND WHAT THAT CABINET CAN DO.
 *
 * «WEB Reiwa» → «Кабинет Reiwa» reads this answer. A cabinet that declares
 * itself is filed as declared; an older one by its heartbeat (at boot, then
 * hourly) and, from 0.9.7.53 on, by its version poll — and judged by the
 * version those imply. What it lacks is listed as `missing`; lacking the reset
 * end is what withholds the «до сброса» sale. NO BOT RUNS IN THIS STACK, so
 * the bot surface is `never` in every pairing.
 */
async function scenarioPanelKnowsItsCabinet(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  if (!pairHas(pair, 'panel.knows-cabinet')) {
    throw new ScenarioSkip(`panel ${pair.panel.effective} keeps no record of its cabinet`);
  }
  const peers = await waitForCabinetEvidence(ctx, pair);
  const api = peers.surfaces.api;
  const declares = pairHas(pair, 'cabinet.declares');
  assert(api.declared === declares, `api declared=${String(api.declared)}, the table expects ${String(declares)}`);
  const version = pair.cabinet.reported.replace(/^v/i, '');
  assert(api.version === version, `the panel files the cabinet as ${String(api.version)}, it reports ${version}`);
  const missing = api.missing.map((m) => m.id);
  const lacksResetEnd = !pairHas(pair, 'cabinet.reset-end');
  assert(
    missing.includes('web.addon-reset-end') === lacksResetEnd,
    `missing [${missing.join(', ')}], the table says web.addon-reset-end is ${lacksResetEnd ? '' : 'not '}missing`,
  );
  assert(api.behind === missing.length > 0, `behind=${String(api.behind)} with missing [${missing.join(', ')}]`);
  // A cabinet newer than its panel declares ids the panel has never heard of,
  // and the panel counts and ignores them: exactly those, and none otherwise.
  const unknownIds = (declares: PairFeature, knows: PairFeature, ids: readonly string[]): number =>
    pairHas(pair, declares) && !pairHas(pair, knows) ? ids.length : 0;
  const unknown =
    unknownIds('cabinet.declares-autopay-ids', 'panel.knows-autopay-ids', AUTOPAY_CAPABILITY_IDS) +
    unknownIds('cabinet.declares-connect-walk-id', 'panel.knows-connect-walk-id', CONNECT_WALK_CAPABILITY_IDS);
  assert(
    api.unknownToPanel === unknown,
    `the cabinet declares ${api.unknownToPanel} capability ids this panel does not know, the table expects ${unknown}`,
  );
  const sources = [...new Set(api.instances.filter((i) => i.live).map((i) => i.source))].sort();
  if (declares) assert(sources.join() === 'declared', `a declaring cabinet filed through ${sources.join(', ')}`);
  assert(peers.surfaces.bot.state === 'never', `a bot surface is ${peers.surfaces.bot.state}, and no bot runs here`);
  return (
    `api ${api.version} ${declares ? 'declared' : `silent (${sources.join(' + ')})`} · ` +
    `missing [${missing.join(', ')}] · behind ${String(api.behind)} · unknown to the panel ${api.unknownToPanel} · ` +
    'bot never (no bot in this stack) · ' +
    `floor ${peers.floorVersion}`
  );
}

/**
 * THE PANEL'S «ДО СБРОСА» GATE, ASKED DIRECTLY.
 *
 * The internal listing, signed as a cabinet signs it, three ways:
 *  1. with the headers of a cabinet that can show the reset end — offered on
 *     every panel; an older panel ignores the headers and must not refuse them;
 *  2. silent — judged by the live evidence of a SILENT cabinet only: a
 *     declaring cabinet leaves none, a 0.9.7.52 one implies no reset end;
 *  3. silent, after the panel's peer records are deleted — the floor: not
 *     offered. A cabinet that polls then brings it back within one poll.
 */
async function scenarioPanelGateAskedDirectly(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  const subscriber = requireSubscriber(ctx);
  const money = requireMoney(ctx);
  const path = `/api/internal/add-ons/subscriptions/${money.subscriptionId}?userId=${encodeURIComponent(subscriber.userId)}`;
  const offered = async (label: string, headers?: Record<string, string>): Promise<boolean> => {
    const answer = await internalCall<{ addOns?: Array<{ id: string }> }>(ctx, 'GET', path, { headers });
    expectStatus(answer, 200, `GET ${path.split('?')[0]} (${label})`);
    return (answer.data.addOns ?? []).some((a) => a.id === money.addOnId);
  };
  const knows = pairHas(pair, 'panel.knows-cabinet');
  const notes: string[] = [];

  assert(
    await offered('declaring', declaringHeaders(pair)),
    'not offered to a caller that declares web.addon-reset-end',
  );
  notes.push('declaring → offered');

  const silentOffered = !knows || (!pairHas(pair, 'cabinet.declares') && pairHas(pair, 'cabinet.reset-end'));
  assert(
    (await offered('silent')) === silentOffered,
    `a silent caller is ${silentOffered ? 'not ' : ''}offered it, the table says ${silentOffered ? 'offered' : 'withheld'}`,
  );
  notes.push(`silent → ${silentOffered ? 'offered' : 'withheld'}`);
  if (!knows) return `${notes.join(' · ')} (panel ${pair.panel.effective} does not read the headers)`;

  // The records and each surface's index of them (`reiwa-peers.constants.ts`;
  // the `v2` is the stored shape's number). Should the panel move them again,
  // nothing is found here and the assertion below says so.
  const deleted = inValkey(
    'rezeis-e2e-redis',
    'n=0; for k in $(valkey-cli --scan --pattern "rezeis:reiwa-peers:v2:peer:*"); do valkey-cli del "$k" >/dev/null; n=$((n+1)); done; ' +
      'for k in $(valkey-cli --scan --pattern "rezeis:reiwa-peers:v2:index:*"); do valkey-cli del "$k" >/dev/null; done; echo $n',
  ).trim();
  assert(Number(deleted) > 0, `no peer record to delete (${deleted}): the panel has heard nothing from the cabinet`);
  assert(!(await offered('silent, records deleted')), 'offered to a silent caller with no evidence at all');
  notes.push(`${deleted} record(s) deleted → withheld`);

  if (silentOffered) {
    // The silent cabinet's next version poll is the evidence again.
    const deadline = Date.now() + 45_000;
    while (!(await offered('silent, after the next poll'))) {
      assert(Date.now() < deadline, 'still withheld 45 s after the records were deleted: the poll did not bring it back');
      await sleep(1_000);
    }
    notes.push('the next poll brings it back');
  }
  return notes.join(' · ');
}

/**
 * THE CABINET KNOWS WHICH PANEL IT TALKS TO.
 *
 * A declaring cabinet keeps what the panel says about itself in the version
 * poll's answer at `reiwa:panel-capabilities:v1`: `declared` from a panel that
 * says, `legacy` from one that does not (0.9.7.70). Against an old panel the
 * cabinet's log also shows the poll was ANSWERED — a 404 would read «has no
 * version poll» — and the panel's log that the version heartbeat arrived.
 */
async function scenarioCabinetKnowsItsPanel(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  if (!pairHas(pair, 'cabinet.declares')) {
    throw new ScenarioSkip(`cabinet ${pair.cabinet.effective} keeps no view of its panel`);
  }
  const deadline = Date.now() + 45_000;
  let raw = '';
  for (;;) {
    raw = inValkey('reiwa-e2e-redis', 'valkey-cli get reiwa:panel-capabilities:v1').trim();
    if (raw !== '') break;
    assert(Date.now() < deadline, 'the cabinet stored no view of its panel within 45 s of polling');
    await sleep(1_000);
  }
  const view = JSON.parse(raw) as { kind?: unknown; version?: unknown; capabilities?: unknown; at?: unknown };
  const expected = pairHas(pair, 'panel.knows-cabinet') ? 'declared' : 'legacy';
  assert(view.kind === expected, `the cabinet holds a ${String(view.kind)} view, the table expects ${expected}: ${raw}`);
  assert(Array.isArray(view.capabilities), `no capability list in ${raw}`);
  if (expected === 'legacy') {
    const logs = composeRun(['logs', '--no-color', 'reiwa-e2e-api']).stdout;
    assert(
      logs.includes('the panel does not say what it can do'),
      "the cabinet's log does not show an answered poll of an old panel",
    );
    assert(!logs.includes('the panel has no version poll'), 'the cabinet found no version poll on the panel');
  }
  const panelLog = composeRun(['logs', '--no-color', 'rezeis-e2e-admin', 'rezeis-e2e-worker']).stdout;
  assert(/reiwa reported version: \S+/.test(panelLog), "the panel's log never took the cabinet's version heartbeat");
  return `${String(view.kind)} view of the panel (${JSON.stringify(view.capabilities)}) · poll answered · heartbeat taken`;
}

// ── The retired web landing (D2) ───────────────────────────────────────────

/** The seeded landing's `meta.title`: what a landing head on `/` would carry. */
const E2E_LANDING_TITLE = 'E2E landing';
const E2E_LANDING_REVISION_ID = 'e2e-landing-revision';
const E2E_LANDING_CONFIG_ID = 'e2e-landing-config';

/**
 * A published landing as panel 0.9.7.70's builder stored it (its
 * `landingConfigSchema`, schema version 1): one visible hero. ASCII only, since
 * it goes through psql.
 */
const E2E_LANDING = {
  schemaVersion: 1,
  enabled: true,
  theme: { inherit: true },
  locales: ['ru', 'en'],
  defaultLocale: 'ru',
  meta: {
    title: { ru: E2E_LANDING_TITLE, en: E2E_LANDING_TITLE },
    description: { ru: 'Seeded by the pair E2E', en: 'Seeded by the pair E2E' },
  },
  sections: [
    {
      id: 'e2e-hero',
      type: 'hero',
      visible: true,
      data: {
        heading: { ru: 'E2E landing hero', en: 'E2E landing hero' },
        primaryCta: { label: { ru: 'Sign in', en: 'Sign in' }, action: 'login' },
        align: 'center',
      },
    },
  ],
} as const;

/** What the retired route answers, whatever the tables hold. */
const RETIRED_LANDING = { enabled: false } as const;

/** Where cabinet 0.9.7.53 kept its landing copy, with no TTL (`LANDING_LKG` in its `last-known-good.ts`). */
const LANDING_COPY_KEY = 'reiwa:lkg:landing:v1';

/** The SPA document's mount point (reiwa `web/index.html`): what tells the document from any other page. */
const SPA_ROOT = /<div id="root"/;

/** The build's own `<title>`, and the panel's default «Название бренда». */
const STOCK_BRAND_NAME = 'Reiwa';
const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const OG_TITLE_META = /<meta\b[^>]*\bproperty=(["'])og:title\1[^>]*>/i;
const OG_SITE_NAME_META = /<meta\b[^>]*\bproperty=(["'])og:site_name\1[^>]*>/i;
const TWITTER_TITLE_META = /<meta\b[^>]*\bname=(["'])twitter:title\1[^>]*>/i;
const CONTENT_ATTRIBUTE = /\bcontent=(["'])([\s\S]*?)\1/i;

interface DocumentNames {
  readonly title: string | null;
  readonly ogTitle: string | null;
  readonly twitterTitle: string | null;
  readonly siteName: string | null;
}

/** What a document's head names itself (null where a tag is absent). */
function documentNames(html: string): DocumentNames {
  const content = (tag: RegExpExecArray | null): string | null => (tag === null ? null : (CONTENT_ATTRIBUTE.exec(tag[0])?.[2] ?? null));
  return {
    title: TITLE_TAG.exec(html)?.[1] ?? null,
    ogTitle: content(OG_TITLE_META.exec(html)),
    twitterTitle: content(TWITTER_TITLE_META.exec(html)),
    siteName: content(OG_SITE_NAME_META.exec(html)),
  };
}

/**
 * THE NEW CABINET NAMES ITS DOCUMENTS AFTER THE OPERATOR (reiwa
 * `document-title.ts`, the owner's decision of 26.09.2026). With the landing
 * gone nothing else gives `/` a title, so a link preview now says the
 * operator's name:
 *  - `<title>`, `og:title`, `twitter:title` — the tab title: «Заголовок
 *    веб-страницы», else «Название проекта» («Платформа» → «Брендинг»), else
 *    «Название бренда» («WEB Reiwa» → «Идентичность»);
 *  - `og:site_name` — the brand;
 *  - with the stock brand «Reiwa» and neither title: the document as built,
 *    `<title>Reiwa</title>` and no preview tags.
 * The fixture sets a brand of its own, then a web title over it, through the
 * panel's settings API, reads the served head after each, and puts the
 * operator's values back.
 */
async function documentNamedAfterOperator(ctx: ScenarioContext): Promise<string> {
  const auth = { Authorization: `Bearer ${ctx.bearerToken}` };
  const current = await ctx.admin.get<{ brandName: string }>('/admin/settings/branding', { headers: auth });
  expectStatus(current, 200, 'GET /admin/settings/branding');
  const originalBrand = current.data.brandName;
  // What the cabinet reads the titles from: the panel's public config.
  const config = await internalCall<{ platformBranding?: { webTitle?: string | null; projectName?: string | null } }>(
    ctx,
    'GET',
    '/api/internal/branding/public-config',
  );
  expectStatus(config, 200, 'GET /api/internal/branding/public-config');
  const originalWebTitle = config.data.platformBranding?.webTitle ?? null;
  const originalTitle = (originalWebTitle ?? '').trim() || (config.data.platformBranding?.projectName ?? '').trim();

  const served = async (label: string): Promise<DocumentNames> => {
    const answer = await ctx.reiwa.get<string>('/', { headers: { Accept: 'text/html' }, responseType: 'text' });
    expectStatus(answer, 200, `GET reiwa / (${label})`);
    return documentNames(answer.data);
  };
  // A settings save reaches the cabinet by the relay at once, or by its
  // version poll (~20 s) when a hint is lost: the document is read until it
  // names what is expected, or the deadline passes.
  const servedOnce = async (label: string, title: string, deadlineMs: number): Promise<DocumentNames> => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const names = await served(label);
      if (names.title === title || Date.now() > deadline) return names;
      await sleep(500);
    }
  };
  const notes: string[] = [];

  if (originalBrand === STOCK_BRAND_NAME && originalTitle === '') {
    const stock = await served('the stock brand');
    assert(
      stock.title === STOCK_BRAND_NAME && stock.ogTitle === null && stock.twitterTitle === null && stock.siteName === null,
      `with the stock brand and no title the document is not as built: ${JSON.stringify(stock)}`,
    );
    notes.push(`stock brand → <title>${STOCK_BRAND_NAME}</title>, no preview tags`);
  }

  const brand = `E2E brand ${ctx.runId}`;
  const webTitle = `E2E tab ${ctx.runId}`;
  let brandSet = false;
  let webTitleSet = false;
  try {
    await saveBrandNameAndWaitForCabinet(ctx, auth, brand);
    brandSet = true;
    const withBrand = originalTitle || brand;
    const named = await servedOnce(`brand "${brand}"`, withBrand, RELAY_DEADLINE_MS);
    assert(
      named.title === withBrand && named.ogTitle === withBrand && named.twitterTitle === withBrand && named.siteName === brand,
      `with the brand "${brand}" the document is named ${JSON.stringify(named)}; ` +
        `expected <title>, og:title and twitter:title "${withBrand}", og:site_name "${brand}"`,
    );
    notes.push(`brand set → title "${withBrand}", og:site_name "${brand}"`);

    const saved = await ctx.admin.patch('/admin/settings/platform', { platformBranding: { webTitle } }, { headers: auth });
    expectStatus(saved, 200, 'PATCH /admin/settings/platform (platformBranding.webTitle)');
    webTitleSet = true;
    const titled = await servedOnce(`web title "${webTitle}"`, webTitle, 35_000);
    assert(
      titled.title === webTitle && titled.ogTitle === webTitle && titled.twitterTitle === webTitle && titled.siteName === brand,
      `with the web title "${webTitle}" the document is named ${JSON.stringify(titled)}; ` +
        `expected <title>, og:title and twitter:title "${webTitle}", og:site_name "${brand}"`,
    );
    notes.push(`web title set → title "${webTitle}", og:site_name still "${brand}"`);
  } finally {
    if (webTitleSet) {
      await ctx.admin
        .patch('/admin/settings/platform', { platformBranding: { webTitle: originalWebTitle } }, { headers: auth })
        .catch(() => undefined);
    }
    if (brandSet) {
      await ctx.admin.patch('/admin/settings/branding', { brandName: originalBrand }, { headers: auth }).catch(() => undefined);
    }
  }
  return notes.join(' · ');
}

/** Both halves' settings version of a payload (`config-version-hash.ts`, reiwa `config-version.ts`). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function configVersionOf(payload: unknown): string {
  const wire: unknown = JSON.parse(JSON.stringify(payload) ?? 'null');
  return createHash('sha256').update(canonicalJson(wire), 'utf8').digest('hex').slice(0, 32);
}

function landingTitleOf(body: unknown): unknown {
  const meta = (body as { meta?: { title?: Record<string, unknown> } } | null)?.meta;
  return meta?.title?.['ru'];
}

/**
 * The operator's published landing, written straight into the panel's tables:
 * the builder that wrote it is gone from a retired panel, and its rows are
 * exactly what an operator updating from 0.9.7.70 still has. Idempotent.
 */
function seedPublishedLanding(): void {
  const json = JSON.stringify(E2E_LANDING);
  inPanelDatabase(
    `INSERT INTO landing_revisions (id, schema_version, config, published_by)
       VALUES ('${E2E_LANDING_REVISION_ID}', 1, $e2e$${json}$e2e$::jsonb, 'e2e')
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config;
     INSERT INTO landing_configs (id, key, draft, published_revision_id, version, updated_at)
       VALUES ('${E2E_LANDING_CONFIG_ID}', 'default', $e2e$${json}$e2e$::jsonb, '${E2E_LANDING_REVISION_ID}', 1, now())
       ON CONFLICT (key) DO UPDATE SET draft = EXCLUDED.draft,
         published_revision_id = EXCLUDED.published_revision_id, updated_at = now();\n`,
  );
}

/**
 * THE PANEL'S LANDING ANSWER, WITH A PUBLISHED LANDING IN ITS TABLES.
 *
 * A panel that still has the builder serves the seeded landing — the proof
 * that the seed is one. A panel that retired it answers `{"enabled":false}`
 * over the very same rows: the one answer every supported cabinet reads as
 * "sign-in on `/`, no landing head" and that makes 0.9.7.53 replace its saved
 * copy (a 404 would have pinned it, D2 §4.1). Its `landing` settings-version
 * group stays, computed from that constant, so a 0.9.7.53 holding a landing
 * re-reads at its next poll; and the builder's admin API is gone.
 */
async function scenarioPanelLandingAnswer(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  seedPublishedLanding();
  const answer = await internalCall<Record<string, unknown>>(ctx, 'GET', '/api/internal/landing-config/effective');
  expectStatus(answer, 200, 'GET /api/internal/landing-config/effective');
  if (!pairHas(pair, 'panel.landing-retired')) {
    assert(
      answer.data['enabled'] === true && landingTitleOf(answer.data) === E2E_LANDING_TITLE,
      `panel ${pair.panel.effective} does not serve the seeded landing: ${JSON.stringify(answer.data).slice(0, 300)}`,
    );
    return `panel ${pair.panel.effective} still has the builder: it serves the seeded landing «${E2E_LANDING_TITLE}»`;
  }
  assert(
    JSON.stringify(answer.data) === JSON.stringify(RETIRED_LANDING),
    `with a published landing in its tables the route answers ${JSON.stringify(answer.data).slice(0, 300)}, not {"enabled":false}`,
  );
  // An empty poll: no consumer and no headers, so the panel files no peer and
  // no report for it — it only answers the versions.
  const polled = await internalCall<{ versions?: Record<string, unknown> }>(ctx, 'POST', '/api/internal/config-versions', {
    body: {},
  });
  expectStatus(polled, 200, 'POST /api/internal/config-versions');
  const version = configVersionOf(RETIRED_LANDING);
  assert(
    polled.data.versions?.['landing'] === version,
    `the landing settings-version group is ${JSON.stringify(polled.data.versions?.['landing'])}, not ${version} (the constant's)`,
  );
  const builder = await ctx.admin.get('/admin/landing-config', { headers: { Authorization: `Bearer ${ctx.bearerToken}` } });
  expectStatus(builder, 404, "GET /api/admin/landing-config (the builder's API)");
  return `{"enabled":false} over a published landing · landing group ${version} · /api/admin/landing-config 404`;
}

/**
 * WHAT THE CABINET SERVES OF A LANDING.
 *
 * Read from the cabinet alone, the way a visitor and the cabinet's own Redis
 * see it, after the hint a panel up to 0.9.7.70 sends on every publish (signed
 * with the relay secret): an old cabinet drops its landing and reads it again
 * at once, the new one only acks it with 204.
 *  - Old panel and old cabinet (the positive control): the landing is still
 *    served, on `/api/v1/landing` and in the head of `/` and `/welcome`.
 *  - A retired panel behind an old cabinet: `/api/v1/landing` is the panel's
 *    `{"enabled":false}`, which the SPA reads as "sign-in on `/`" (its home
 *    page goes to `/welcome` only for `enabled: true` with sections), and the
 *    head carries nothing. On 0.9.7.53 the landing copy saved in Redis, seeded
 *    here as that cabinet left it, is replaced by that answer.
 *  - The new cabinet, with either panel: no `/api/v1/landing` (404, not the
 *    SPA document) and no landing in any head — even while panel 0.9.7.70
 *    serves one (scenario 25) — and its old saved copy is never read or
 *    rewritten.
 * The client-side redirects of the new cabinet (`/` and `/welcome?…` to
 * `/sign-in?…`) run in the browser and are not visible to HTTP; reiwa's
 * `web/test/welcome-alias.test.tsx` holds them.
 */
async function scenarioCabinetLanding(ctx: ScenarioContext): Promise<string> {
  const pair = requirePair(ctx);
  const panelRetired = pairHas(pair, 'panel.landing-retired');
  const cabinetRetired = pairHas(pair, 'cabinet.landing-retired');
  const keepsCopy = pairHas(pair, 'cabinet.saved-copies');
  const shown = !panelRetired && !cabinetRetired;
  const notes: string[] = [];
  // As scenario 25 left it; again, so this one stands alone.
  seedPublishedLanding();

  // The copy a 0.9.7.53 cabinet saved while an old panel served a landing.
  const seededAt = Date.now() - 60_000;
  if (keepsCopy) {
    cabinetRedisSet(
      LANDING_COPY_KEY,
      JSON.stringify({ shape: 1, savedAt: seededAt, hash: configVersionOf(E2E_LANDING), payload: E2E_LANDING }),
    );
  }

  const hint = await sendRelayHint(ctx, 'reiwa.landing.invalidate');
  assert(hint === 204, `a signed reiwa.landing.invalidate got ${hint}, not 204`);
  notes.push('hint → 204');

  const landing = await ctx.reiwa.get<string>('/api/v1/landing', {
    headers: { Accept: 'application/json' },
    responseType: 'text',
  });
  if (cabinetRetired) {
    expectStatus(landing, 404, 'GET reiwa /api/v1/landing');
    // Not the SPA document under an API path — a page left open by 0.9.7.53
    // reads a 404 as "no landing" — and none of the landing.
    assert(!SPA_ROOT.test(landing.data), 'GET reiwa /api/v1/landing answers the SPA document, not a 404 of its own');
    assert(!landing.data.includes(E2E_LANDING_TITLE), 'the 404 of GET reiwa /api/v1/landing carries the landing');
    notes.push('/api/v1/landing 404');
  } else {
    expectStatus(landing, 200, 'GET reiwa /api/v1/landing');
    const body = JSON.parse(landing.data) as Record<string, unknown>;
    if (shown) {
      assert(
        body['enabled'] === true && landingTitleOf(body) === E2E_LANDING_TITLE,
        `the released pair does not show the seeded landing: ${landing.data.slice(0, 300)}`,
      );
      notes.push(`/api/v1/landing «${E2E_LANDING_TITLE}»`);
    } else {
      assert(
        JSON.stringify(body) === JSON.stringify(RETIRED_LANDING),
        `cabinet ${pair.cabinet.effective} serves ${landing.data.slice(0, 300)}, not the panel's {"enabled":false}`,
      );
      notes.push('/api/v1/landing {"enabled":false}');
    }
  }

  // After that read the cabinet holds its answer, so the heads below are
  // written from it without waiting on the panel.
  for (const path of ['/', '/welcome?utm_source=x&ref=y']) {
    const page = await ctx.reiwa.get<string>(path, { headers: { Accept: 'text/html' }, responseType: 'text' });
    expectStatus(page, 200, `GET reiwa ${path}`);
    assert(SPA_ROOT.test(page.data), `GET reiwa ${path} is not the SPA document: ${page.data.slice(0, 200)}`);
    const carries = page.data.includes(E2E_LANDING_TITLE);
    assert(
      carries === shown,
      shown
        ? `${path}: the released pair's head does not carry the landing «${E2E_LANDING_TITLE}»`
        : `${path}: the head carries the retired landing «${E2E_LANDING_TITLE}»`,
    );
    // Uptime monitors and `curl -I` ask with HEAD. Every cabinet up to 0.9.7.53
    // answered it 200 from the landing's own route; with that route gone the
    // document must still answer HEAD as it answers GET (review R1-24).
    const probe = await ctx.reiwa.head(path, { headers: { Accept: 'text/html' } });
    expectStatus(probe, 200, `HEAD reiwa ${path}`);
    assert(
      String(probe.headers['content-type'] ?? '').includes('text/html'),
      `HEAD reiwa ${path} is ${String(probe.headers['content-type'])}, not the document's headers`,
    );
  }
  notes.push(shown ? `/ and /welcome carry «${E2E_LANDING_TITLE}»` : '/ and /welcome carry no landing');
  notes.push('HEAD / and /welcome 200');

  if (keepsCopy) {
    const read = (): { savedAt?: unknown; payload?: { enabled?: unknown } } | null => {
      const raw = cabinetRedisGet(LANDING_COPY_KEY);
      return raw === null ? null : (JSON.parse(raw) as { savedAt?: unknown; payload?: { enabled?: unknown } });
    };
    if (cabinetRetired) {
      const copy = read();
      assert(
        copy?.savedAt === seededAt && copy.payload?.enabled === true,
        `the new cabinet rewrote its old landing copy: ${JSON.stringify(copy).slice(0, 300)}`,
      );
      notes.push('its old landing copy untouched');
    } else {
      // Saved in the background after the read; what the panel said, freshly.
      const deadline = Date.now() + 10_000;
      let copy = read();
      while (!(typeof copy?.savedAt === 'number' && copy.savedAt > seededAt) && Date.now() < deadline) {
        await sleep(250);
        copy = read();
      }
      assert(
        typeof copy?.savedAt === 'number' && copy.savedAt > seededAt && copy.payload?.enabled === shown,
        `cabinet ${pair.cabinet.effective} kept its landing copy (${JSON.stringify(copy).slice(0, 300)}) ` +
          `instead of the panel's ${shown ? 'landing' : '{"enabled":false}'}`,
      );
      notes.push(`its saved copy now ${shown ? 'the landing' : '{"enabled":false}'}`);
    }
  }

  if (panelRetired) {
    const rows = inPanelDatabase(
      `SELECT (SELECT count(*) FROM landing_revisions WHERE id = '${E2E_LANDING_REVISION_ID}') || ' ' ||
              (SELECT count(*) FROM landing_configs WHERE key = 'default' AND published_revision_id = '${E2E_LANDING_REVISION_ID}');\n`,
    ).trim();
    assert(rows === '1 1', `the panel's landing rows are gone (revision, config: ${rows})`);
    notes.push('the landing rows kept');
  }
  if (cabinetRetired) notes.push(await documentNamedAfterOperator(ctx));
  return notes.join(' · ');
}

/**
 * The refusal scenario 27 provokes in EVERY pairing, as its positive control:
 * an internal call with no API token, which `InternalAdminAuthGuard` refuses
 * with 401 in every panel release in the table. A cheap, read-only route.
 */
const CONTROL_REFUSAL = { status: 401, path: '/api/internal/faq' } as const;

/**
 * The panel's refusal line (`AdminSafeExceptionFilter`, the same in every
 * panel release in the table): `requestId=… status=… path=… errorCode=…`.
 */
const REFUSAL_LINE = /requestId=(\S+) status=(4\d\d) path=(\/api\/internal\/[^\s?]*)/g;

/**
 * THE PANEL REFUSED NONE OF THE CABINET'S INTERNAL CALLS.
 *
 * Every 4xx the panel logged on `/api/internal/*` since the stack started,
 * except those this run provoked on purpose. An old panel must not refuse a
 * new cabinet's headers, a new panel must not refuse an old cabinet, and
 * nothing else may slip through as a 400, 401, 403 or 404 the customer never
 * sees. Only the panel's API process: the cabinet calls it and nothing else
 * (`REZEIS_HOST: rezeis-e2e-admin` in the compose file).
 *
 * «Nothing found» proves something only if the check can find a refusal at
 * all (R1-15): were the panel's line renamed or dropped, it would find none
 * and pass. So a known refusal is provoked first, in every pairing, and every
 * provoked refusal of this run — that one, and scenario 21's where it ran —
 * must be seen in the log, by its own request id, before «none other» counts.
 */
async function scenarioNoInternalCallRefused(ctx: ScenarioContext): Promise<string> {
  // What may be refused is the table's to say; outside it, nothing can be judged.
  requirePair(ctx);
  const control = await ctx.admin.request({
    method: 'GET',
    baseURL: REZEIS_BASE,
    url: CONTROL_REFUSAL.path,
    headers: provoke(ctx, CONTROL_REFUSAL.status, CONTROL_REFUSAL.path, 'the control: an internal call with no API token'),
  });
  expectStatus(control, CONTROL_REFUSAL.status, `GET ${CONTROL_REFUSAL.path} with no API token (the control)`);

  const ownRun = `e2e-provoked-${ctx.runId}-`;
  const read = (): Array<{ requestId: string; status: number; path: string }> => {
    const logs = composeRun(['logs', '--no-color', 'rezeis-e2e-admin']);
    assert(logs.code === 0, `docker compose logs exited ${logs.code}: ${logs.stderr.trim()}`);
    // The panel colours its lines itself, whatever compose is told.
    const text = logs.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    return [...text.matchAll(REFUSAL_LINE)].map((m) => ({ requestId: m[1]!, status: Number(m[2]), path: m[3]! }));
  };
  // A line reaches `docker compose logs` a moment after the answer.
  let refusals = read();
  for (let waited = 0; waited < 10_000 && !refusals.some((r) => r.requestId === ctx.expectedRefusals.at(-1)!.requestId); waited += 500) {
    await sleep(500);
    refusals = read();
  }

  const unseen = [...ctx.expectedRefusals];
  const unexpected: string[] = [];
  let earlierRuns = 0;
  for (const refusal of refusals) {
    if (refusal.requestId.startsWith(ownRun)) {
      const at = unseen.findIndex(
        (e) => e.requestId === refusal.requestId && e.status === refusal.status && e.path === refusal.path,
      );
      if (at === -1) unexpected.push(`${refusal.status} ${refusal.path} (${refusal.requestId}, not as provoked)`);
      else unseen.splice(at, 1);
    } else if (refusal.requestId.startsWith('e2e-provoked-')) {
      // An earlier run's provocation, on a stack kept alive between runs.
      earlierRuns++;
    } else {
      unexpected.push(`${refusal.status} ${refusal.path}`);
    }
  }
  assert(
    unseen.length === 0,
    `provoked refusals missing from the panel's log (${unseen.map((e) => `${e.status} ${e.path}: ${e.what}`).join('; ')}): ` +
      'the check cannot see refusals (the refusal line changed?), or the call never reached the panel',
  );
  assert(unexpected.length === 0, `the panel refused internal calls: ${unexpected.join('; ')}`);
  const provoked = ctx.expectedRefusals.length - 1;
  return (
    `control ${CONTROL_REFUSAL.status} ${CONTROL_REFUSAL.path} seen in the log · ` +
    (provoked === 0 ? 'no other refusal provoked' : `${provoked} other provoked refusal(s) seen`) +
    ' · nothing else refused' +
    (earlierRuns > 0 ? ` · ${earlierRuns} from earlier runs on this stack ignored` : '')
  );
}

// ── Scenario list ──────────────────────────────────────────────────────────

// The tag of each entry is argued in `ScenarioTag` above. The doubtful ones:
//   03 checks the panel's token API. The token the CABINET uses is minted by
//      run-e2e.mts in every run, before the cabinet starts, and 14 and 15
//      prove it works; 03 would add only a panel-alone check to a mixed run.
//   05 Login Guard is sign-in, but the panel's alone: no cabinet takes part.
//   12 Update checker reads the cabinet's version in the panel, but asserts
//      only the panel's own; a check of the cabinet's belongs in `core`.
//   16 touches the cabinet only, and is `core` because the refusal must hold
//      whatever panel is on the other side.
//   17 is the relay contract itself: a mixed pair that loses it serves a
//      saved setting a minute late, which is what an operator notices.
//   18-21 are the money surface a subscriber meets, and the order boxes of
//      pair releases are mostly about it: `core`, with each pairing's
//      expectations read off the pair table.
//   22-24 are what each half knows about the other, and the gate that knowing
//      drives. A scenario that does not apply to a pairing (an old panel keeps
//      no peer records) skips with that reason; it never passes vacuously.
//   25-26 are the retired web landing: either half may be updated first, and
//      an operator on any pairing must see no landing, and no old copy of one.
//   27 runs last: it reads the whole run's panel log.
const SCENARIOS: Array<{
  name: string;
  tag: ScenarioTag;
  run: (ctx: ScenarioContext) => Promise<string>;
}> = [
  { name: '01 · Bootstrap admin', tag: 'core', run: scenarioBootstrap },
  { name: '02 · Auth /me', tag: 'core', run: scenarioAuthMe },
  { name: '03 · API token', tag: 'pair', run: scenarioApiToken },
  { name: '04 · Phase 5 · 2FA enroll', tag: 'pair', run: scenarioTwoFactorEnroll },
  { name: '05 · Phase 5 · Login Guard', tag: 'pair', run: scenarioLoginGuard },
  { name: '06 · Phase 5 · IP Allowlist CRUD', tag: 'pair', run: scenarioIpAllowlist },
  { name: '07 · Phase 6 · Webhook delivery roundtrip', tag: 'pair', run: scenarioWebhookSubscriptionRoundtrip },
  { name: '08 · Phase 7 · Analytics', tag: 'pair', run: scenarioAnalytics },
  { name: '09 · Phase 8 · Config export/import', tag: 'pair', run: scenarioConfigPortability },
  { name: '10 · Phase 8 · System logs', tag: 'pair', run: scenarioSystemLogs },
  { name: '11 · Phase 8 · Bulk users', tag: 'pair', run: scenarioBulkUsers },
  { name: '12 · Phase 9 · Update checker', tag: 'pair', run: scenarioUpdateChecker },
  { name: '13 · Reiwa · Health', tag: 'core', run: scenarioReiwaHealth },
  { name: '14 · Reiwa · Branding/public-config proxy', tag: 'core', run: scenarioReiwaProxiesBranding },
  { name: '15 · Reiwa · Plans proxy', tag: 'core', run: scenarioReiwaPlansProxy },
  { name: '16 · Relay · Forged webhook refused', tag: 'core', run: scenarioRelayRefusesForgedEvents },
  { name: '17 · Relay · Branding save reaches the cabinet', tag: 'core', run: scenarioRelayCarriesBrandingToCabinet },
  { name: '18 · Money · Subscriber signs in on the cabinet', tag: 'core', run: scenarioSubscriberSignsInOnCabinet },
  { name: '19 · Money · Subscription on a monthly-reset plan', tag: 'core', run: scenarioSubscriptionOnMonthlyResetPlan },
  { name: '20 · Money · Add-on «до сброса» offered by the cabinet', tag: 'core', run: scenarioAddOnOfferedByCabinet },
  { name: '21 · Money · Add-on checkout without a provider', tag: 'core', run: scenarioAddOnCheckoutWithoutProvider },
  { name: '22 · Pair · The panel knows its cabinet', tag: 'core', run: scenarioPanelKnowsItsCabinet },
  { name: '23 · Pair · The «до сброса» gate asked directly', tag: 'core', run: scenarioPanelGateAskedDirectly },
  { name: '24 · Pair · The cabinet knows its panel', tag: 'core', run: scenarioCabinetKnowsItsPanel },
  { name: '25 · Landing · What the panel answers', tag: 'core', run: scenarioPanelLandingAnswer },
  { name: '26 · Landing · What the cabinet serves', tag: 'core', run: scenarioCabinetLanding },
  { name: '27 · Pair · No internal call refused', tag: 'core', run: scenarioNoInternalCallRefused },
];

/** Without these nothing else can run, so they abort the run when they fail. */
const BLOCKERS: ReadonlyArray<(ctx: ScenarioContext) => Promise<string>> = [scenarioBootstrap, scenarioAuthMe];

function readSelection(): Selection {
  const raw = (process.env.E2E_SCENARIOS ?? '').trim() || 'all';
  if (raw !== 'all' && raw !== 'core') {
    throw new Error(`E2E_SCENARIOS must be "all" or "core", not "${raw}"`);
  }
  return raw;
}

/**
 * SCENARIOS IS HAND-MAINTAINED, AND A HAND-MAINTAINED LIST DRIFTS.
 *
 * A scenario that is written but not appended costs nothing to write, passes
 * review, and runs nowhere: the summary still says 15/15 because 15 is what
 * the list holds. There is no test process here to put the rule in — the
 * runner IS the process — so it reads its own source before the first request
 * and refuses to start when the two disagree.
 *
 * Reading the source works because `tsx` executes this file from disk; a
 * bundled build would have to carry the list another way.
 */
function assertEveryScenarioIsRegistered(): void {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // Both shapes: a declaration and a `const` bound to an arrow function.
  const declared = Array.from(
    source.matchAll(/^(?:async function|const)\s+(scenario[A-Za-z0-9_]*)\b/gm),
    (m) => m[1],
  );

  // Anti-emptiness. If the pattern ever stops matching — the file is bundled,
  // the naming convention changes — every check below agrees with itself about
  // nothing and this function becomes decoration.
  assert(
    declared.length >= 10,
    `found ${declared.length} scenario functions in the source; the detection is broken`,
  );

  const registered = SCENARIOS.map((s) => s.run.name);

  const unregistered = declared.filter((name) => !registered.includes(name));
  assert(
    unregistered.length === 0,
    `these scenarios are written but never run — add them to SCENARIOS: ${unregistered.join(', ')}`,
  );

  // The other direction: a function renamed in place leaves the list pointing
  // at a name the file no longer declares.
  const orphaned = registered.filter((name) => !declared.includes(name));
  assert(
    orphaned.length === 0,
    `SCENARIOS names functions this file does not declare: ${orphaned.join(', ')}`,
  );

  const twice = registered.filter((name, i) => registered.indexOf(name) !== i);
  assert(twice.length === 0, `registered more than once: ${twice.join(', ')}`);

  const labels = new Set(SCENARIOS.map((s) => s.name));
  assert(labels.size === SCENARIOS.length, 'two scenarios share a display name');

  // A tag the filter does not know runs in no selection but `all`, silently.
  const untagged = SCENARIOS.filter((s) => s.tag !== 'core' && s.tag !== 'pair').map((s) => s.name);
  assert(untagged.length === 0, `scenarios without a known tag: ${untagged.join(', ')}`);

  // A `core` run that cannot sign in fails on its first request with nothing
  // to say about the pair. The blockers are therefore `core` by construction.
  const blockersOutsideCore = SCENARIOS.filter((s) => BLOCKERS.includes(s.run) && s.tag !== 'core');
  assert(
    blockersOutsideCore.length === 0,
    `a blocking scenario must be core: ${blockersOutsideCore.map((s) => s.name).join(', ')}`,
  );
  assert(
    SCENARIOS.filter((s) => s.tag === 'core').length > BLOCKERS.length,
    'a core run would check nothing past signing in',
  );

  // A `next`-only feature with no probe would be assumed of any other half's
  // `:main`, the false red R1-03 is about.
  const unprobed = (Object.keys(PAIR_FEATURES) as PairFeature[]).filter((feature) => {
    const since: string = PAIR_FEATURES[feature].since;
    return since === 'next' && NEXT_PROBES[feature] === undefined;
  });
  assert(unprobed.length === 0, `next-only pair features without a probe in NEXT_PROBES: ${unprobed.join(', ')}`);
}

// ── Runner ─────────────────────────────────────────────────────────────────

/** The outcome of every scenario, and what the pairing notes say, for run-e2e.mts and the CI job summary. */
function writeResults(selection: Selection, results: readonly ScenarioResult[], notes: readonly string[]): void {
  const file = process.env.E2E_RESULTS_FILE;
  if (!file) return;
  writeFileSync(file, `${JSON.stringify({ selection, scenarios: results, notes }, null, 2)}\n`);
}

async function main(): Promise<void> {
  console.log(`${colors.cyan}──────────────────────────────────────────────────────────${colors.reset}`);
  console.log(`${colors.cyan}  rezeis-admin ↔ reiwa  ·  E2E smoke runner${colors.reset}`);
  console.log(`${colors.cyan}──────────────────────────────────────────────────────────${colors.reset}`);
  console.log(`${colors.dim}admin: ${REZEIS_BASE}${colors.reset}`);
  console.log(`${colors.dim}reiwa: ${REIWA_BASE}${colors.reset}`);
  console.log('');

  const selection = readSelection();
  assertEveryScenarioIsRegistered();
  const selected = SCENARIOS.filter((s) => selection === 'all' || s.tag === selection);
  console.log(
    `${colors.dim}${SCENARIOS.length} scenarios declared, ${SCENARIOS.length} registered · ` +
      `running ${selection}: ${selected.length} of ${SCENARIOS.length}${colors.reset}`,
  );
  console.log('');

  const ctx: ScenarioContext = {
    admin: axios.create({
      baseURL: `${REZEIS_BASE}/api`,
      timeout: 30_000,
      validateStatus: (s) => s < 500,
    }),
    reiwa: axios.create({
      baseURL: REIWA_BASE,
      timeout: 30_000,
      validateStatus: (s) => s < 500,
      withCredentials: false,
    }),
    bearerToken: '',
    apiToken: null,
    apiTokenId: null,
    webhookSubscriptionId: null,
    webhookSubscriptionSecret: null,
    ipAllowlistEntryId: null,
    pair: null,
    pairProblem: null,
    subscriber: null,
    money: null,
    offer: null,
    directToken: null,
    runId: randomUUID().replace(/-/g, '').slice(0, 12),
    expectedRefusals: [],
  };

  // The pairing, once, before anything is changed: the scenarios that read
  // the pair table need it, and a CI log needs to say what was paired.
  try {
    ctx.pair = await resolvePair(ctx);
    const table = (Object.keys(PAIR_FEATURES) as PairFeature[])
      .map((feature) => `${feature} ${pairHas(ctx.pair!, feature) ? 'yes' : 'no'}`)
      .join(' · ');
    console.log(
      `${colors.cyan}pair: panel ${describeHalf(ctx.pair.panel)} ↔ cabinet ${describeHalf(ctx.pair.cabinet)}${colors.reset}`,
    );
    console.log(`${colors.dim}      ${ctx.pair.outside ?? table}${colors.reset}`);
    for (const note of ctx.pair.notes) console.log(`${colors.yellow}      note: ${note}${colors.reset}`);
  } catch (err) {
    ctx.pairProblem = describeAxiosError(err);
    console.log(`${colors.yellow}pair: unknown — ${ctx.pairProblem}${colors.reset}`);
  }
  console.log('');

  const results: ScenarioResult[] = [];
  let aborted = false;
  for (const sc of SCENARIOS) {
    if (!selected.includes(sc)) {
      results.push({
        name: sc.name,
        tag: sc.tag,
        status: 'skip',
        durationMs: 0,
        note: `${sc.tag} only; this run is ${selection}`,
      });
      console.log(`${colors.dim}SKIP ${sc.name}  (${sc.tag})${colors.reset}`);
      continue;
    }
    if (aborted) {
      results.push({ name: sc.name, tag: sc.tag, status: 'fail', durationMs: 0, error: 'aborted (previous failure)' });
      continue;
    }
    const start = Date.now();
    try {
      const note = await sc.run(ctx);
      const ms = Date.now() - start;
      results.push({ name: sc.name, tag: sc.tag, status: 'pass', durationMs: ms, note });
      console.log(`${fmt(true, 'PASS')} ${sc.name}  ${colors.dim}(${ms}ms)${colors.reset}  ${colors.dim}${note}${colors.reset}`);
    } catch (err) {
      const ms = Date.now() - start;
      if (err instanceof ScenarioSkip) {
        results.push({ name: sc.name, tag: sc.tag, status: 'skip', durationMs: ms, note: err.message });
        console.log(`${colors.yellow}SKIP ${sc.name}  (${err.message})${colors.reset}`);
        continue;
      }
      const message = describeAxiosError(err);
      results.push({ name: sc.name, tag: sc.tag, status: 'fail', durationMs: ms, error: message });
      console.log(`${fmt(false, 'FAIL')} ${sc.name}  ${colors.dim}(${ms}ms)${colors.reset}`);
      console.log(`        ${colors.red}${message}${colors.reset}`);
      // Only the very early stages (1-2) are blockers — without auth
      // nothing else can run. Past that, keep going to maximise the
      // signal in a single run.
      if (BLOCKERS.includes(sc.run)) {
        aborted = true;
      }
    }
  }
  writeResults(selection, results, [
    ...(ctx.pair?.notes ?? []),
    ...(ctx.pair?.outside ? [`outside the pair table: ${ctx.pair.outside}`] : []),
    ...(ctx.pairProblem ? [`the pair could not be read: ${ctx.pairProblem}`] : []),
  ]);

  console.log('');
  console.log(`${colors.cyan}── Summary ──${colors.reset}`);
  const ran = results.filter((r) => r.status !== 'skip');
  const passed = ran.filter((r) => r.status === 'pass').length;
  const failed = ran.length - passed;
  const skipped = results.length - ran.length;
  console.log(
    `${fmt(failed === 0, `${passed}/${ran.length}`)} ${selection === 'core' ? 'core ' : ''}scenarios passed` +
      (skipped > 0 ? `${colors.dim} · ${skipped} skipped${colors.reset}` : ''),
  );
  if (failed > 0) {
    for (const r of ran.filter((x) => x.status === 'fail')) {
      console.log(`  ${colors.red}× ${r.name}: ${r.error}${colors.reset}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Runner crashed:', err);
  process.exit(2);
});
