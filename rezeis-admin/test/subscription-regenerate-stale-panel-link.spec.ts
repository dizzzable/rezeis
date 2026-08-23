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
} from '../src/modules/remnawave/services/stale-panel-link';

/**
 * THE STALE-LINK GUARD ON THE THIRD VERB: SUBSCRIPTION LINK REGENERATION.
 *
 * A SIBLING FILE RATHER THAN MORE OF `subscription-delete-stale-panel-link.spec.ts`,
 * on purpose. That file is about DELETION — five call sites, one shape test, two
 * codes — and is already a thousand lines. This is a different verb with a
 * different consequence (a rotation nothing can undo, rather than a removal that
 * can be re-provisioned), a different code, and a different flow to trace: the
 * regenerate endpoint issues TWO destructive panel calls behind ONE guard, and
 * the interesting assertions are about that arrangement. Keeping it separate
 * also keeps a mutation run legible — one file, one verb, one named victim per
 * mutation.
 *
 * WHAT MAKES THIS VERB THE WORST OF THE THREE. `regeneratePanelUserSubscription`
 * names its target through the SAME `panelUserAddress` fallback — numeric fast
 * path → `remnawavePanelId` → the short uuid recovered from `config_url` →
 * `remnawavePanelUsername` — so on a 3.x panel a stale 2.x identity resolves to
 * whatever account is LIVE at that address and revokes ITS short uuid. Every
 * client link that customer holds dies at once and the panel cannot re-issue the
 * old value. A deletion can be re-provisioned and a device slot can be re-bound;
 * this cannot be walked back at all.
 *
 * EVERY REFUSAL HERE PINS A POSITIVE SIDE. "No panel mutation happened" passes
 * just as happily for a controller that reached no code at all, so each refusal
 * is paired with an INERTNESS CONTROL driving the SAME harness with a healthy
 * link and asserting the exact arguments that arrive. The stubs are always
 * present and always record; the empty array is therefore a real zero.
 */

/** A live 2.x uuid, in the spelling a 3.x panel can no longer answer to. */
const DEAD_UUID = '330f2b38-1f1e-4f6a-9f2b-0a1b2c3d4e5f';
/** The same profile as a 3.x panel names it. */
const LIVE_DECIMAL = '5150';
/** The link the customer already holds. Alive unless something rotates it. */
const OLD_LINK = 'https://sub.example.test/OLDshortOLD';
/** What the panel answers with when a rotation really does happen. */
const NEW_LINK = 'https://sub.example.test/NEWshortNEW';

type Addressing = 'id' | 'uuid' | 'unknown';

/** One destructive panel call, with everything it was handed. */
interface PanelMutation {
  readonly verb: 'rotate' | 'wipe';
  readonly ref: unknown;
  readonly era: unknown;
}

interface RegeneratePanelHarness {
  /** Every adapter method reached, in order — the era read included. */
  readonly calls: string[];
  /**
   * Every DESTRUCTIVE call, in order. Both stubs exist and both record, which
   * is what the inertness controls below prove; an empty array is therefore
   * evidence rather than the absence of a method.
   */
  readonly mutations: PanelMutation[];
  readonly api: unknown;
}

