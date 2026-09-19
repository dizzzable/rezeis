import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { SubscriptionStatus, SyncAction, SyncJobStatus } from '@prisma/client';

import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';
import { RemnawaveProfileNamingService } from '../src/modules/profile-sync/remnawave-profile-naming.service';
import { PanelCommandExecutor } from '../src/modules/remnawave/services/panel-command.executor';
import { AxiosPanelTransport } from '../src/modules/remnawave/services/panel-transport';
import { PanelUsersClient } from '../src/modules/remnawave/services/panel-users.client';

/**
 * The CREATE path's name lookups, end to end: the REAL naming service, the REAL
 * panel client and its contract schemas, and a fake Remnawave that keys
 * profiles by exact, case-sensitive username — which is what the panel does.
 *
 * What is being defended:
 *  • the owner's rule of 18.09.2026 names a NEW profile after the Telegram
 *    @username, so a subscription created under the old login-first rule now
 *    computes a DIFFERENT name. Every lookup that finds an existing profile by
 *    name must still find the old one instead of minting a duplicate;
 *  • a name another customer's profile holds must end with a distinct name for
 *    this customer — never with adopting the other profile, never with this
 *    customer unprovisioned — and the same name on every retry;
 *  • a CREATE that was interrupted after the panel made the profile must find
 *    THAT profile on the retry, whatever changed in between: the name it chose
 *    is recorded before the POST and asked for first;
 *  • a profile the CREATE path adopts carries whatever state it had, so it is
 *    brought to the subscription's desired state exactly as an UPDATE would.
 */

const USER_A = 'cmauser0000000000000000a1';
const USER_B = 'cmbuser0000000000000000b1';
const USER_C = 'cmcuser0000000000000000c1';

interface PanelProfile {
  readonly id: number;
  readonly username: string;
  description: string | null;
  readonly subscriptionUrl: string;
  readonly createdAt: string;
}

/** A Remnawave that answers the user routes the processor calls. */
class FakePanel {
  public readonly profiles = new Map<string, PanelProfile>();
  public readonly lookups: string[] = [];
  public readonly creates: Array<Record<string, unknown>> = [];
  public readonly patches: Array<Record<string, unknown>> = [];
  /** Every call, and every recorded name the database took, in order. */
  public readonly log: string[] = [];
  /** Commit the next N POSTs but answer them with a dropped connection. */
  public loseNextCreateResponse = 0;
  /** A status to answer a lookup of a given name with, instead of the truth. */
  public readonly lookupOverride = new Map<string, { status: number; data: unknown }>();
  /** Profiles whose PATCH answers the panel's own "not found". */
  public readonly patchMissing = new Set<number>();
  /** Runs on every lookup, before it is answered. */
  public onLookup: ((username: string) => void) | null = null;
  private nextId = 9001;

