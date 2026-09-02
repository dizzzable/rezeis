import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentsHost, HttpException } from '@nestjs/common';
import { Currency, PlanAvailability, PlanType, PointsCashbackMode } from '@prisma/client';

import {
  AdminSafeExceptionFilter,
  CODES_CARRYING_REAUTH_FACTOR,
  SAFE_PRODUCT_CODES,
} from '../src/common/filters/admin-safe-exception.filter';
import { TrafficLimitStrategyValue } from '../src/modules/plans/dto/traffic-limit-strategy.dto';
import {
  PLAN_WRITE_REFUSAL_CODES,
  PlanWriteRefusalCode,
} from '../src/modules/plans/plan-write-refusal-codes';
import { NormalizedPlanWriteInput } from '../src/modules/plans/services/plans-admin.normalizers';
import { PlansAdminValidators } from '../src/modules/plans/services/plans-admin.validators';
import { ArchivedPlanRenewModeValue } from '../src/modules/plans/utils/archived-plan-renew-mode.util';

/**
 * EVERY PLAN REFUSAL, ASSERTED AT BOTH SEAMS IT HAS TO CROSS.
 *
 * The defect this file was written for is not that a refusal was wrong. Every
 * one of them was correct, and every one of them reached the operator as a raw
 * English sentence in an otherwise-Russian panel — including
 * 'Replacement and upgrade plans must be active non-trial public plans:
 * cmsxo98e8006r01jgn33gtpbe', cuid and all. The SPA could not translate any of
 * them because it could not TELL THEM APART: `AdminSafeExceptionFilter`
 * forwards only an allowlisted product `code`, these throws carried none, and
 * so all seventeen arrived as the same untyped 400.
 *
 * So each case below is checked twice, and the two checks fail for different
 * reasons:
 *
 *  1. THE VALIDATOR still refuses, with the sentence it always had. Adding a
 *     code must not reword anything: `test/plans-admin.service.spec.ts` asserts
 *     on `exception.message`, and — more importantly — the sentence is the
 *     fallback the SPA prints for a code it does not recognise, which every
 *     older build during a rolling deploy is. The literals here are the
 *     PRE-CHANGE text, transcribed by hand rather than imported, so this file
 *     disagrees with the validator instead of agreeing with itself.
 *
 *  2. THE FILTER still carries the code onto the wire, in `code` AND in
 *     `errorCode` (the BFF and the SPA read different ones). This is the half
 *     that shipped broken next door: `totp_enroll_reauth_required` was thrown
 *     correctly and asserted on the exception's own body, while the filter
 *     silently stripped it, and 2FA could not be switched on by anybody. An
 *     assertion on the thrown exception proves nothing about what the browser
 *     receives.
 *
 * `wireMessage` is asserted too, and it is NOT always the sentence: the filter
 * scrubs any message matching its sensitive-text patterns, and a squad uuid
 * matches. So the two squad NOT_FOUND refusals reach the operator as
 * 'Request failed' and the code is the ONLY thing that survives them — which is
 * the strongest argument in this file for the codes existing at all. The cases
 * use realistic identifier shapes (cuid plan/user ids, uuid squads) precisely so
 * that this stays true here rather than being hidden by tidy fixtures.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The plan id from the operator report that started this. */
const OTHER_PLAN_ID = 'cmsxo98e8006r01jgn33gtpbe';
const EDITED_PLAN_ID = 'cmsxp0a1b006s01jgqq7rtuvw';
const MISSING_USER_ID = 'cmsxq11c2006t01jg0zk4wxyz';
const INTERNAL_SQUAD_ID = '11111111-1111-4111-8111-111111111111';
const EXTERNAL_SQUAD_ID = '22222222-2222-4222-8222-222222222222';