function regeneratePanelHarness(
  options: { addressing?: Addressing; throws?: boolean } = {},
): RegeneratePanelHarness {
  const calls: string[] = [];
  const mutations: PanelMutation[] = [];
  const api = {
    getPanelShape: async () => {
      calls.push('getPanelShape');
      if (options.throws === true) {
        // Exactly how the era read fails in production: the probe goes out over
        // the same transport as everything else, so an unreachable panel, an
        // expired token or a panel mid-restart all arrive as a throw.
        throw new Error('Remnawave version could not be read');
      }
      return { addressing: options.addressing ?? 'unknown' };
    },
    regeneratePanelUserSubscription: async (ref: unknown, era: unknown) => {
      calls.push('regeneratePanelUserSubscription');
      mutations.push({ verb: 'rotate', ref, era });
      return { subscriptionUrl: NEW_LINK };
    },
    deleteAllPanelUserDevices: async (ref: unknown, era: unknown) => {
      calls.push('deleteAllPanelUserDevices');
      mutations.push({ verb: 'wipe', ref, era });
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

/** What `storedIdentityOf` builds from each row — asserted, never assumed. */
const STALE_IDENTITY = {
  remnawaveId: DEAD_UUID,
  panelId: null,
  panelUsername: null,
  panelShortUuid: 'OLDshortOLD',
};
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
    const panel = regeneratePanelHarness({ addressing: 'id' });
    const harness = regenerateController(staleRow(), panel);

    const refusal = refusalBodyOf(
      await rejectionOf(() => harness.controller.regenerateSubscription('123456789', 'sub-1')),
    );

    assert.equal(refusal.status, 409);
    assert.equal(refusal.code, SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_CODE);
    assert.equal(
      refusal.message,
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
      'reiwa serves a customer, who cannot open the Subscriptions page the operator sentence names',
    );

    // The whole point of the guard: it stands in front of STEP 1, so the panel
    // is asked which era it is and then nothing else at all. Both destructive
    // calls in this flow are downstream of the throw.
    assert.deepEqual(
      panel.calls,
      ['getPanelShape'],
      'the era read is the ONLY thing this path may ask the panel',
    );
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
    assert.match(harness.errors[0], /reconciliation/i);
  });

  it('INERTNESS CONTROL: the same harness DOES record a rotation when the link is healthy', async () => {
    // Without this case, "no panel mutation was issued" above would pass for a
    // controller that crashed before reaching any of it. Same harness, same
    // stubs, one repaired row — and the assertion is on the ARGUMENTS, not on a
    // count.
    const panel = regeneratePanelHarness({ addressing: 'id' });
    const harness = regenerateController(healthyRow(), panel);

    const result = await harness.controller.regenerateSubscription('123456789', 'sub-1');

    assert.deepEqual(result, { regenerated: true, url: NEW_LINK, devicesCleared: true });
    assert.deepEqual(panel.calls, [
      'getPanelShape',
      'regeneratePanelUserSubscription',
      'deleteAllPanelUserDevices',
    ]);
    assert.deepEqual(panel.mutations, [
      { verb: 'rotate', ref: HEALTHY_IDENTITY, era: { addressing: 'id' } },
      { verb: 'wipe', ref: HEALTHY_IDENTITY, era: { addressing: 'id' } },
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

  it('ONE OBSERVATION: the era is read once and that same reading reaches both destructive calls', async () => {
    // The defect the observation shape exists to close, restated on this flow.
    // `getPanelShape()` caches a FAILURE for fifteen seconds, so two reads taken
    // microseconds apart can legitimately disagree — and the disagreement that
    // matters runs "the guard saw 'unknown', so proceed" into "the builder saw
    // 'id', so fall back through panelId to whatever is live at that address".
    // A guard that took its own reading would show up here as a second
    // `getPanelShape`.
    const panel = regeneratePanelHarness({ addressing: 'id' });
    const harness = regenerateController(healthyRow(), panel);

    await harness.controller.regenerateSubscription('123456789', 'sub-1');

    assert.equal(
      panel.calls.filter((call) => call === 'getPanelShape').length,
      1,
      'the era is observed exactly once per request; a second read is the defect, not a detail',
    );
    assert.equal(panel.mutations.length, 2);
    assert.equal(
      panel.mutations[0].era,
      panel.mutations[1].era,
      'the SAME object, not merely an equal one: one observation, carried by value',
    );
    assert.deepEqual(panel.mutations[0].era, { addressing: 'id' });
  });

  it('the refusal is raised in front of STEP 1, so the device wipe is unreachable too', async () => {
    // Both panel calls in this flow are destructive on a stale link, and only
    // ONE guard stands in front of them. That is deliberate — step 1 rotates the
    // link, so a guard placed anywhere after it speaks too late — but it makes
    // this guard the sole protection for step 3 as well, and that has to be
    // pinned somewhere rather than inferred.
    const panel = regeneratePanelHarness({ addressing: 'id' });
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

// ── THE THREE ERAS THAT MUST NOT NOTICE THE GUARD ───────────────────────────

describe('regeneration on a link that is NOT stale is untouched', () => {
  it('3.x panel, current decimal identity: the ordinary regeneration is unchanged', async () => {
    // The inverted-shape-test catcher. A guard that refused a decimal would make
    // every correctly-linked subscription on a 3.x panel un-regenerable.
    const panel = regeneratePanelHarness({ addressing: 'id' });
    const harness = regenerateController(healthyRow(), panel);

    const result = await harness.controller.regenerateSubscription('123456789', 'sub-1');

    assert.deepEqual(result, { regenerated: true, url: NEW_LINK, devicesCleared: true });
    assert.deepEqual(panel.mutations, [
      { verb: 'rotate', ref: HEALTHY_IDENTITY, era: { addressing: 'id' } },
      { verb: 'wipe', ref: HEALTHY_IDENTITY, era: { addressing: 'id' } },
    ]);
  });

  it('2.x panel: a uuid identity is what that panel issued, so the rotation goes through', async () => {
    // Installations still on 2.x must not notice this guard at all.
    const panel = regeneratePanelHarness({ addressing: 'uuid' });
    const harness = regenerateController(staleRow(), panel);

    const result = await harness.controller.regenerateSubscription('123456789', 'sub-1');

    assert.deepEqual(result, { regenerated: true, url: NEW_LINK, devicesCleared: true });
    assert.deepEqual(panel.mutations, [
      { verb: 'rotate', ref: STALE_IDENTITY, era: { addressing: 'uuid' } },
      { verb: 'wipe', ref: STALE_IDENTITY, era: { addressing: 'uuid' } },
    ]);
    assert.deepEqual(harness.updates, [
      { where: { id: 'sub-1' }, data: { configUrl: NEW_LINK } },
    ]);
  });

  it('an unreadable era still regenerates — the fail-open is deliberate and stays', async () => {
    // THIS STANCE IS NOT AN OVERSIGHT and is asserted here for the same reason
    // it is asserted on the delete verbs. Version detection fails for the same
    // reasons requests fail — an unreachable panel, an expired token, a panel
    // mid-restart — so a refusal keyed on it would fire exactly when the panel
    // is already answering with terminal errors, and would turn a customer's
    // regenerate button into a second thing that is broken while it is down. On
    // 'unknown' the address builder emits the stored string unchanged, which
    // names the right account or nobody; a 3.x panel answers 400.
    const panel = regeneratePanelHarness({ throws: true });
    const harness = regenerateController(staleRow(), panel);

    const result = await harness.controller.regenerateSubscription('123456789', 'sub-1');

    assert.deepEqual(result, { regenerated: true, url: NEW_LINK, devicesCleared: true });
    assert.deepEqual(panel.mutations, [
      { verb: 'rotate', ref: STALE_IDENTITY, era: { addressing: 'unknown' } },
      { verb: 'wipe', ref: STALE_IDENTITY, era: { addressing: 'unknown' } },
    ]);
  });

  it('an era the panel reported as unknown behaves the same as an unreachable one', async () => {
    const panel = regeneratePanelHarness({ addressing: 'unknown' });
    const harness = regenerateController(staleRow(), panel);

    const result = await harness.controller.regenerateSubscription('123456789', 'sub-1');

    assert.deepEqual(result, { regenerated: true, url: NEW_LINK, devicesCleared: true });
    assert.deepEqual(panel.mutations, [
      { verb: 'rotate', ref: STALE_IDENTITY, era: { addressing: 'unknown' } },
      { verb: 'wipe', ref: STALE_IDENTITY, era: { addressing: 'unknown' } },
    ]);
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
    assert.match(SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_MESSAGE, /reconciliation/i);
    assert.doesNotMatch(
      SUBSCRIPTION_REGENERATE_STALE_PANEL_LINK_SUBSCRIBER_MESSAGE,
      /reconciliation|Subscriptions page/i,
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
