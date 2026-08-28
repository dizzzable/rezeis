import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { of, throwError } from 'rxjs';

import { ServiceUnavailableException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { ExpiredProfileCleanupService } from '../src/modules/profile-sync/expired-profile-cleanup.service';
import {
  storedIdentityOf,
  type PanelIdentityColumns,
} from '../src/modules/remnawave/services/panel-user-address';
import { PanelCommandExecutor } from '../src/modules/remnawave/services/panel-command.executor';
import { AxiosPanelTransport } from '../src/modules/remnawave/services/panel-transport';
import { PanelUsersClient } from '../src/modules/remnawave/services/panel-users.client';
import {
  RemnawaveApiService,
  RemnawaveProfileNotFoundError,
} from '../src/modules/remnawave/services/remnawave-api.service';

/**
 * "The profile is gone" versus "the panel did not answer", across every
 * supported panel version AND every HTTP method that can be told the profile is
 * gone.
 *
 * WHY THIS FILE EXISTS. Remnawave sends TWO not-found codes and picks between
 * them by ENDPOINT, not by meaning:
 *
 *   A063  GET /api/users/{uuid|id}   "User with specified params not found"
 *   A025  PATCH /api/users, DELETE /api/users/{…}, POST /api/users/resolve, …
 *                                    "User not found"
 *
 * The adapter recognised only A025 for a long time, and A063's prose does not
 * contain A025's ("User **with specified params** not found"), so neither the
 * code check nor the message fallback caught it. The direction of that failure
 * was safe — an unrecognised 404 degrades to `unavailable` — but the ONE read
 * that can confirm a profile is gone could then never confirm it, and every
 * consumer of that confirmation deferred forever. `remnawave-3x-contract-guard`
 * already pins both codes against the vendor package; what it could NOT see is
 * whether production reads them, and it did not: the recognised set was a second
 * copy of the pinned constant, so deleting `A063` from the copy left all 336
 * tests in the eight related spec files green.
 *
 * SO EVERY ASSERTION HERE IS ON AN OBSERVABLE OUTCOME, never on "the predicate
 * was called": the sweep either retires a subscription or defers it, the write
 * either raises the typed missing-profile error or the transient one. Those are
 * the two branches that decide whether a job finishes or is reset to PENDING
 * every five minutes forever.
 */

const CONFIG = { host: 'remnawave', port: 3000, token: 'secret', webhookSecret: null } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type Req = { readonly method?: string; readonly url: string; readonly data?: unknown };

/**
 * The REAL adapter over a panel that reports `version` and answers every
 * user-scoped request through `answer`.
 *
 * The version probes (`/api/system/…`) are served separately and excluded from
 * `userCalls()`: they are cached per instance but still travel the same fake
 * transport, and counting them would turn "the profile was read exactly once"
 * into an assertion about version detection.
 */
function panelOn(version: string, answer: (req: Req) => unknown) {
  const seen: Req[] = [];
  const http = {
    request: (input: Req) => {
      seen.push(input);
      if (input.url.startsWith('/api/system/')) return of({ data: { response: { version } } });
      return answer(input);
    },
  };
  const service = new RemnawaveApiService(http as never, CONFIG as never);
  // The SAME fake transport, driving the contract-based client the expired
  // sweep now reads through. Sharing `seen` is the point: the two halves of
  // this file must be looking at one panel.
  const client = new PanelUsersClient(
    new PanelCommandExecutor(
      new AxiosPanelTransport(http as never, { host: CONFIG.host, port: CONFIG.port, token: CONFIG.token }),
    ),
  );
  const userCalls = (): Req[] => seen.filter((req) => !req.url.startsWith('/api/system/'));
  return { service, client, userCalls };
}

function httpError(status: number, data?: unknown) {
  return throwError(() => ({
    isAxiosError: true,
    response: { status, headers: {}, data },
    message: `HTTP ${status}`,
  }));
}

/** A captured `GET /api/users/{…}` body, as the panel of that era really sent it. */
function userFixture(version: string): { version: string; response: Record<string, unknown> } {
  const file = path.join(__dirname, 'fixtures', 'remnawave', version, 'user.json');
  return JSON.parse(readFileSync(file, 'utf8')) as {
    version: string;
    response: Record<string, unknown>;
  };
}

type Row = PanelIdentityColumns & { readonly remnawaveId: string };

/**
 * The three deployments this build has to be right on at once.
 *
 * `fixtures` names the directory the captured body comes from; 3.2.1 stands in
 * for the operator's 3.2.3, which answers identically (the guard spec pins 3.2.3
 * routes and codes against the vendor package).
 *
 * The 3.x row is the MIGRATED shape, not a natively-3.x one: a profile created
 * on 2.x whose panel was later upgraded, so `remnawaveId` is still the old uuid
 * and the numeric id lives in `remnawavePanelId`. That is the population the
 * reporting operator has, and it exercises the id-addressing fallback rather
 * than the trivial "the stored string is already the id" path.
 */
const ERAS = [
  {
    version: '2.7.4',
    label: '2.7.4 (paying production)',
    row: {
      remnawaveId: '11111111-1111-4111-8111-111111111111',
      remnawavePanelId: 41,
      remnawavePanelUsername: 'rz_sub_1',
      configUrl: null,
    },
    route: '/api/users/11111111-1111-4111-8111-111111111111',
    patchKey: { uuid: '11111111-1111-4111-8111-111111111111' },
  },
  {
    version: '2.8.0',
    label: '2.8.0 (testers)',
    row: {
      remnawaveId: '22222222-2222-4222-8222-222222222222',
      remnawavePanelId: 42,
      remnawavePanelUsername: 'rz_sub_2',
      configUrl: null,
    },
    route: '/api/users/22222222-2222-4222-8222-222222222222',
    patchKey: { uuid: '22222222-2222-4222-8222-222222222222' },
  },
  {
    version: '3.2.1',
    label: '3.2.1 (the operator hitting this)',
    row: {
      remnawaveId: '33333333-3333-4333-8333-333333333333',
      remnawavePanelId: 2,
      remnawavePanelUsername: 'labuser1',
      configUrl: null,
    },
    route: '/api/users/2',
    patchKey: { id: 2 },
  },
] as const satisfies ReadonlyArray<{
  version: string;
  label: string;
  row: Row;
  route: string;
  patchKey: Record<string, unknown>;
}>;

type DeletionInput = {
  readonly subscriptionId: string;
  readonly expectedExpiresAt: Date;
  readonly expectedRemnawaveId: string | null;
  readonly cutoff: Date;
};

/**
 * The real expired-profile sweep over ONE candidate that the local database
 * believes expired 30 days ago — the stale side of the story the panel re-check
 * exists to settle.
 *
 * `retired` (the sweep's return value) and `deletions` are the observable
 * outcome: a subscription is either retired or left in the candidate set to be
 * re-read next sweep, forever.
 */
function sweepOver(panelUsers: PanelUsersClient, row: Row) {
  const deletions: DeletionInput[] = [];
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const service = new ExpiredProfileCleanupService(
    {
      subscription: {
        findMany: async (input: { where: Record<string, unknown> }) =>
          input.where['remnawaveId'] === null
            ? []
            : [
                {
                  id: 'sub-expired',
                  userId: 'user-1',
                  isTrial: false,
                  expiresAt: new Date(Date.now() - 30 * DAY_MS),
                  ...row,
                },
              ],
        update: async (input: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(input);
          return {};
        },
      },
    } as never,
    { info: () => undefined } as never,
    {
      getRemnawaveCleanupSettings: async () => ({ deleteEnabled: true, graceDays: 3 }),
    } as never,
    panelUsers as never,
    {
      deleteExpiredIfUnchanged: async (input: DeletionInput) => {
        deletions.push(input);
        return { deleted: true, syncJobId: `job-${input.subscriptionId}` };
      },
    } as never,
  );
  return { service, deletions, updates };
}

/**
 * Every body shape a panel can use to say "no such user", paired with the
 * method that produces it.
 *
 * `A063 carrying no message` is not decoration. The predicate has a prose
 * fallback as well as a code set, and with a message present the fallback alone
 * would carry the case — so dropping `A063` from the pinned code set would still
 * pass. A code-only envelope isolates the set, which is the thing the guard spec
 * pins and the thing production must actually read.
 */
const PANEL_SAYS_ABSENT: ReadonlyArray<readonly [string, unknown]> = [
  ['A063 exactly as 2.8.1 and 3.2.x send it', {
    errorCode: 'A063',
    message: 'User with specified params not found',
  }],
  ['A063 carrying no message', { errorCode: 'A063' }],
  ['A063 in a build that names the field `code`', { code: 'A063' }],
  // 2.7.4 was never measured on a live panel, and the same route may answer
  // either code; an identity-addressed read is confirmed absence under both.
  ['A025 exactly as the write endpoints send it', { errorCode: 'A025', message: 'User not found' }],
];

/**
 * A 404 that is NOT the panel's. A reverse proxy with no healthy backend answers
 * every request this way, and this branch is the destructive one.
 */
const PROXY_404: ReadonlyArray<readonly [string, unknown]> = [
  ['an nginx error page', '<html><head><title>404 Not Found</title></head></html>'],
  ['no body at all', undefined],
  ['a gateway JSON body with no panel error code', { message: '404 page not found' }],
];

describe('GET /api/users/{…} — A063 is the panel confirming the profile is gone', () => {
  for (const era of ERAS) {
    for (const [shape, body] of PANEL_SAYS_ABSENT) {
      it(`${era.label}: ${shape} retires the subscription instead of deferring forever`, async () => {
        const { client, userCalls } = panelOn(era.version, () => httpError(404, body));
        const { service, deletions, updates } = sweepOver(client, era.row);

        const retired = await service.runSweep();

        assert.deepEqual(
          userCalls().map((call) => call.url),
          [`/api/users/${era.row.remnawavePanelId}`],
          'the sweep addresses the profile by the numeric id this panel answers to',
        );
        assert.equal(
          retired,
          1,
          'the panel itself said the profile is gone — the candidate must leave the queue, ' +
            'not come back on every sweep for the rest of time',
        );
        assert.equal(deletions.length, 1);
        assert.equal(deletions[0]?.subscriptionId, 'sub-expired');
        // The stored column, never the address the panel was asked at: the
        // deletion is a compare-and-swap against `remnawaveId`.
        assert.equal(deletions[0]?.expectedRemnawaveId, era.row.remnawaveId);
        assert.equal(updates.length, 0, 'nothing is self-healed off an expiry we never read');
      });
    }

    for (const [shape, body] of PROXY_404) {
      it(`${era.label}: a bare 404 (${shape}) still defers — an outage must not retire anyone`, async () => {
        const { client, userCalls } = panelOn(era.version, () => httpError(404, body));
        const { service, deletions, updates } = sweepOver(client, era.row);

        const retired = await service.runSweep();

        assert.equal(userCalls().length, 1, 'the re-check must actually have run');
        assert.equal(retired, 0);
        assert.equal(deletions.length, 0);
        assert.equal(updates.length, 0);
      });
    }
  }
});

describe('the same read still reaches its other outcomes — this is not a harness stuck on one answer', () => {
  for (const era of ERAS) {
    /**
     * The captured body verbatim, with only `expireAt` moved.
     *
     * Moved rather than used as captured because the fixtures carry absolute
     * dates: 3.2.1's is weeks away and 2.x's is in 2099, so "is this past the
     * grace cutoff" would be answered by the calendar and the test would
     * silently change meaning on a future run.
     */
    const withExpiry = (offsetMs: number): unknown => {
      const fixture = userFixture(era.version);
      return {
        ...fixture,
        response: { ...fixture.response, expireAt: new Date(Date.now() + offsetMs).toISOString() },
      };
    };

    it(`${era.label}: a live profile self-heals the stale local date and is NOT retired`, async () => {
      const renewedTo = 20 * DAY_MS;
      const { client } = panelOn(era.version, () => of({ data: withExpiry(renewedTo) }));
      const { service, deletions, updates } = sweepOver(client, era.row);

      const retired = await service.runSweep();

      assert.equal(retired, 0);
      assert.equal(deletions.length, 0, 'the panel says this subscription is alive');
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.data['status'], SubscriptionStatus.ACTIVE);
    });

    it(`${era.label}: the same body with a past expiry IS retired, so the zero above means something`, async () => {
      const { client } = panelOn(era.version, () => of({ data: withExpiry(-40 * DAY_MS) }));
      const { service, deletions, updates } = sweepOver(client, era.row);

      const retired = await service.runSweep();

      assert.equal(retired, 1);
      assert.equal(deletions.length, 1);
      assert.equal(updates.length, 0);
    });
  }
});