const BASE_WRITE: NormalizedPlanWriteInput = {
  name: 'Starter',
  description: null,
  tag: null,
  icon: null,
  isActive: true,
  isArchived: false,
  archivedRenewMode: ArchivedPlanRenewModeValue.SELF_RENEW,
  type: PlanType.BOTH,
  availability: PlanAvailability.ALL,
  trafficLimit: null,
  deviceLimit: 1,
  trafficLimitStrategy: TrafficLimitStrategyValue.NO_RESET,
  internalSquads: [],
  externalSquad: null,
  upgradeToPlanIds: [],
  replacementPlanIds: [],
  allowedUserIds: [],
  trialSettings: { maxClaims: 1, free: true, availabilityScope: 'ALL', requireTelegramLink: false },
  cashbackMode: PointsCashbackMode.INHERIT,
  cashbackPercent: null,
  durations: [{ days: 30, prices: [{ currency: Currency.USD, price: '9.99' }] }],
};

function write(overrides: Partial<NormalizedPlanWriteInput>): NormalizedPlanWriteInput {
  return { ...BASE_WRITE, ...overrides };
}

interface ReferencedPlanRow {
  readonly id: string;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  readonly availability: PlanAvailability;
}

/**
 * The real `PlansAdminValidators`, wired to fakes that answer only the reads it
 * performs. `plan.findFirst` is asked two different questions — "is this name
 * taken" carries `where.name`, "does a live trial already exist" does not — and
 * the fake tells them apart the same way `test/plans-admin.service.spec.ts`
 * does.
 */
function buildValidators(options: {
  readonly planWithSameName?: { readonly id: string } | null;
  readonly currentPlan?: { readonly availability: PlanAvailability } | null;
  readonly existingTrial?: { readonly id: string } | null;
  readonly referencedPlans?: readonly ReferencedPlanRow[];
  readonly users?: readonly { readonly id: string }[];
  readonly internalSquads?: readonly { readonly uuid: string }[];
  readonly externalSquads?: readonly { readonly uuid: string }[];
  readonly panelUnreachable?: boolean;
}): PlansAdminValidators {
  const prismaService = {
    plan: {
      findFirst: async (args: { readonly where?: { readonly name?: string } }) =>
        args?.where?.name === undefined
          ? (options.existingTrial ?? null)
          : (options.planWithSameName ?? null),
      findUnique: async () => options.currentPlan ?? null,
      findMany: async () => options.referencedPlans ?? [],
    },
    user: { findMany: async () => options.users ?? [] },
  };
  const remnawaveApiService = {
    getInternalSquadOptions: async (): Promise<readonly { readonly uuid: string }[]> => {
      if (options.panelUnreachable === true) throw new Error('panel unreachable');
      return options.internalSquads ?? [];
    },
    getExternalSquadOptions: async (): Promise<readonly { readonly uuid: string }[]> => {
      if (options.panelUnreachable === true) throw new Error('panel unreachable');
      return options.externalSquads ?? [];
    },
  };
  return new PlansAdminValidators(prismaService as never, remnawaveApiService as never);
}

/** A transaction client answering only the two reads the delete guard makes. */
function deleteClient(options: {
  readonly transitionReference?: { readonly id: string } | null;
  readonly subscriptionRows?: readonly { readonly id: string }[];
}): never {
  return {
    plan: { findFirst: async () => options.transitionReference ?? null },
    $queryRaw: async () => options.subscriptionRows ?? [],
  } as never;
}

// ── The table ───────────────────────────────────────────────────────────────

interface RefusalCase {
  /** What the operator did. Used in the test name. */
  readonly what: string;
  readonly code: PlanWriteRefusalCode;
  /** BYTE-IDENTICAL to the sentence the throw site carried before the code. */
  readonly message: string;
  /** What the browser actually receives — the filter scrubs some of these. */
  readonly wireMessage: string;
  readonly status: number;
  readonly refuse: () => Promise<void>;
}