  public add(username: string, description: string | null, id?: number): PanelProfile {
    const profile: PanelProfile = {
      id: id ?? this.nextId++,
      username,
      description,
      subscriptionUrl: `https://sub.example/${username}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    this.profiles.set(username, profile);
    return profile;
  }

  public client(): PanelUsersClient {
    return new PanelUsersClient(
      new PanelCommandExecutor(
        new AxiosPanelTransport(
          {
            request: (config: { method: string; url: string; data?: unknown }) => {
              const outcome = this.respond(config.method.toLowerCase(), config.url, config.data);
              if (outcome.status === -1) {
                return throwError(() => ({ isAxiosError: true, code: 'ECONNRESET', message: 'socket hang up' }));
              }
              if (outcome.status >= 200 && outcome.status < 300) return of({ data: outcome.data });
              return throwError(() => ({
                isAxiosError: true,
                response: { status: outcome.status, headers: {}, data: outcome.data },
                message: `Request failed with status code ${outcome.status}`,
              }));
            },
          } as never,
          { host: 'remnawave', port: 3000, token: 'secret' },
        ),
      ),
    );
  }

  private respond(method: string, url: string, body: unknown): { status: number; data: unknown } {
    const byUsername = '/api/users/by-username/';
    if (method === 'get' && url.startsWith(byUsername)) {
      const username = decodeURIComponent(url.slice(byUsername.length));
      this.lookups.push(username);
      this.log.push(`GET ${username}`);
      this.onLookup?.(username);
      const override = this.lookupOverride.get(username);
      if (override !== undefined) return override;
      const profile = this.profiles.get(username);
      return profile === undefined
        ? { status: 404, data: { errorCode: 'A063', message: 'User with specified params not found' } }
        : { status: 200, data: { response: { ...profile } } };
    }
    if (method === 'post' && url === '/api/users/') {
      const created = body as Record<string, unknown>;
      this.creates.push(created);
      const username = String(created['username']);
      this.log.push(`POST ${username}`);
      if (this.profiles.has(username)) {
        return { status: 400, data: { errorCode: 'A019', message: 'User username already exists' } };
      }
      const profile = this.add(username, (created['description'] as string | undefined) ?? null);
      if (this.loseNextCreateResponse > 0) {
        this.loseNextCreateResponse -= 1;
        return { status: -1, data: null };
      }
      return { status: 201, data: { response: { ...profile } } };
    }
    if (method === 'patch' && url === '/api/users/') {
      const patch = body as Record<string, unknown>;
      this.patches.push(patch);
      this.log.push(`PATCH ${String(patch['id'])}`);
      const profile = [...this.profiles.values()].find((row) => row.id === patch['id']);
      if (profile === undefined || this.patchMissing.has(profile.id)) {
        return { status: 404, data: { errorCode: 'A025', message: 'User not found' } };
      }
      if (typeof patch['description'] === 'string') profile.description = patch['description'];
      return { status: 200, data: { response: { ...profile } } };
    }
    return { status: 500, data: { message: `unexpected ${method} ${url}` } };
  }
}

interface SubscriptionRow {
  readonly id: string;
  readonly userId: string;
  readonly remnawaveId: string | null;
  readonly remnawavePanelId: number | null;
  readonly remnawavePanelUsername: string | null;
  readonly status: SubscriptionStatus;
}

interface Scenario {
  readonly panel: FakePanel;
  readonly user: {
    readonly login?: string;
    readonly username?: string | null;
    readonly telegramId?: bigint | null;
    /**
     * The pair the Telegram bootstrap writes (`telegram_username`,
     * `telegram_username_tg_id`). Absent: what the bootstrap wrote for
     * `username` on `telegramId`. `null`: no /start or Mini App sign-in has
     * reached this account since the columns exist.
     */
    readonly verifiedTelegram?: { readonly username: string | null; readonly tgId: bigint | null } | null;
  };
  /** The subscription being provisioned. Always `sub-b-0`, owned by USER_B. */
  readonly subscription?: Partial<
    Pick<SubscriptionRow, 'remnawaveId' | 'remnawavePanelId' | 'remnawavePanelUsername'>
  > & {
    readonly remnawavePendingUsername?: string | null;
    readonly remnawavePendingOwnerId?: string | null;
  };
  /** Every OTHER subscription row in the database (holders, other customers). */
  readonly others?: readonly SubscriptionRow[];
  readonly action?: SyncAction;
  readonly payload?: Record<string, unknown>;
  /** The owner's `isBlocked`. */
  readonly blocked?: boolean;
  readonly branding?: unknown;
  /** Makes the first N link writes fail, like a worker dying after the panel answered. */
  readonly failLinkWrites?: number;
}

interface MutableUser {
  id: string;
  username: string | null;
  name: string;
  telegramId: bigint | null;
  email: string | null;
  telegramUsername: string | null;
  telegramUsernameTgId: bigint | null;
  webAccount: { login: string | null; email: string | null; emailNormalized: string | null } | null;
}

interface MutableSubscription {
  id: string;
  userId: string;
  user: { isBlocked: boolean };
  remnawaveId: string | null;
  remnawavePanelId: number | null;
  remnawavePanelUsername: string | null;
  remnawavePendingUsername: string | null;
  remnawavePendingOwnerId: string | null;
  configUrl: string | null;
  trafficLimit: number;
  deviceLimit: number;
  internalSquads: string[];
  externalSquad: string | null;
  expiresAt: Date;
  planSnapshot: Record<string, unknown>;
  status: SubscriptionStatus;
  isTrial: boolean;
}

interface Harness {
  readonly run: () => Promise<void>;
  readonly linkWrites: Array<{ where: unknown; data: Record<string, unknown> }>;
  readonly otherWrites: unknown[];
  readonly failures: Array<{ data: { lastError?: string; recoveryData?: { classification?: string } } }>;
  readonly completed: () => number;
  /** The customer as the database holds them NOW — change it between attempts. */
  readonly user: MutableUser;
  /** The row as the database holds it NOW — every write lands here. */
  readonly subscription: MutableSubscription;
  readonly branding: { value: unknown };
  /** What reached the operator: `SystemEventsService.warn` / `.error`. */
  readonly notices: Array<{ level: string; message: string; meta: Record<string, unknown> }>;
  /** The processor's warning log lines. */
  readonly logWarnings: string[];
}

/** Prisma's `data`: `undefined` leaves a column alone, anything else is written. */
function apply(row: object, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) (row as Record<string, unknown>)[key] = value;
  }
}

function harness(scenario: Scenario): Harness {
  const linkWrites: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const otherWrites: unknown[] = [];
  const failures: Harness['failures'] = [];
  let completed = 0;
  let linkFailuresLeft = scenario.failLinkWrites ?? 0;
  const branding = { value: scenario.branding };

  const telegramId = scenario.user.telegramId ?? null;
  const username = scenario.user.username ?? null;
  const verified =
    scenario.user.verifiedTelegram === undefined
      ? telegramId === null
        ? null
        : { username, tgId: telegramId }
      : scenario.user.verifiedTelegram;
  const user: MutableUser = {
    id: USER_B,
    username,
    name: 'Bob',
    telegramId,
    email: null,
    telegramUsername: verified?.username ?? null,
    telegramUsernameTgId: verified?.tgId ?? null,
    webAccount: scenario.user.login === undefined ? null : { login: scenario.user.login, email: null, emailNormalized: null },
  };
  const subscription: MutableSubscription = {
    id: 'sub-b-0',
    userId: USER_B,
    user: { isBlocked: scenario.blocked ?? false },
    remnawaveId: scenario.subscription?.remnawaveId ?? null,
    remnawavePanelId: scenario.subscription?.remnawavePanelId ?? null,
    remnawavePanelUsername: scenario.subscription?.remnawavePanelUsername ?? null,
    remnawavePendingUsername: scenario.subscription?.remnawavePendingUsername ?? null,
    remnawavePendingOwnerId: scenario.subscription?.remnawavePendingOwnerId ?? null,
    configUrl: null,
    trafficLimit: 10,
    deviceLimit: 3,
    internalSquads: [],
    externalSquad: null,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    planSnapshot: {},
    status: SubscriptionStatus.ACTIVE,
    isTrial: false,
  };
  const others = scenario.others ?? [];

  const matches = (row: SubscriptionRow, claim: Record<string, unknown>): boolean =>
    Object.entries(claim).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value);

  const prisma = {
    profileSyncJob: {
      findUnique: async () => ({
        id: 'sync-job-b',
        action: scenario.action ?? SyncAction.CREATE,
        status: SyncJobStatus.PENDING,
        attempts: 0,
        supersededAt: null,
        createdAt: new Date(),
        payload: scenario.payload ?? {},
        aggregateKey: null,
        desiredRevision: null,
        subscription,
      }),
      updateMany: async (input: { data: { status?: SyncJobStatus } }) => {
        if (input.data.status === SyncJobStatus.FAILED) failures.push(input as never);
        if (input.data.status === SyncJobStatus.COMPLETED) completed += 1;
        return { count: 1 };
      },
      findMany: async () => [],
    },
    user: { findUnique: async () => user },
    settings: {
      findFirst: async () =>
        branding.value === undefined ? null : { brandingSettings: branding.value },
    },
    subscription: {
      // The naming service: the customer's subscriptions, oldest first.
      findMany: async () => [
        { id: subscription.id, remnawavePanelUsername: subscription.remnawavePanelUsername },
        ...others
          .filter((row) => row.userId === subscription.userId)
          .map((row) => ({ id: row.id, remnawavePanelUsername: row.remnawavePanelUsername })),
      ],
      // The adopt path's holder check.
      findFirst: async (input: {
        where: { id: { not: string }; status: { not: SubscriptionStatus }; OR: Array<Record<string, unknown>> };
      }) =>
        others.find(
          (row) =>
            row.id !== input.where.id.not &&
            row.status !== SubscriptionStatus.DELETED &&
            input.where.OR.some((claim) => matches(row, claim)),
        ) ?? null,
      // Conditional writes on THIS row: every `where` column has to hold.
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        otherWrites.push(input);
        const { id, ...conditions } = input.where;
        if (id !== subscription.id) return { count: 0 };
        const holds = Object.entries(conditions).every(
          ([key, value]) => (subscription as unknown as Record<string, unknown>)[key] === value,
        );
        if (!holds) return { count: 0 };
        apply(subscription, input.data);
        if (typeof input.data['remnawavePendingUsername'] === 'string') {
          scenario.panel.log.push(`record ${input.data['remnawavePendingUsername']}`);
        }
        return { count: 1 };
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      if (linkFailuresLeft > 0) {
        linkFailuresLeft -= 1;
        throw new Error('simulated worker death between the panel CREATE and the link write');
      }
      return callback({
        $executeRaw: async () => 1,
        $queryRaw: async () => [{ status: SubscriptionStatus.ACTIVE }],
        subscription: {
          update: async (input: { where: unknown; data: Record<string, unknown> }) => {
            linkWrites.push(input);
            apply(subscription, input.data);
          },
        },
        subscriptionTerm: { updateMany: async () => ({ count: 0 }) },
        profileSyncJob: { findMany: async () => [], create: async () => ({ id: 'unused-delete-job' }) },
      });
    },
  };

  const notices: Harness['notices'] = [];
  const record = (level: string) => (_type: string, _category: string, message: string, meta: Record<string, unknown>) => {
    notices.push({ level, message, meta });
  };
  const processor = new ProfileSyncProcessor(
    prisma as never,
    scenario.panel.client(),
    new RemnawaveProfileNamingService(prisma as never),
    { error: record('error'), info: () => undefined, warn: record('warn') } as never,
  );
  // The processor's own log lines, where an operator reading the logs looks.
  const logWarnings: string[] = [];
  (processor as unknown as { logger: unknown }).logger = {
    log: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    error: () => undefined,
    warn: (message: unknown) => {
      logWarnings.push(String(message));
    },
  };
  return {
    run: () => processor.process({ data: { syncJobId: 'sync-job-b' } } as never),
    linkWrites,
    otherWrites,
    failures,
    completed: () => completed,
    user,
    subscription,
    branding,
    notices,
    logWarnings,
  };
}

const MARKER_B = `name: Bob\nlogin: john\nreiwa_id: ${USER_B}`;
const MARKER_A = `name: Alice\nreiwa_id: ${USER_A}`;

/** Customer B: web login `john`, Telegram linked with the @username `johnny`. */
const B_WITH_TELEGRAM = { login: 'john', telegramId: 555000111n, username: 'johnny' } as const;

// ═════════════════════════════════════════════════════════════════════════════
//  Item 2 — a different name for an EXISTING subscription must not duplicate it
// ═════════════════════════════════════════════════════════════════════════════

describe('CREATE finds the profile a subscription already has under an older name', () => {
  it('a CREATE retried after the customer linked Telegram adopts the profile made under the login-first name', async () => {
    // The first attempt ran under the old rule and died after the panel
    // answered. The customer linked Telegram in between, so the rule now says
    // `rz_johnny_sub` — looking up only that would mint a second profile and
    // leave the first one running with nobody's link on it.
    const panel = new FakePanel();
    panel.add('rz_john_sub', MARKER_B, 501);
    const run = harness({ panel, user: B_WITH_TELEGRAM });

    await run.run();

    assert.deepEqual(panel.creates, [], 'no second profile');
    assert.equal(run.linkWrites.length, 1);
    assert.equal(run.linkWrites[0].data['remnawaveId'], '501');
    assert.equal(run.linkWrites[0].data['remnawavePanelUsername'], 'rz_john_sub', 'the profile keeps its name');
  });

  it('a subscription that lost its panel link is re-linked by its STORED name, which neither rule reproduces', async () => {
    // Created when the operator's prefix was `shop`; the prefix is `rz` now.
    // Only the stored `remnawave_panel_username` still names the profile.
    const panel = new FakePanel();
    panel.add('shop_john_sub', MARKER_B, 502);
    const run = harness({
      panel,
      user: B_WITH_TELEGRAM,
      subscription: { remnawavePanelUsername: 'shop_john_sub' },
    });

    await run.run();

    assert.deepEqual(panel.creates, []);
    assert.equal(run.linkWrites[0]?.data['remnawaveId'], '502');
    assert.equal(panel.lookups[0], 'shop_john_sub', 'the stored name is asked first');
  });

  it('does not adopt a profile under the old name that another customer\'s marker names', async () => {
    const panel = new FakePanel();
    panel.add('rz_john_sub', MARKER_A, 503);
    const run = harness({ panel, user: B_WITH_TELEGRAM });

    await run.run();

    assert.deepEqual(run.linkWrites.map((write) => write.data['remnawaveId']), ['9001']);
    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_sub']);
  });

  it('does not adopt a profile under the old name that carries no reiwa_id marker at all', async () => {
    const panel = new FakePanel();
    panel.add('rz_john_sub', 'imported from a donor panel', 504);
    const run = harness({ panel, user: B_WITH_TELEGRAM });

    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_sub']);
    assert.notEqual(run.linkWrites[0]?.data['remnawaveId'], '504');
  });

  it('an UPDATE never sends a username, however the rule now names this customer', async () => {
    // No Remnawave version renames through PATCH, and nothing here may try:
    // the name a linked profile has is the name it keeps.
    const panel = new FakePanel();
    panel.add('rz_john_sub', MARKER_B, 505);
    const run = harness({
      panel,
      user: B_WITH_TELEGRAM,
      action: SyncAction.UPDATE,
      subscription: { remnawaveId: '505', remnawavePanelId: 505, remnawavePanelUsername: 'rz_john_sub' },
    });

    await run.run();

    assert.equal(panel.patches.length, 1);
    assert.equal('username' in panel.patches[0], false, 'a PATCH carrying a username is a rename attempt');
    assert.equal(panel.patches[0]['id'], 505);
    assert.deepEqual(panel.creates, []);
    assert.deepEqual(panel.lookups, [], 'an UPDATE has no reason to look anything up by name');
    assert.deepEqual(run.otherWrites, [], 'the stored name is not rewritten either');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Item 3 — a name another customer holds
// ═════════════════════════════════════════════════════════════════════════════

/** Customer B: no web login, Telegram @username `johnny` — the same name customer A's login gives. */
const B_TELEGRAM_ONLY = { telegramId: 555000111n, username: 'johnny' } as const;

/** Customer A's live subscription on `rz_johnny_sub` (A registered with the login `johnny`). */
const A_HOLDS_JOHNNY: SubscriptionRow = {
  id: 'sub-a-0',
  userId: USER_A,
  remnawaveId: '700',
  remnawavePanelId: 700,
  remnawavePanelUsername: 'rz_johnny_sub',
  status: SubscriptionStatus.ACTIVE,
};

/** Customer A's live row: its own profile is #999, and it still carries the NAME `rz_johnny_sub`. */
const A_CARRIES_STALE_NAME: SubscriptionRow = {
  id: 'sub-x-1',
  userId: USER_A,
  remnawaveId: '999',
  remnawavePanelId: 999,
  remnawavePanelUsername: 'rz_johnny_sub',
  status: SubscriptionStatus.ACTIVE,
};

describe('CREATE when another customer\'s profile holds the name', () => {
  it('provisions B under the first fallback name and leaves A\'s profile alone', async () => {
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_A, 700);
    const run = harness({ panel, user: B_TELEGRAM_ONLY, others: [A_HOLDS_JOHNNY] });

    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_bd4e76_sub']);
    assert.equal(run.linkWrites.length, 1);
    assert.equal(run.linkWrites[0].data['remnawavePanelUsername'], 'rz_johnny_bd4e76_sub');
    assert.notEqual(run.linkWrites[0].data['remnawaveId'], '700', 'A\'s profile is never linked to B');
    assert.equal(run.completed(), 1, 'B is provisioned, not failed');
  });

  it('a retry after the worker died finds B\'s fallback profile instead of creating another', async () => {
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_A, 700);
    const run = harness({
      panel,
      user: B_TELEGRAM_ONLY,
      others: [A_HOLDS_JOHNNY],
      failLinkWrites: 1,
    });

    await assert.rejects(run.run());
    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_bd4e76_sub']);

    await run.run();

    assert.equal(panel.creates.length, 1, 'exactly one profile for B');
    assert.equal(run.linkWrites.length, 1);
    assert.equal(run.linkWrites[0].data['remnawavePanelUsername'], 'rz_johnny_bd4e76_sub');
  });

  it('the retry still finds the fallback profile when A\'s profile has gone in between', async () => {
    // The primary name is free on the retry. Taking it would leave B with two
    // live profiles; the fallback B already has must win.
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_A, 700);
    const run = harness({ panel, user: B_TELEGRAM_ONLY, failLinkWrites: 1 });

    await assert.rejects(run.run());
    panel.profiles.delete('rz_johnny_sub');
    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_bd4e76_sub']);
    assert.equal(run.linkWrites[0]?.data['remnawavePanelUsername'], 'rz_johnny_bd4e76_sub');
  });

  it('never adopts a profile that carries no marker, even when no subscription holds it', async () => {
    // A hand-made or donor profile named like our scheme. Adopting it on
    // "nobody proved it is someone else's" linked B to a stranger's VPN profile.
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', 'created by hand', 710);
    const run = harness({ panel, user: B_TELEGRAM_ONLY });

    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_bd4e76_sub']);
    assert.notEqual(run.linkWrites[0]?.data['remnawaveId'], '710');
  });

  it('never adopts a profile whose display name forges B\'s marker', async () => {
    // A's display name is their own text. `name: reiwa_id: <B>` on A's profile
    // must not read as B's ownership.
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', `name: reiwa_id: ${USER_B}\nreiwa_id: ${USER_A}`, 720);
    const run = harness({ panel, user: B_TELEGRAM_ONLY });

    await run.run();

    assert.notEqual(run.linkWrites[0]?.data['remnawaveId'], '720');
    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_bd4e76_sub']);
  });

  it('moves on to the second fallback when the first is taken too', async () => {
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_A, 700);
    panel.add('rz_johnny_bd4e76_sub', `reiwa_id: ${USER_A}`, 701);
    const run = harness({ panel, user: B_TELEGRAM_ONLY });

    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_johnny_acd089_sub']);
  });

  it('a profile of B\'s that another of B\'s live subscriptions is on is refused — neither adopted nor duplicated', async () => {
    // The holder may be a duplicate row for the same purchase; a new profile
    // would make it a second free subscription. An operator decides.
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_B, 730);
    const run = harness({
      panel,
      user: B_TELEGRAM_ONLY,
      others: [{
        id: 'sub-b-9',
        userId: USER_B,
        remnawaveId: '730',
        remnawavePanelId: 730,
        remnawavePanelUsername: 'rz_johnny_sub',
        status: SubscriptionStatus.ACTIVE,
      }],
    });

    await assert.rejects(run.run(), /already\s+live on it/);

    assert.deepEqual(panel.creates, []);
    assert.deepEqual(run.linkWrites, []);
  });

  it('a profile another row claims does not stop B adopting its own profile found under another name', async () => {
    // Claimed through its IDENTITY — a name alone is no claim (round 4, below).
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_B, 731);
    panel.add('rz_john_sub', MARKER_B, 732);
    const run = harness({
      panel,
      user: B_WITH_TELEGRAM,
      others: [{
        id: 'sub-x-2',
        userId: USER_A,
        remnawaveId: '731',
        remnawavePanelId: 731,
        remnawavePanelUsername: 'rz_johnny_sub',
        status: SubscriptionStatus.ACTIVE,
      }],
    });

    await run.run();

    assert.deepEqual(panel.creates, []);
    assert.equal(run.linkWrites[0]?.data['remnawaveId'], '732');
  });

  it('adopts B\'s own profile although another customer\'s row still carries its NAME — and names that row, once', async () => {
    // Ours by its marker; another customer's live row carries its NAME but
    // names a different profile by id. That name is no claim on it (owner's
    // decision, 19.09.2026): taking a fresh name left B's profile live and
    // unlinked, for the next Remnawave import to turn into a second
    // subscription. The operator is told which row holds the stale name.
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_B, 740);
    const run = harness({ panel, user: B_TELEGRAM_ONLY, others: [A_CARRIES_STALE_NAME] });

    await run.run();

    assert.deepEqual(panel.creates, [], 'no second profile');
    assert.deepEqual(run.linkWrites.map((write) => write.data['remnawaveId']), ['740']);
    assert.equal(run.completed(), 1, 'provisioned, not failed');
    const staleNotices = run.notices.filter((notice) => notice.meta['staleNameSubscriptionId'] !== undefined);
    assert.equal(staleNotices.length, 1, 'one operator notice');
    assert.equal(staleNotices[0].meta['staleNameSubscriptionId'], 'sub-x-1');
    assert.match(staleNotices[0].message, new RegExp(`^Subscription sub-x-1 \\(user ${USER_A}\\) carries the name 'rz_johnny_sub'`));
    assert.equal(
      run.logWarnings.filter((line) => line.includes('sub-x-1') && line.includes('stale')).length,
      1,
      'one log line',
    );
  });

  it('adopts it when the stale name is also this row\'s own STORED name — the rows the decode defect left without an id', async () => {
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_B, 740);
    const run = harness({
      panel,
      user: B_TELEGRAM_ONLY,
      subscription: { remnawavePanelUsername: 'rz_johnny_sub' },
      others: [A_CARRIES_STALE_NAME],
    });

    await run.run();

    assert.deepEqual(panel.creates, [], 'no second profile');
    assert.deepEqual(run.linkWrites.map((write) => write.data['remnawaveId']), ['740']);
  });

  it('still stops for an operator when another of B\'s OWN rows carries the profile\'s name', async () => {
    // The same customer's row naming the profile may be a duplicate row for
    // this very purchase; a second profile would make it a second free
    // subscription. That stays an operator's call.
    const panel = new FakePanel();
    panel.add('rz_johnny_sub', MARKER_B, 741);
    const run = harness({
      panel,
      user: B_TELEGRAM_ONLY,
      others: [{
        id: 'sub-b-8',
        userId: USER_B,
        remnawaveId: '998',
        remnawavePanelId: 998,
        remnawavePanelUsername: 'rz_johnny_sub',
        status: SubscriptionStatus.ACTIVE,
      }],
    });

    await assert.rejects(run.run(), /already\s+live on it/);

    assert.deepEqual(panel.creates, []);
    assert.deepEqual(run.linkWrites, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Round 3, item 1 — a retry finds what the interrupted attempt made
// ═════════════════════════════════════════════════════════════════════════════

/** Customer B: web login `bob`, Telegram linked with the @username `alice`. */
const B_ALICE = { login: 'bob', telegramId: 555000111n, username: 'alice' } as const;

/** What the bootstrap writes on the customer's next /start: the handle AND the verified pair. */
function renameNick(run: Harness, nick: string | null): void {
  run.user.username = nick;
  run.user.telegramUsername = nick;
  run.user.telegramUsernameTgId = run.user.telegramId;
}

describe('a CREATE retry finds the profile its interrupted attempt made, whatever changed in between', () => {
  it('the @username changed after the link write was lost: the retry adopts the first profile', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: B_ALICE, failLinkWrites: 1 });

    await assert.rejects(run.run());
    renameNick(run, 'alice2');
    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_alice_sub'], 'one profile, not two');
    assert.equal(run.linkWrites.length, 1);
    assert.equal(run.linkWrites[0].data['remnawavePanelUsername'], 'rz_alice_sub');
  });

  it('the @username changed after the POST answer was lost: the retry adopts the profile that POST made', async () => {
    const panel = new FakePanel();
    panel.loseNextCreateResponse = 1;
    const run = harness({ panel, user: B_ALICE });

    await assert.rejects(run.run());
    renameNick(run, 'alice2');
    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_alice_sub']);
    assert.equal(run.linkWrites[0]?.data['remnawavePanelUsername'], 'rz_alice_sub');
  });

  it('Telegram was unlinked in between: the retry still adopts the first profile', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: B_ALICE, failLinkWrites: 1 });

    await assert.rejects(run.run());
    run.user.telegramId = null;
    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_alice_sub']);
    assert.equal(run.linkWrites[0]?.data['remnawavePanelUsername'], 'rz_alice_sub');
  });

  it('the operator changed the prefix in between: the retry still adopts the first profile', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: { login: 'bob' }, failLinkWrites: 1 });

    await assert.rejects(run.run());
    run.branding.value = { profileNaming: { prefix: 'shop', separator: '_', suffixBase: 'sub' } };
    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_bob_sub']);
    assert.equal(run.linkWrites[0]?.data['remnawavePanelUsername'], 'rz_bob_sub');
  });

  it('records the chosen name, and the customer it was chosen for, BEFORE the POST', async () => {
    const panel = new FakePanel();
    panel.loseNextCreateResponse = 1;
    const run = harness({ panel, user: B_ALICE });

    await assert.rejects(run.run());

    assert.equal(run.subscription.remnawavePendingUsername, 'rz_alice_sub');
    assert.equal(run.subscription.remnawavePendingOwnerId, USER_B);
    const recorded = panel.log.indexOf('record rz_alice_sub');
    assert.ok(recorded >= 0, 'the name was recorded');
    assert.ok(recorded < panel.log.indexOf('POST rz_alice_sub'), 'recorded before the panel was asked to create it');
  });

  it('clears the recorded name when the profile is linked', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: B_ALICE });

    await run.run();

    assert.equal(run.subscription.remnawaveId, '9001');
    assert.equal(run.subscription.remnawavePendingUsername, null);
    assert.equal(run.subscription.remnawavePendingOwnerId, null);
  });

  it('creates nothing when the row was linked while its CREATE ran, and retries', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: B_ALICE });
    panel.onLookup = () => {
      run.subscription.remnawaveId = '4242';
    };

    await assert.rejects(run.run());

    assert.deepEqual(panel.creates, [], 'no second profile for a row that is linked now');
    assert.equal(run.failures[0]?.data.recoveryData?.classification, 'TRANSIENT');
  });

  it('an account merge moved the subscription in between: the profile made for the previous owner is adopted and re-marked', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: B_ALICE, failLinkWrites: 1 });

    await assert.rejects(run.run());
    // `account-merge.service` moves every subscription of the absorbed account.
    run.subscription.userId = USER_C;
    run.user.id = USER_C;
    run.user.name = 'Carol';
    run.user.webAccount = { login: 'carol', email: null, emailNormalized: null };
    run.user.telegramId = null;
    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_alice_sub'], 'no second profile');
    assert.equal(run.linkWrites[0]?.data['remnawavePanelUsername'], 'rz_alice_sub');
    assert.match(
      String(panel.profiles.get('rz_alice_sub')?.description),
      new RegExp(`^reiwa_id: ${USER_C}$`, 'm'),
      'the profile now proves its new owner',
    );
  });

  it('the profile under the recorded name lost its reiwa_id line: an operator decides, nothing is duplicated', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: B_ALICE, failLinkWrites: 1 });

    await assert.rejects(run.run());
    const first = panel.profiles.get('rz_alice_sub');
    assert.ok(first !== undefined);
    first.description = 'name: Bob\nnote: checked by support';
    renameNick(run, 'alice2');
    await assert.rejects(run.run(), /rz_alice_sub/);

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_alice_sub'], 'no second profile');
    assert.deepEqual(run.linkWrites, []);
    assert.equal(run.failures[run.failures.length - 1]?.data.recoveryData?.classification, 'TERMINAL');
  });

  it('never adopts a profile under the recorded name that another customer\'s marker names', async () => {
    // The first attempt's POST lost the race for the name: somebody else's
    // profile has it. The recorded name is a place to look, not a proof.
    const panel = new FakePanel();
    panel.add('rz_alice_sub', MARKER_A, 760);
    const run = harness({
      panel,
      user: B_ALICE,
      subscription: { remnawavePendingUsername: 'rz_alice_sub', remnawavePendingOwnerId: USER_B },
    });

    await run.run();

    assert.notEqual(run.linkWrites[0]?.data['remnawaveId'], '760');
    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_alice_bd4e76_sub']);
    assert.equal(run.subscription.remnawavePendingUsername, null, 'cleared by the link');
  });

  it('adopts the recorded name\'s profile even when another customer\'s row still carries that name', async () => {
    // Stale names on other customers' rows make B take a fresh name — but the
    // profile under the name B's own interrupted CREATE recorded IS B's: a
    // fresh name there would be the duplicate this whole record prevents.
    const panel = new FakePanel();
    panel.add('rz_alice_sub', `name: Bob\nlogin: bob\nreiwa_id: ${USER_B}`, 761);
    const run = harness({
      panel,
      user: B_ALICE,
      subscription: { remnawavePendingUsername: 'rz_alice_sub', remnawavePendingOwnerId: USER_B },
      others: [{
        id: 'sub-x-3',
        userId: USER_A,
        remnawaveId: '997',
        remnawavePanelId: 997,
        remnawavePanelUsername: 'rz_alice_sub',
        status: SubscriptionStatus.ACTIVE,
      }],
    });

    await run.run();

    assert.deepEqual(panel.creates, []);
    assert.equal(run.linkWrites[0]?.data['remnawaveId'], '761');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Round 3, item 2 — an ADOPTED profile is brought to the desired state
// ═════════════════════════════════════════════════════════════════════════════

/** The expiry a PATCH carries, as the ISO string (the client's schema hands it over as a Date). */
function expiryOf(patch: Record<string, unknown>): string {
  return new Date(patch['expireAt'] as string | Date).toISOString();
}

describe('a profile the CREATE path adopts gets the PATCH an UPDATE would send', () => {
  it('an UPDATE on a row with no panel id adopts its profile and pushes DISABLED for a blocked owner, and the expiry', async () => {
    const panel = new FakePanel();
    panel.add('rz_bob_sub', `name: Bob\nlogin: bob\nreiwa_id: ${USER_B}`, 777);
    const run = harness({
      panel,
      user: { login: 'bob' },
      action: SyncAction.UPDATE,
      blocked: true,
      subscription: { remnawavePanelUsername: 'rz_bob_sub' },
    });

    await run.run();

    assert.deepEqual(run.linkWrites.map((write) => write.data['remnawaveId']), ['777']);
    assert.equal(panel.patches.length, 1);
    assert.equal(panel.patches[0]['id'], 777);
    assert.equal(panel.patches[0]['status'], 'DISABLED', 'the only enforcement that reaches the VPN');
    assert.equal(expiryOf(panel.patches[0]), '2099-01-01T00:00:00.000Z');
    assert.deepEqual(panel.creates, []);
    assert.equal(run.completed(), 1);
  });

  it('a CREATE retry that adopts pushes the state the row has NOW', async () => {
    const panel = new FakePanel();
    const run = harness({ panel, user: B_ALICE, failLinkWrites: 1 });

    await assert.rejects(run.run());
    run.subscription.expiresAt = new Date('2099-06-01T00:00:00.000Z');
    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['rz_alice_sub']);
    assert.equal(panel.patches.length, 1);
    assert.equal(expiryOf(panel.patches[0]), '2099-06-01T00:00:00.000Z');
  });

  it('a re-provision after a PATCH 404 that adopts a profile pushes the desired state to it', async () => {
    const panel = new FakePanel();
    panel.add('rz_bob_sub', `name: Bob\nlogin: bob\nreiwa_id: ${USER_B}`, 778);
    const run = harness({
      panel,
      user: { login: 'bob' },
      action: SyncAction.UPDATE,
      blocked: true,
      subscription: { remnawaveId: '505', remnawavePanelId: 505, remnawavePanelUsername: 'rz_gone_sub' },
    });

    await run.run();

    assert.deepEqual(panel.patches.map((patch) => patch['id']), [505, 778]);
    assert.equal(panel.patches[1]['status'], 'DISABLED');
    assert.equal(run.linkWrites[0]?.data['remnawaveId'], '778');
    assert.deepEqual(panel.creates, []);
  });

  it('a panel that answers 404 to the PATCH of the profile it just served stops after three rounds, retryable', async () => {
    const panel = new FakePanel();
    panel.add('rz_bob_sub', `name: Bob\nlogin: bob\nreiwa_id: ${USER_B}`, 779);
    panel.patchMissing.add(779);
    const run = harness({
      panel,
      user: { login: 'bob' },
      action: SyncAction.UPDATE,
      subscription: { remnawavePanelUsername: 'rz_bob_sub' },
    });

    await assert.rejects(run.run());

    assert.ok(panel.patches.length <= 3, `bounded, not a loop (${panel.patches.length} PATCHes)`);
    assert.deepEqual(panel.creates, []);
    assert.equal(run.failures[0]?.data.recoveryData?.classification, 'TRANSIENT');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Only the panel's own 404 makes a name free — on EVERY name asked
// ═════════════════════════════════════════════════════════════════════════════

describe('a lookup that fails is not a free name, whichever name it was', () => {
  it('a 503 on a LATER name stops the CREATE: nothing is created, and it is retried', async () => {
    const panel = new FakePanel();
    // Asked: rz_johnny_sub, then the login-first rz_john_sub, then the fallbacks.
    panel.lookupOverride.set('rz_john_sub', { status: 503, data: { message: 'upstream restarting' } });
    const run = harness({ panel, user: B_WITH_TELEGRAM });

    await assert.rejects(run.run());

    assert.ok(panel.lookups.includes('rz_john_sub'));
    assert.deepEqual(panel.creates, []);
    assert.equal(run.failures[0]?.data.recoveryData?.classification, 'TRANSIENT');
  });

  it('a 503 on the LAST name stops the CREATE too', async () => {
    const panel = new FakePanel();
    panel.lookupOverride.set('rz_johnny_acd089_sub', { status: 503, data: { message: 'upstream restarting' } });
    const run = harness({ panel, user: B_WITH_TELEGRAM });

    await assert.rejects(run.run());

    assert.equal(panel.lookups[panel.lookups.length - 1], 'rz_johnny_acd089_sub', 'it is the last name asked');
    assert.deepEqual(panel.creates, []);
    assert.equal(run.failures[0]?.data.recoveryData?.classification, 'TRANSIENT');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Item 5 — an invalid value already stored must not break every CREATE
// ═════════════════════════════════════════════════════════════════════════════

describe('CREATE with an invalid naming value already in the settings row', () => {
  it('creates a valid name and never looks up a name the panel cannot hold', async () => {
    const panel = new FakePanel();
    const run = harness({
      panel,
      user: B_WITH_TELEGRAM,
      branding: { profileNaming: { prefix: 'my shop', separator: '_', suffixBase: 'sub' } },
    });

    await run.run();

    assert.deepEqual(panel.creates.map((body) => body['username']), ['my_shop_johnny_sub']);
    for (const name of panel.lookups) assert.match(name, /^[A-Za-z0-9_-]{3,36}$/);
    assert.equal(run.completed(), 1);
  });
});
