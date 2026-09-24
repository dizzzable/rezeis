import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, ConflictException } from '@nestjs/common';

import {
  AdminSafeExceptionFilter,
  SAFE_PRODUCT_CODES,
} from '../src/common/filters/admin-safe-exception.filter';
import { InternalUserDevicesController } from '../src/modules/internal-user/controllers/internal-user-devices.controller';
import {
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE,
  SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE,
  SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
  UNLINKED_SUBSCRIPTIONS_PATH,
} from '../src/modules/remnawave/services/stale-panel-link';

/**
 * THE STALE-LINK GUARD ON THE THIRD VERB: SUBSCRIPTION LINK REGENERATION.
 *
 * A SIBLING FILE RATHER THAN MORE OF `subscription-delete-stale-panel-link.spec.ts`,
 * on purpose. That file is about DELETION; this is a different verb with a
 * different consequence (a rotation nothing can undo, rather than a removal that
 * can be re-provisioned), a different code, and a different flow to trace: the
 * regenerate endpoint issues TWO destructive panel calls behind ONE guard, and
 * the interesting assertions are about that arrangement.
 *
 * WHAT MAKES THIS VERB THE WORST OF THE THREE. `regeneratePanelUserSubscription`
 * names its target through the SAME `panelUserAddress` fallback — numeric fast
 * path → `remnawavePanelId` → the short uuid recovered from `config_url` →
 * `remnawavePanelUsername` — so a stale 2.x identity resolves to whatever
 * account is LIVE at that address and revokes ITS short uuid. Every client link
 * that customer holds dies at once and the panel cannot re-issue the old value.
 *
 * THE GUARD READS NO PANEL VERSION: a stored identity that is not a decimal names
 * nobody on the only panel this build speaks. The harness's `getPanelShape`
 * records and throws, so a guard that asked would show up in the call list.
 *
 * EVERY REFUSAL HERE PINS A POSITIVE SIDE. "No panel mutation happened" passes
 * just as happily for a controller that reached no code at all, so each refusal
 * is paired with an INERTNESS CONTROL driving the SAME harness with a healthy
 * link and asserting the exact arguments that arrive.
 */

/** A live 2.x uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
/** The same profile as a 3.x panel names it. */
const LIVE_DECIMAL = '5150';
/** The link the customer already holds. Alive unless something rotates it. */
const OLD_LINK = 'https://sub.example.test/OLDshortOLD';
/** What the panel answers with when a rotation really does happen. */
const NEW_LINK = 'https://sub.example.test/NEWshortNEW';

/** One destructive panel call, with every argument it was handed. */
interface PanelMutation {
  readonly verb: 'rotate' | 'wipe';
  readonly args: unknown[];
}

interface RegeneratePanelHarness {
  /** Every adapter method reached, in order. */
  readonly calls: string[];
  /**
   * Every DESTRUCTIVE call, in order. Both stubs exist and both record, which
   * is what the inertness controls below prove; an empty array is therefore
   * evidence rather than the absence of a method.
   */
  readonly mutations: PanelMutation[];
  readonly api: unknown;
}

function regeneratePanelHarness(): RegeneratePanelHarness {
  const calls: string[] = [];
  const mutations: PanelMutation[] = [];
  const api = {
    getPanelShape: async () => {
      calls.push('getPanelShape');
      throw new Error('the panel version must not be read on a regenerate');
    },
    regeneratePanelUserSubscription: async (...args: unknown[]) => {
      calls.push('regeneratePanelUserSubscription');
      mutations.push({ verb: 'rotate', args });
      return { subscriptionUrl: NEW_LINK };
    },
    deleteAllPanelUserDevices: async (...args: unknown[]) => {
      calls.push('deleteAllPanelUserDevices');
      mutations.push({ verb: 'wipe', args });
      return { total: 0 };
    },
  };
  return { calls, mutations, api };
}