const REFUSALS: readonly RefusalCase[] = [
  {
    what: 'a name another plan already holds',
    code: PLAN_WRITE_REFUSAL_CODES.NAME_TAKEN,
    message: "Plan with name 'Starter' already exists",
    wireMessage: "Plan with name 'Starter' already exists",
    status: 400,
    refuse: () =>
      buildValidators({ planWithSameName: { id: OTHER_PLAN_ID } }).assertPlanWriteIsValid({
        planId: null,
        input: BASE_WRITE,
      }),
  },
  {
    what: 'two duration rows claiming the same length',
    code: PLAN_WRITE_REFUSAL_CODES.DURATION_DUPLICATE,
    message: 'Duration 30 days is duplicated',
    wireMessage: 'Duration 30 days is duplicated',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanWriteIsValid({
        planId: null,
        input: write({
          durations: [
            { days: 30, prices: [{ currency: Currency.USD, price: '9.99' }] },
            { days: 30, prices: [{ currency: Currency.RUB, price: '990' }] },
          ],
        }),
      }),
  },
  {
    what: 'one duration priced twice in the same currency',
    code: PLAN_WRITE_REFUSAL_CODES.CURRENCY_DUPLICATE,
    message: "Currency 'USD' is duplicated for 30 days",
    wireMessage: "Currency 'USD' is duplicated for 30 days",
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanWriteIsValid({
        planId: null,
        input: write({
          durations: [
            {
              days: 30,
              prices: [
                { currency: Currency.USD, price: '9.99' },
                { currency: Currency.USD, price: '19.99' },
              ],
            },
          ],
        }),
      }),
  },
  {
    what: 'a plan naming itself as its own upgrade target',
    code: PLAN_WRITE_REFUSAL_CODES.TRANSITION_SELF_REFERENCE,
    message: 'Plan transitions cannot reference the same plan',
    wireMessage: 'Plan transitions cannot reference the same plan',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanWriteIsValid({
        planId: EDITED_PLAN_ID,
        input: write({ upgradeToPlanIds: [EDITED_PLAN_ID] }),
      }),
  },
  {
    what: 'REPLACE_ON_RENEW with nothing to replace the plan with',
    code: PLAN_WRITE_REFUSAL_CODES.TRANSITION_REPLACEMENT_REQUIRED,
    message: 'Archived plans with replacement renew mode must define replacement plans',
    wireMessage: 'Archived plans with replacement renew mode must define replacement plans',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanWriteIsValid({
        planId: null,
        input: write({
          isArchived: true,
          archivedRenewMode: ArchivedPlanRenewModeValue.REPLACE_ON_RENEW,
          replacementPlanIds: [],
        }),
      }),
  },
  {
    what: 'an archived-only renew mode on a live plan',
    code: PLAN_WRITE_REFUSAL_CODES.TRANSITION_RENEW_MODE_NOT_ARCHIVED,
    message: 'Only archived plans may define replacement renew behavior',
    wireMessage: 'Only archived plans may define replacement renew behavior',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanWriteIsValid({
        planId: null,
        input: write({
          isArchived: false,
          archivedRenewMode: ArchivedPlanRenewModeValue.REPLACE_ON_RENEW,
        }),
      }),
  },
  {
    what: 'turning an existing paid plan into the trial plan',
    code: PLAN_WRITE_REFUSAL_CODES.TRIAL_CONVERSION_FORBIDDEN,
    message:
      'Existing non-trial plans cannot be converted to TRIAL; create a dedicated trial plan.',
    wireMessage:
      'Existing non-trial plans cannot be converted to TRIAL; create a dedicated trial plan.',
    status: 400,
    refuse: () =>
      buildValidators({
        currentPlan: { availability: PlanAvailability.ALL },
      }).assertPlanWriteIsValid({
        planId: EDITED_PLAN_ID,
        input: write({ availability: PlanAvailability.TRIAL }),
      }),
  },
  {
    what: 'a second live trial plan',
    code: PLAN_WRITE_REFUSAL_CODES.TRIAL_ALREADY_EXISTS,
    message: 'Only one active trial plan is allowed',
    wireMessage: 'Only one active trial plan is allowed',
    status: 400,
    refuse: () =>
      buildValidators({ existingTrial: { id: OTHER_PLAN_ID } }).assertPlanWriteIsValid({
        planId: null,
        input: write({ availability: PlanAvailability.TRIAL }),
      }),
  },
  {
    what: 'a trial plan offering a choice of durations',
    code: PLAN_WRITE_REFUSAL_CODES.TRIAL_DURATION_COUNT,
    message: 'Trial plans must define exactly one duration',
    wireMessage: 'Trial plans must define exactly one duration',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanWriteIsValid({
        planId: null,
        input: write({
          availability: PlanAvailability.TRIAL,
          durations: [
            { days: 7, prices: [{ currency: Currency.USD, price: '1.00' }] },
            { days: 30, prices: [{ currency: Currency.USD, price: '9.99' }] },
          ],
        }),
      }),
  },
  {
    what: 'a paid trial with nothing to charge',
    code: PLAN_WRITE_REFUSAL_CODES.TRIAL_PRICE_REQUIRED,
    message: 'Paid trial plans must define at least one non-zero price',
    wireMessage: 'Paid trial plans must define at least one non-zero price',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanWriteIsValid({
        planId: null,
        input: write({
          availability: PlanAvailability.TRIAL,
          trialSettings: {
            maxClaims: 1,
            free: false,
            availabilityScope: 'ALL',
            requireTelegramLink: false,
          },
          durations: [{ days: 7, prices: [{ currency: Currency.USD, price: '0' }] }],
        }),
      }),
  },
  {
    what: 'an upgrade target that no longer exists',
    code: PLAN_WRITE_REFUSAL_CODES.TRANSITION_TARGET_NOT_FOUND,
    message: `Referenced plans not found: ${OTHER_PLAN_ID}`,
    wireMessage: `Referenced plans not found: ${OTHER_PLAN_ID}`,
    status: 400,
    refuse: () =>
      buildValidators({ referencedPlans: [] }).assertPlanWriteIsValid({
        planId: EDITED_PLAN_ID,
        input: write({ upgradeToPlanIds: [OTHER_PLAN_ID] }),
      }),
  },
  {
    // The exact refusal from the operator report, reproduced end to end.
    what: 'a trial plan named as an upgrade target',
    code: PLAN_WRITE_REFUSAL_CODES.TRANSITION_TARGET_NOT_ASSIGNABLE,
    message: `Replacement and upgrade plans must be active non-trial public plans: ${OTHER_PLAN_ID}`,
    wireMessage: `Replacement and upgrade plans must be active non-trial public plans: ${OTHER_PLAN_ID}`,
    status: 400,
    refuse: () =>
      buildValidators({
        referencedPlans: [
          {
            id: OTHER_PLAN_ID,
            isActive: true,
            isArchived: false,
            availability: PlanAvailability.TRIAL,
          },
        ],
      }).assertPlanWriteIsValid({
        planId: EDITED_PLAN_ID,
        input: write({ upgradeToPlanIds: [OTHER_PLAN_ID] }),
      }),
  },
  {
    what: 'an allowlisted user who does not exist',
    code: PLAN_WRITE_REFUSAL_CODES.ALLOWED_USERS_NOT_FOUND,
    message: `Allowed users not found: ${MISSING_USER_ID}`,
    wireMessage: `Allowed users not found: ${MISSING_USER_ID}`,
    status: 400,
    refuse: () =>
      buildValidators({ users: [] }).assertPlanWriteIsValid({
        planId: null,
        input: write({
          availability: PlanAvailability.ALLOWED,
          allowedUserIds: [MISSING_USER_ID],
        }),
      }),
  },
  {
    what: 'an internal squad the panel does not serve',
    code: PLAN_WRITE_REFUSAL_CODES.INTERNAL_SQUADS_NOT_FOUND,
    message: `Internal squads not found: ${INTERNAL_SQUAD_ID}`,
    // The uuid trips `SENSITIVE_HTTP_TEXT_PATTERNS`, so the sentence never
    // reaches the operator. The code is the whole signal on this path.
    wireMessage: 'Request failed',
    status: 400,
    refuse: () =>
      buildValidators({ internalSquads: [] }).assertPlanWriteIsValid({
        planId: null,
        input: write({ internalSquads: [INTERNAL_SQUAD_ID] }),
      }),
  },
  {
    what: 'an external squad the panel does not serve',
    code: PLAN_WRITE_REFUSAL_CODES.EXTERNAL_SQUAD_NOT_FOUND,
    message: `External squad not found: ${EXTERNAL_SQUAD_ID}`,
    wireMessage: 'Request failed',
    status: 400,
    refuse: () =>
      buildValidators({ externalSquads: [] }).assertPlanWriteIsValid({
        planId: null,
        input: write({ externalSquad: EXTERNAL_SQUAD_ID }),
      }),
  },
  {
    what: 'changed squads the panel could not be asked about',
    code: PLAN_WRITE_REFUSAL_CODES.SQUAD_VALIDATION_UNAVAILABLE,
    message:
      'Squads were not saved: the Remnawave panel could not be reached to verify them. ' +
      'Retry once the panel is back, or save the rest of the plan without changing squads.',
    wireMessage:
      'Squads were not saved: the Remnawave panel could not be reached to verify them. ' +
      'Retry once the panel is back, or save the rest of the plan without changing squads.',
    // The one non-400 in the table, and the reason it must not be collapsed
    // into its neighbours: nothing the operator typed is known to be wrong.
    status: 503,
    refuse: () =>
      buildValidators({ panelUnreachable: true }).assertPlanWriteIsValid({
        planId: null,
        input: write({ internalSquads: [INTERNAL_SQUAD_ID] }),
      }),
  },
  {
    what: 'deleting a plan a transition rule still points at',
    code: PLAN_WRITE_REFUSAL_CODES.DELETE_REFERENCED,
    message: 'Plan is referenced by subscriptions or transition rules. Archive it instead.',
    wireMessage: 'Plan is referenced by subscriptions or transition rules. Archive it instead.',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanDeleteIsAllowed(
        EDITED_PLAN_ID,
        deleteClient({ transitionReference: { id: OTHER_PLAN_ID } }),
      ),
  },
  {
    // The SAME refusal from the second throw site in the delete guard. Both
    // sentences were already identical; a code on one and not the other would
    // make the pair distinguishable on the wire for no reason.
    what: 'deleting a plan a live subscription snapshot still names',
    code: PLAN_WRITE_REFUSAL_CODES.DELETE_REFERENCED,
    message: 'Plan is referenced by subscriptions or transition rules. Archive it instead.',
    wireMessage: 'Plan is referenced by subscriptions or transition rules. Archive it instead.',
    status: 400,
    refuse: () =>
      buildValidators({}).assertPlanDeleteIsAllowed(
        EDITED_PLAN_ID,
        deleteClient({ transitionReference: null, subscriptionRows: [{ id: 'subscription-1' }] }),
      ),
  },
];

