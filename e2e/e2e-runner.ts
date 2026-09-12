/**
 * End-to-end smoke runner for the rezeis-admin ↔ reiwa pair.
 *
 * The runner assumes the docker-compose.e2e.yml stack is up; it does NOT
 * manage container lifecycle (that's `run-e2e.ps1`). It walks through a
 * sequence of "scenarios" — each scenario is a small named function that
 * either resolves (pass) or throws (fail). The script prints a coloured
 * summary at the end and exits with a non-zero status on any failure.
 *
 * Stages
 *   1. Bootstrap — register the very first DEV admin via /admin/auth/register.
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
 *
 * Add new scenarios as plain functions and append them to SCENARIOS. Forgetting
 * the second half is caught before the first request goes out — see
 * `assertEveryScenarioIsRegistered`.
 */

import { readFileSync } from 'node:fs';
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
}

interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
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
    return `[${status}] ${body}`;
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
  // Reuse the existing token if present (idempotency on re-run).
  const list = await ctx.admin.get<{ items: Array<{ id: string; name: string }> }>(
    '/admin/api-tokens',
    { headers: auth },
  );
  expectStatus(list, 200, 'GET /admin/api-tokens');
  const existing = (list.data.items ?? []).find((t) => t.name === 'reiwa-e2e');
  if (existing) {
    ctx.apiTokenId = existing.id;
    // We can't recover the original token from the list response; the
    // smoke caller passes a fresh token via `REZEIS_TOKEN` already.
    return `reused existing token (${existing.id})`;
  }
  const created = await ctx.admin.post<{ id: string; token: string }>(
    '/admin/api-tokens',
    { name: 'reiwa-e2e' },
    { headers: auth },
  );
  expectStatus(created, 201, 'POST /admin/api-tokens');
  ctx.apiToken = created.data.token;
  ctx.apiTokenId = created.data.id;
  return `issued ${created.data.id}`;
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
  const ltv = await ctx.admin.get<{ buckets: Array<{ bound: number; users: number }> }>(
    '/admin/analytics/ltv-distribution',
    { headers: auth },
  );
  expectStatus(ltv, 200, 'GET /admin/analytics/ltv-distribution');
  assert(ltv.data.buckets.length >= 8, 'expected at least 8 LTV buckets');
  return `overview ${overview.data.kpis.windowDays}d · cohorts=${cohorts.data.cohorts.length} · top=${top.data.payers.length} · ltv=${ltv.data.buckets.length}`;
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

// ── Scenario list ──────────────────────────────────────────────────────────

const SCENARIOS: Array<{ name: string; run: (ctx: ScenarioContext) => Promise<string> }> = [
  { name: '01 · Bootstrap admin', run: scenarioBootstrap },
  { name: '02 · Auth /me', run: scenarioAuthMe },
  { name: '03 · API token', run: scenarioApiToken },
  { name: '04 · Phase 5 · 2FA enroll', run: scenarioTwoFactorEnroll },
  { name: '05 · Phase 5 · Login Guard', run: scenarioLoginGuard },
  { name: '06 · Phase 5 · IP Allowlist CRUD', run: scenarioIpAllowlist },
  { name: '07 · Phase 6 · Webhook delivery roundtrip', run: scenarioWebhookSubscriptionRoundtrip },
  { name: '08 · Phase 7 · Analytics', run: scenarioAnalytics },
  { name: '09 · Phase 8 · Config export/import', run: scenarioConfigPortability },
  { name: '10 · Phase 8 · System logs', run: scenarioSystemLogs },
  { name: '11 · Phase 8 · Bulk users', run: scenarioBulkUsers },
  { name: '12 · Phase 9 · Update checker', run: scenarioUpdateChecker },
  { name: '13 · Reiwa · Health', run: scenarioReiwaHealth },
  { name: '14 · Reiwa · Branding/public-config proxy', run: scenarioReiwaProxiesBranding },
  { name: '15 · Reiwa · Plans proxy', run: scenarioReiwaPlansProxy },
];

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
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`${colors.cyan}──────────────────────────────────────────────────────────${colors.reset}`);
  console.log(`${colors.cyan}  rezeis-admin ↔ reiwa  ·  E2E smoke runner${colors.reset}`);
  console.log(`${colors.cyan}──────────────────────────────────────────────────────────${colors.reset}`);
  console.log(`${colors.dim}admin: ${REZEIS_BASE}${colors.reset}`);
  console.log(`${colors.dim}reiwa: ${REIWA_BASE}${colors.reset}`);
  console.log('');

  assertEveryScenarioIsRegistered();
  console.log(
    `${colors.dim}${SCENARIOS.length} scenarios declared, ${SCENARIOS.length} registered${colors.reset}`,
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
  };

  const results: ScenarioResult[] = [];
  let aborted = false;
  for (const sc of SCENARIOS) {
    if (aborted) {
      results.push({ name: sc.name, ok: false, durationMs: 0, error: 'aborted (previous failure)' });
      continue;
    }
    const start = Date.now();
    try {
      const note = await sc.run(ctx);
      const ms = Date.now() - start;
      results.push({ name: sc.name, ok: true, durationMs: ms, note });
      console.log(`${fmt(true, 'PASS')} ${sc.name}  ${colors.dim}(${ms}ms)${colors.reset}  ${colors.dim}${note}${colors.reset}`);
    } catch (err) {
      const ms = Date.now() - start;
      const message = describeAxiosError(err);
      results.push({ name: sc.name, ok: false, durationMs: ms, error: message });
      console.log(`${fmt(false, 'FAIL')} ${sc.name}  ${colors.dim}(${ms}ms)${colors.reset}`);
      console.log(`        ${colors.red}${message}${colors.reset}`);
      // Only the very early stages (1-2) are blockers — without auth
      // nothing else can run. Past that, keep going to maximise the
      // signal in a single run.
      if (sc.run === scenarioBootstrap || sc.run === scenarioAuthMe) {
        aborted = true;
      }
    }
  }

  console.log('');
  console.log(`${colors.cyan}── Summary ──${colors.reset}`);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`${fmt(failed === 0, `${passed}/${results.length}`)} scenarios passed`);
  if (failed > 0) {
    for (const r of results.filter((x) => !x.ok)) {
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