describe('the code depends on the METHOD, and all of those readings are correct', () => {
  /**
   * The panel answers a write about a missing profile with A025 and a read about
   * the same profile with A063. Both are identity-addressed — `patchKeyFor` and
   * `segmentFor` resolve an identity BEFORE the request goes out and refuse
   * ("cannot act", never "gone") when they cannot — so both confirm absence, and
   * the adapter must not require one particular code per method.
   *
   * The fork being asserted is the one `ProfileSyncProcessor.classifyRecovery`
   * reads: a `ServiceUnavailableException` is TRANSIENT and the recovery sweep
   * resets that job to PENDING indefinitely. `RemnawaveProfileNotFoundError` is
   * not one, and the UPDATE handler catches it to re-provision — so the job
   * finishes. `deletePanelUser` reports the same thing as a value.
   */
  const IDENTITY_ABSENT: ReadonlyArray<readonly [string, unknown]> = [
    ['A025, which is what PATCH and DELETE really answer', {
      errorCode: 'A025',
      message: 'User not found',
    }],
    ['A063, so no endpoint is locked to one code', {
      errorCode: 'A063',
      message: 'User with specified params not found',
    }],
  ];

  for (const era of ERAS) {
    const identity = () => storedIdentityOf(era.row)!;

    for (const [shape, body] of IDENTITY_ABSENT) {
      it(`${era.label}: PATCH answered ${shape} is a missing profile, not an outage`, async () => {
        const { service: api, userCalls } = panelOn(era.version, () => httpError(404, body));

        const raised = await api
          .updatePanelUser(identity(), { description: 'rz' })
          .then(() => null, (err: unknown) => err);

        assert.deepEqual(userCalls().map((call) => call.url), ['/api/users']);
        assert.deepEqual(
          (userCalls()[0]?.data as Record<string, unknown> | undefined)?.[
            'uuid' in era.patchKey ? 'uuid' : 'id'
          ],
          Object.values(era.patchKey)[0],
          'the write must have named the profile the way this era keys it',
        );
        assert.ok(
          raised instanceof RemnawaveProfileNotFoundError,
          `expected a typed missing-profile error, got ${String(raised)}`,
        );
        assert.equal(
          raised instanceof ServiceUnavailableException,
          false,
          'a ServiceUnavailableException is classified TRANSIENT and reset to PENDING forever',
        );
      });

      it(`${era.label}: DELETE answered ${shape} completes the job`, async () => {
        const { service: api } = panelOn(era.version, () => httpError(404, body));

        assert.deepEqual(
          await api.deletePanelUser(identity(), await api.getPanelShape()),
          { isDeleted: true },
        );
      });
    }

    it(`${era.label}: PATCH answered a bare 404 stays transient and is retried`, async () => {
      const { service: api } = panelOn(era.version, () => httpError(404, undefined));

      const raised = await api
        .updatePanelUser(identity(), { description: 'rz' })
        .then(() => null, (err: unknown) => err);

      assert.equal(raised instanceof RemnawaveProfileNotFoundError, false);
      assert.ok(raised instanceof ServiceUnavailableException);
    });

    it(`${era.label}: DELETE answered a bare 404 is retried, never reported as deleted`, async () => {
      const { service: api } = panelOn(era.version, () => httpError(404, undefined));

      const raised = await api
        .deletePanelUser(identity(), await api.getPanelShape())
        .then(() => null, (err: unknown) => err);

      assert.ok(
        raised instanceof ServiceUnavailableException,
        'reporting `isDeleted: true` here detaches a live subscription during a proxy outage',
      );
    });
  }
});