interface SubscriptionRow {
  id: string;
  userId: string;
  remnawaveId: string | null;
  remnawavePanelId: number | null;
  remnawavePanelUsername: string | null;
  configUrl: string | null;
}

/** The unrepaired importer row: a dead 2.x uuid and no supplementary columns. */
function staleRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub-1',
    userId: 'user-1',
    remnawaveId: DEAD_UUID,
    remnawavePanelId: null,
    remnawavePanelUsername: null,
    // The saved link is what makes the fallback RESOLVE rather than refuse — it
    // is the route from a dead uuid to somebody else's live account.
    configUrl: OLD_LINK,
    ...overrides,
  };
}

/** The repaired row, as a 3.x panel names it. */
function healthyRow(): SubscriptionRow {
  return {
    id: 'sub-1',
    userId: 'user-1',
    remnawaveId: LIVE_DECIMAL,
    remnawavePanelId: 5150,
    remnawavePanelUsername: 'rz_alice_sub',
    configUrl: OLD_LINK,
  };
}

/** What `storedIdentityOf` builds from the healthy row — asserted, never assumed. */
const HEALTHY_IDENTITY = {
  remnawaveId: LIVE_DECIMAL,
  panelId: 5150,
  panelUsername: 'rz_alice_sub',
  panelShortUuid: 'OLDshortOLD',
};

interface ControllerHarness {
  readonly controller: InternalUserDevicesController;
  /** Every `subscription.update` the controller issued, in order. */
  readonly updates: unknown[];
  readonly errors: string[];
  readonly events: Array<{ severity: 'INFO' | 'ERROR'; message: string }>;
}

function regenerateController(
  row: SubscriptionRow | null,
  panel: RegeneratePanelHarness,
): ControllerHarness {
  const updates: unknown[] = [];
  const errors: string[] = [];
  const events: ControllerHarness['events'] = [];
  const prisma = {
    user: {
      findUnique: async () => ({ id: 'user-1', telegramId: null, username: null, name: null }),
    },
    subscription: {
      findFirst: async () => row,
      update: async (input: unknown) => {
        updates.push(input);
        return {};
      },
    },
  };
  const controller = new InternalUserDevicesController(
    prisma as never,
    panel.api as never,
    {
      info: (_type: string, _entity: string, message: string) => {
        events.push({ severity: 'INFO', message });
      },
      error: (_type: string, _entity: string, message: string) => {
        events.push({ severity: 'ERROR', message });
      },
    } as never,
  );
  const logger = (
    controller as unknown as { logger: { error: (m: string) => void; warn: (m: string) => void } }
  ).logger;
  logger.error = (message: string) => {
    errors.push(message);
  };
  logger.warn = (message: string) => {
    errors.push(message);
  };
  return { controller, updates, errors, events };
}

/** The rejection, or a failure naming what came back instead. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  const outcome = await run().then(
    (value) => ({ resolved: true, value }) as const,
    (error: unknown) => ({ resolved: false, error }) as const,
  );
  assert.equal(
    outcome.resolved,
    false,
    `expected a refusal, but the call resolved with ${JSON.stringify(
      outcome.resolved ? outcome.value : null,
    )}`,
  );
  return outcome.resolved ? undefined : outcome.error;
}

/** Both halves of the refusal a caller sees. */
function refusalBodyOf(error: unknown): { code?: string; message?: string; status: number } {
  assert.ok(
    error instanceof ConflictException,
    `expected a 409 ConflictException, got ${String(error)}`,
  );
  const body = error.getResponse() as { code?: string; message?: string };
  return { code: body.code, message: body.message, status: error.getStatus() };
}

// ── THE REFUSAL ─────────────────────────────────────────────────────────────