// ── 1. The sentence is unchanged, and the code rides beside it ──────────────

describe('every plan refusal carries a code without losing its sentence', () => {
  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.what} as ${refusal.code}`, async () => {
      const exception = await captureRefusal(refusal.refuse);

      assert.equal(
        exception.message,
        refusal.message,
        'the sentence is the fallback an unrecognising SPA prints, and existing specs assert on it',
      );
      assert.equal(exception.getStatus(), refusal.status);
      assert.deepEqual(
        exception.getResponse(),
        { code: refusal.code, message: refusal.message },
        'the body is exactly the code and the sentence — nothing else was added to the throw',
      );
    });
  }
});

// ── 2. The code survives the filter, which is where it is usually lost ──────

describe('every plan refusal code reaches the browser', () => {
  for (const refusal of REFUSALS) {
    it(`carries ${refusal.code} through AdminSafeExceptionFilter (${refusal.what})`, async () => {
      const exception = await captureRefusal(refusal.refuse);
      const wire = throughSafeFilter(exception);

      assert.equal(wire.statusCode, refusal.status);
      assert.equal(
        wire.body.code,
        refusal.code,
        'not allowlisted in SAFE_PRODUCT_CODES: the SPA receives an untyped error and can only print English',
      );
      assert.equal(
        wire.body.errorCode,
        refusal.code,
        'the BFF reads `errorCode` where the SPA reads `code`; both must carry it',
      );
      assert.equal(wire.body.message, refusal.wireMessage);
      assert.equal(
        wire.body.factor,
        undefined,
        'no plan refusal asks for a credential; none may grow a factor field',
      );
    });
  }
});

// ── 3. The two lists, checked instead of remembered ─────────────────────────

describe('PLAN_WRITE_REFUSAL_CODES and the filter allowlist', () => {
  /**
   * The check that turns "somebody must remember to edit the filter too" into a
   * named failure. `findSafeProductPayload` gates on `SAFE_PRODUCT_CODES` and
   * returns `undefined` on a miss, so a code that is not listed there is not a
   * degraded refusal — it is an invisible one, and the operator is back to
   * reading an English sentence they may not speak.
   */
  it('lists every plan refusal code in SAFE_PRODUCT_CODES', () => {
    const missing = Object.values(PLAN_WRITE_REFUSAL_CODES).filter(
      (code) => !SAFE_PRODUCT_CODES.has(code),
    );

    assert.deepEqual(
      missing,
      [],
      'these codes are thrown but not allowlisted, so the filter strips them and the SPA sees an untyped 400',
    );
    // A positive side: an empty code table would satisfy the check above for
    // entirely the wrong reason.
    assert.ok(
      Object.values(PLAN_WRITE_REFUSAL_CODES).length >= 17,
      'the table lost entries — every refusal in plans-admin.validators.ts needs one',
    );
  });

  /**
   * And the reverse direction: a code declared but never driven through the
   * real validator would be an allowlist entry nothing proves is reachable.
   */
  it('exercises every declared code against the real validator', () => {
    const covered = new Set<PlanWriteRefusalCode>(REFUSALS.map((refusal) => refusal.code));
    const declared = Object.values(PLAN_WRITE_REFUSAL_CODES);

    assert.deepEqual(
      declared.filter((code) => !covered.has(code)),
      [],
      'declared codes with no case above: nothing proves these are ever thrown, or ever survive',
    );
    assert.deepEqual(
      [...covered].filter((code) => !declared.includes(code)),
      [],
      'a case names a code the table no longer declares',
    );
  });

  /**
   * `CODES_CARRYING_REAUTH_FACTOR` opens a SECOND wire field. None of these
   * refusals asks the operator for a credential, so none belongs there — and
   * an entry added by reflex would forward a `factor` from any body that
   * happened to carry one.
   */
  it('adds none of them to CODES_CARRYING_REAUTH_FACTOR', () => {
    const wrongList = Object.values(PLAN_WRITE_REFUSAL_CODES).filter((code) =>
      CODES_CARRYING_REAUTH_FACTOR.has(code),
    );

    assert.deepEqual(wrongList, [], 'a plan refusal declares no re-authentication factor');
  });
});

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * Runs the refusal and hands back the exception it threw. Fails loudly if the
 * validator ACCEPTED the write: a case whose fixtures drifted into validity
 * would otherwise pass every assertion below it by never reaching them.
 */
async function captureRefusal(refuse: () => Promise<void>): Promise<HttpException> {
  try {
    await refuse();
  } catch (error: unknown) {
    assert.ok(
      error instanceof HttpException,
      `expected an HttpException from the validator, got: ${String(error)}`,
    );
    return error;
  }
  return assert.fail('the validator accepted a write it must refuse');
}

interface WireResponse {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

/**
 * Drives the real filter through a minimal `ArgumentsHost`, capturing the body
 * it writes — same shape as `test/safe-exception-product-messages.spec.ts`, for
 * the same reason: nothing in production ever reads the exception object.
 */
function throughSafeFilter(exception: unknown): WireResponse {
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
      getRequest: () => ({ originalUrl: '/api/admin/plans', headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  new AdminSafeExceptionFilter().catch(exception, host);
  return { statusCode, body };
}