describe('A063 from an ATTRIBUTE lookup answers a different question and must not retire anyone', () => {
  /**
   * The one place where treating A063 as "the profile is gone" would be WRONG.
   *
   * `POST /api/users/resolve` is addressed by a mutable attribute — here the
   * stored panel username, the only way back to a profile created on 2.x whose
   * panel was upgraded to 3.x before any numeric id was recorded. A063 from that
   * route means "no user carries that username RIGHT NOW", which an operator
   * renaming a perfectly live profile satisfies. It is not evidence about the
   * profile the subscription points at.
   *
   * The sweep keeps that distinction structurally rather than by inspecting the
   * code: an unresolvable attribute means the profile could not be ADDRESSED,
   * and only the read that follows a successful resolve can confirm absence.
   * These two cases pin that — the second is the positive control, without
   * which the zero in the first would also be produced by a harness that simply
   * never got anywhere.
   */
  const MIGRATED_ROW: Row = {
    remnawaveId: '44444444-4444-4444-8444-444444444444',
    remnawavePanelId: null,
    remnawavePanelUsername: 'rz_ghost_sub',
    configUrl: null,
  };

  const RESOLVE_MISS = httpError(404, {
    errorCode: 'A063',
    message: 'User with specified params not found',
  });

  it('a resolve that finds no such username defers — it never reaches the profile read', async () => {
    const { client, userCalls } = panelOn('3.3.2', (req) => {
      assert.equal(req.url, '/api/users/resolve', 'nothing may be read before the identity is known');
      return RESOLVE_MISS;
    });
    const { service, deletions, updates } = sweepOver(client, MIGRATED_ROW);

    const retired = await service.runSweep();

    assert.equal(retired, 0, 'a renamed profile is alive; "no user by that name" is not "gone"');
    assert.equal(deletions.length, 0);
    assert.equal(updates.length, 0);
    assert.deepEqual(userCalls().map((call) => call.url), ['/api/users/resolve']);
  });

  it('but once the resolve succeeds, A063 on the profile itself DOES retire it', async () => {
    const { client, userCalls } = panelOn('3.3.2', (req) =>
      req.url === '/api/users/resolve'
        ? of({
            data: {
              response: { id: 2, shortUuid: 'PyTr7C5568QuLhup', username: 'rz_ghost_sub' },
            },
          })
        : httpError(404, { errorCode: 'A063', message: 'User with specified params not found' }),
    );
    const { service, deletions } = sweepOver(client, MIGRATED_ROW);

    const retired = await service.runSweep();

    assert.equal(retired, 1);
    assert.equal(deletions.length, 1);
    assert.deepEqual(
      userCalls().map((call) => call.url),
      ['/api/users/resolve', '/api/users/2'],
      'the same row, resolved to its identity and then read — that read is the one that counts',
    );
  });
});