describe('regenerating a subscription link is refused on a stale panel link', () => {
  it('THE PROOF: the rotation is refused, no panel mutation is issued, and the stored link is left alone', async () => {
    const panel = regeneratePanelHarness();
    const harness = regenerateController(staleRow(), panel);

    const refusal = refusalBodyOf(
      await rejectionOf(() => harness.controller.regenerateSubscription('123456789', 'sub-1')),
    );

    assert.equal(refusal.status, 409);
    assert.equal(refusal.code, SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE);
    assert.equal(
      refusal.message,
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
      'reiwa serves a customer, who cannot open the operator screen the operator sentence names',
    );

    // The whole point of the guard: it stands in front of STEP 1, so the panel
    // is asked nothing at all — not its version, not a rotation, not a wipe.
    assert.deepEqual(panel.calls, [], 'the panel is asked nothing on a stale link');
    assert.deepEqual(
      panel.mutations,
      [],
      'no rotation and no device wipe — and the INERTNESS CONTROL below proves both stubs record',
    );
    // The customer's link is untouched on our side too: no rotation happened,
    // so there is nothing to persist and `config_url` still holds OLD_LINK.
    assert.deepEqual(harness.updates, [], 'nothing was written over the working link');
    assert.deepEqual(
      harness.events,
      [],
      'nothing rotated and nothing was lost, so the feed is not told a link went missing',
    );
    assert.equal(harness.errors.length, 1, 'the refusal is said out loud once, so it is traceable');
    assert.ok(harness.errors[0].includes(UNLINKED_SUBSCRIPTIONS_PATH));
  });

  it('an empty stored id is refused the same way — it names nobody either', async () => {
    const panel = regeneratePanelHarness();
    const harness = regenerateController(staleRow({ remnawaveId: '' }), panel);

    const refusal = refusalBodyOf(
      await rejectionOf(() => harness.controller.regenerateSubscription('123456789', 'sub-1')),
    );

    assert.equal(refusal.code, SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE);
    assert.deepEqual(panel.mutations, []);
  });

  it('INERTNESS CONTROL: the same harness DOES record a rotation when the link is healthy', async () => {
    // Without this case, "no panel mutation was issued" above would pass for a
    // controller that crashed before reaching any of it. Same harness, same
    // stubs, one repaired row — and the assertion is on the ARGUMENTS, not on a
    // count.
    const panel = regeneratePanelHarness();
    const harness = regenerateController(healthyRow(), panel);

    const result = await harness.controller.regenerateSubscription('123456789', 'sub-1');

    assert.deepEqual(result, { regenerated: true, url: NEW_LINK, devicesCleared: true });
    assert.deepEqual(panel.calls, ['regeneratePanelUserSubscription', 'deleteAllPanelUserDevices']);
    // The identity alone: no era rides along into either destructive call.
    assert.deepEqual(panel.mutations, [
      { verb: 'rotate', args: [HEALTHY_IDENTITY] },
      { verb: 'wipe', args: [HEALTHY_IDENTITY] },
    ]);
    // The new URL is stored, and the assertion names it: a persist of the OLD
    // url would satisfy a bare "one update happened".
    assert.deepEqual(harness.updates, [
      { where: { id: 'sub-1' }, data: { configUrl: NEW_LINK } },
    ]);
    assert.deepEqual(harness.errors, []);
    assert.deepEqual(harness.events, [
      { severity: 'INFO', message: 'Subscription link regenerated by user (all devices revoked)' },
    ]);
  });

  it('the refusal is raised in front of STEP 1, so the device wipe is unreachable too', async () => {
    // Both panel calls in this flow are destructive on a stale link, and only
    // ONE guard stands in front of them. That is deliberate — step 1 rotates the
    // link, so a guard placed anywhere after it speaks too late — but it makes
    // this guard the sole protection for step 3 as well, and that has to be
    // pinned somewhere rather than inferred.
    const panel = regeneratePanelHarness();
    const harness = regenerateController(staleRow(), panel);

    await rejectionOf(() => harness.controller.regenerateSubscription('123456789', 'sub-1'));

    assert.equal(
      panel.mutations.filter((mutation) => mutation.verb === 'wipe').length,
      0,
      'deleteAllPanelUserDevices unbinds every device of whatever the fallback resolved to',
    );
    assert.equal(panel.mutations.filter((mutation) => mutation.verb === 'rotate').length, 0);
  });
});

// ── THE REFUSAL AS IT LEAVES THE PROCESS ────────────────────────────────────

interface WireResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

/**
 * Drives the REAL `AdminSafeExceptionFilter` through a minimal `ArgumentsHost`,
 * capturing the status and body it writes. Same shape as
 * `safe-exception-product-messages.spec.ts`, for the same reason: nothing in
 * production ever reads the exception object, and the sentence that matters is
 * the one that survives the scrub.
 */
function throughSafeFilter(exception: unknown, originalUrl: string): WireResponse {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: unknown) {
      body = (payload ?? {}) as Record<string, unknown>;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl, headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  return { statusCode, body };
}

describe('the regenerate refusal survives the real safe-exception filter', () => {
  for (const [audience, message] of [
    ['operator', SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE],
    ['subscriber', SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE],
  ] as ReadonlyArray<readonly [string, string]>) {
    it(`carries the code and the ${audience} sentence intact`, () => {
      // The message is IMPORTED, never spot-checked prose, so this case fails if
      // a copy-edit introduces a word the filter scrubs (`profile`, `token`, an
      // email shape, a bare uuid, a URL). A refusal whose sentence is replaced
      // with "Request failed" is still a correct refusal and still tells the
      // reader nothing.
      const wire = throughSafeFilter(
        new ConflictException({
          code: SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE,
          message,
        }),
        '/api/internal/user/123456789/subscriptions/sub-1/regenerate',
      );

      assert.equal(wire.statusCode, 409);
      assert.equal(wire.body.code, SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE);
      assert.equal(wire.body.errorCode, SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE);
      assert.equal(
        wire.body.message,
        message,
        'scrubbed, the reader is told only that the request failed',
      );
      assert.equal(
        wire.body.factor,
        undefined,
        'this refusal asks for no credential and must not grow a factor field',
      );
    });
  }

  it('is allowlisted, which is the only reason the code above survives at all', () => {
    assert.ok(
      SAFE_PRODUCT_CODES.has(SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE),
      `${SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE} is not in SAFE_PRODUCT_CODES: the filter ` +
        'strips it and the cabinet receives an untyped 409',
    );
  });

  it('is classified TERMINAL, so nothing retries at a refusal only a human can clear', () => {
    // `ProfileSyncProcessor.classifyRecovery` reads the MESSAGE of a plain
    // `Error` to decide TRANSIENT vs TERMINAL. A wording carrying any of these
    // would be retried forever with nobody told.
    const transientWords = /timeout|temporar|econn|429|502|503|504|unavailable/;
    for (const message of [
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE,
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
    ]) {
      assert.doesNotMatch(message.toLowerCase(), transientWords);
    }
  });

  it('is one code with two sentences, and a code distinct from both siblings', () => {
    // One code, because a client BRANCHES on it. Two sentences, because the
    // fallback a client prints when it does not know the code yet has to be
    // sayable to whoever is reading.
    assert.notEqual(
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE,
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
    );
    assert.ok(SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE.includes(UNLINKED_SUBSCRIPTIONS_PATH));
    assert.doesNotMatch(
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
      /Подписки|Инструменты|reconciliation|Subscriptions page/i,
      'naming a screen the customer cannot open is a dead end, not a next step',
    );
    assert.match(
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
      /contact support/i,
      'the only next step a customer actually has',
    );
    // The fact a successful regeneration would deny, and the one the reader most
    // needs: the link they wanted rotated is still live.
    assert.match(SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE, /still works/i);
    // And a THIRD code: a client that shared one of the others would offer
    // "delete it again" or "revoke it again" on a regenerate dialog.
    assert.notEqual(
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE,
      SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE,
    );
    assert.notEqual(
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE,
      SUBSCRIPTION_DEVICE_DELETE_STALE_PANEL_LINK_CODE,
    );
  });
});
