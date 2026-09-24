/**
 * AdminUserSubscriptionsController
 * ────────────────────────────────
 * Subscription-related operations carved out of
 * `admin-user-management.controller.ts` so each controller stays focused
 * on a single domain. All routes share the `/admin/users` prefix and
 * `AdminJwtAuthGuard`, so the admin SPA continues to call the same paths
 * without any client-side changes.
 *
 * Covers:
 *   - Per-subscription mutations (status, limits, expiry, squads, delete)
 *   - Traffic reset / panel sync
 *   - Device list / revoke
 *   - "Give subscription" / "Grant trial" flows attached to a user by
 *     Telegram id
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  Plan,
  Prisma,
  SubscriptionStatus,
  SyncAction,
  SyncJobStatus,
} from '@prisma/client';
import { Request } from 'express';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { parseTelegramId } from '../../../common/utils/postgres-bigint.util';
import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { RbacGuard } from '../../rbac/guards/rbac.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import { readProfileOwnerMarkers } from '../../profile-sync/panel-owner-marker';
import { ProfileSyncQueueService } from '../../profile-sync/profile-sync-queue.service';
import { sameSquadSet } from '../../plans/utils/plan-squads.util';
import { withLocalOpenEndKept } from '../../remnawave/services/panel-expiry';
import {
  panelRefreshWrites,
  panelReportedRezeisOwnedFields,
  type PanelRefreshWrites,
} from '../../remnawave/services/panel-field-ownership';
import {
  isNumericPanelIdentity,
  storedIdentityOf,
} from '../../remnawave/services/panel-user-address';
import { RemnawaveApiService } from '../../remnawave/services/remnawave-api.service';
import {
  isStalePanelIdentity,
  staleDeviceDeleteRefusalBody,
} from '../../remnawave/services/stale-panel-link';
import {
  describeLimitsVerdict,
  finishTermModelReadback,
  judgePanelRowReadback,
  recordOperatorTrafficReset,
  TERM_MODEL_MARKER_SELECT,
  withoutWithheldReadbackFields,
  type PanelLimitsVerdict,
} from '../../remnawave/services/term-model-readback';
import { readPanelUserStatus, takePanelAnswerStatus } from '../../profile-sync/panel-answer-status';
import { panelProfileClaims } from '../../imports/services/remnawave-importer.service';
import { carryImportDomainKeys } from '../../imports/utils/import-domain-snapshot.util';
import { requirePanelDeviceList } from '../../remnawave/utils/panel-device-read.util';
import { selectGrantableTrialPlan } from '../../subscriptions/services/grantable-trial-plan.util';
import type {
  PlanInheritedLimitKey,
  QuantityLimits,
} from '../../subscriptions/services/plan-inherited-limits.util';
import { resolvePlanChangeLimitCarryInTransaction } from '../../add-on-entitlements/services/configured-baseline.util';
import type { RecomputeProjectionResult } from '../../add-on-entitlements/services/effective-projection.service';
import { SubscriptionTermHooksService } from '../../add-on-entitlements/services/subscription-term-hooks.service';
import type { AlignTailOptions } from '../../add-on-entitlements/services/subscription-term.service';
import { numericColumnsFromProjection } from '../../plans/migrations/plan-migration-compute.util';
import { SubscriptionDeletionService } from '../../subscriptions/services/subscription-deletion.service';
import { SubscriptionMutationsService } from '../../subscriptions/services/subscription-mutations.service';
import { SystemEventsService, EVENT_TYPES } from '../../../common/services/system-events.service';
import { planNamesMetadata } from '../../../common/utils/plan-snapshot.util';
import { buildPlanSnapshot } from '../utils/plan-snapshot.util';
import { PLAN_ASSIGNMENT_REFUSAL_CODES } from './plan-assignment-refusals';
import type { SubscriptionSyncPanelLimits, SubscriptionSyncReadback } from './subscription-sync-readback';
import { SUBSCRIPTION_SYNC_REFUSAL_CODES } from './subscription-sync-refusals';
import { OPERATOR_LIMIT_SOURCE } from '../../anti-fraud/detectors/sharing-detectors';

/**
 * Longest identity we accept, in characters. A numeric 3.x id needs 20 at the
 * very most (an unsigned 64-bit id). It is not decoration: `^[0-9]+$` is happy to
 * match a megabyte of digits, and that value goes on to be interpolated into a
 * panel URL.
 */
const MAX_REMNAWAVE_ID_LENGTH = 20;

/**
 * Whether a string can name a panel profile on the panel this build speaks:
 * Remnawave 3.x, which keys every user-scoped route on the numeric `id`.
 *
 * A 2.x UUID is NOT accepted any more. It names nobody on a 3.x panel, and
 * linking one would re-create exactly the stale row the destructive paths
 * refuse (`isStalePanelIdentity`). Only the numeric id an operator reads off
 * the 3.x panel links.
 *
 * "Accept anything" is the wrong widening, too. The value is interpolated into
 * a panel URL path segment (`GET /api/users/{segment}`) and used as a Prisma
 * `where` value; a decimal is fully anchored over `[0-9]`, so `/`, `?`, `#`,
 * `.`, `%` and whitespace — everything that could re-target the panel request —
 * are refused by construction rather than by a blacklist somebody has to keep
 * complete.
 */
function isLinkableRemnawaveId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REMNAWAVE_ID_LENGTH) return false;
  // `isNumericPanelIdentity` is imported, not re-spelled: it is the same
  // predicate the adapter and the stale-link refusal use, and two copies could
  // drift into disagreeing about what counts as numeric — this one accepting a
  // value the adapter then cannot address.
  return isNumericPanelIdentity(value);
}

/**
 * Names the accepted form and the panel it comes from. The operator reading
 * this is holding a panel screen.
 */
const REMNAWAVE_ID_REQUIRED_MESSAGE =
  'A valid Remnawave profile identifier is required: the numeric profile id shown by panel 3.x';

/**
 * The panel profile's numeric id as established by a verification read, or
 * `null` when this read cannot establish it.
 *
 * The panel row is the first source: 3.x keys everything by it, so a decoded
 * row has it. The identifier the operator pasted is the second: the panel
 * answered `ok` for a path segment built from that decimal, so the number names
 * the profile even if the body we got back happened to omit the field.
 *
 * `Number.isSafeInteger`, not a null check, on both. `isLinkableRemnawaveId`
 * admits up to 20 digits, and a decimal past 2^53 parses to a ROUNDED number —
 * which would then compare equal to some other row's `remnawavePanelId` and
 * refuse a repair over a collision that exists only in the float.
 */
function panelProfileNumericId(panelId: number | null, pastedIdentity: string): number | null {
  if (Number.isSafeInteger(panelId)) return panelId;
  if (!isNumericPanelIdentity(pastedIdentity)) return null;
  const parsed = Number(pastedIdentity);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The audit action both subscription editors write when one of the four
 * plan-inherited limit columns actually moves.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `resolveInheritedPlanLimitUpdate`
 * (`subscriptions/services/plan-inherited-limits.util.ts`) decides at renewal
 * whether a limit column was individually adjusted by comparing it against
 * `plan_snapshot`. That derivation is sound going forward, but it cannot look
 * backwards: for a row whose column and snapshot already disagree it cannot say
 * whether an operator set the value on purpose or whether the row simply
 * drifted (an import, a half-finished migration, a mirrored snapshot from
 * before the freeze). A one-off repair of existing rows is therefore not
 * derivable, and this is the gap that makes it so — the subscription editor
 * changed limits for years and recorded nothing.
 *
 * ── How a repair job reads it ─────────────────────────────────────────────
 *
 *   SELECT metadata->>'subscriptionId', metadata->>'source',
 *          metadata->'changes', created_at
 *   FROM   admin_audit_log
 *   WHERE  action = 'user.subscription.limits_changed'
 *   ORDER  BY created_at
 *
 * Replay per subscription, in order. `source = 'plan_assignment'` RESETS every
 * field back to inherited — assigning a plan legitimately re-copies all four
 * and rewrites the snapshot with them. `source = 'operator_edit'` marks each
 * key present under `changes` as individually overridden from that moment on.
 * `source = 'plan_migration'` is NOT a reset, though it also carries
 * `assignedPlanId`: moving a subscription off a plan being deleted
 * (`plans/migrations/plan-migration-move.service.ts`) marks each key present
 * under `changes` as inherited from `assignedPlanId`'s plan; keys absent from
 * `changes` did not change, and a key that was individually overridden stays
 * overridden — the move keeps it and never lists it. A replay that keys on
 * `assignedPlanId` alone would read a move as a full reset and wipe exactly the
 * overrides the move preserved. Whatever is still marked overridden at the end
 * is an operator's deliberate value; a column that disagrees with its snapshot
 * and appears nowhere in this log drifted, and is a repair candidate.
 *
 * ONE action for every kind, discriminated by `source`, rather than several: a
 * replay that has to remember to union a second action name is a replay that
 * will one day be written with only the first, and it would then read every
 * plan assignment's reset as an override.
 *
 * `AdminAuditLog` carries no `entityType`/`entityId` columns — only `action`,
 * `adminUserId`, `ipAddress`, `userAgent` and `metadata` — so the subject goes
 * in `metadata`, exactly as `user.subscription.deleted` already does.
 */
const SUBSCRIPTION_LIMITS_CHANGED_ACTION = 'user.subscription.limits_changed';

/**
 * `snapshotSource` of the term «Назначить план» rotates a subscription onto —
 * what traces a term back to this route (plan migration writes
 * `PLAN_MIGRATION_TERM`, a paid upgrade its own).
 */
export const ADMIN_PLAN_ASSIGNMENT_TERM = 'ADMIN_PLAN_ASSIGNMENT_TERM';

/**
 * The ↻ answer's spelling of each limits verdict (`subscription-sync-readback.ts`).
 * Exhaustive by construction: a verdict added to `PanelLimitsVerdict` does not
 * compile here until the wire list — which the SPA's words are tested against —
 * names it too.
 */
const SYNC_PANEL_LIMITS: Readonly<Record<PanelLimitsVerdict, SubscriptionSyncPanelLimits>> = {
  IN_STEP: 'IN_STEP',
  PUT_BACK: 'PUT_BACK',
  OUTRANKED: 'OUTRANKED',
  PROFILE_DELETED: 'PROFILE_DELETED',
  SHARED_PROFILE: 'SHARED_PROFILE',
  UNLINKED: 'UNLINKED',
};

/**
 * What produced the change — see {@link SUBSCRIPTION_LIMITS_CHANGED_ACTION}.
 * `plan_migration` is written by the plan migration, never by this controller.
 */
type SubscriptionLimitChangeSource = 'operator_edit' | 'plan_assignment' | 'plan_migration';

/** The four values as a `Subscription` row holds them. */
interface SubscriptionLimitValues {
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

/** Only the fields a request actually writes; an absent key was not touched. */
type SubscriptionLimitWrite = Partial<SubscriptionLimitValues>;

/**
 * Per-field before/after, keyed by field name so a reader can ask about ONE
 * limit (`metadata->'changes'->'deviceLimit'`) without unpacking an array.
 */
type SubscriptionLimitChanges = Partial<
  Record<PlanInheritedLimitKey, { readonly from: unknown; readonly to: unknown }>
>;

/**
 * The limit fields this request actually MOVED.
 *
 * A field the request did not write is absent from `after` and never appears. A
 * field written to the value it already held is absent too: a PATCH that sets
 * `deviceLimit` to the same number it has must not manufacture evidence that an
 * operator overrode it, or the repair above would read every idle save of the
 * subscription form as a deliberate override of everything on it.
 *
 * `internalSquads` is compared with `sameSquadSet` — the same order-insensitive
 * comparison the renewal reader and the plan squad fan-out use — so re-saving a
 * reordered but identical squad list is correctly not a change. Comparing
 * positionally here would record an override that pins the column forever.
 */
function diffSubscriptionLimits(
  before: SubscriptionLimitValues,
  after: SubscriptionLimitWrite,
): SubscriptionLimitChanges {
  const changes: {
    -readonly [K in keyof SubscriptionLimitChanges]: SubscriptionLimitChanges[K];
  } = {};
  if (after.trafficLimit !== undefined && after.trafficLimit !== before.trafficLimit) {
    changes.trafficLimit = { from: before.trafficLimit, to: after.trafficLimit };
  }
  if (after.deviceLimit !== undefined && after.deviceLimit !== before.deviceLimit) {
    changes.deviceLimit = { from: before.deviceLimit, to: after.deviceLimit };
  }
  if (
    after.internalSquads !== undefined &&
    !sameSquadSet(before.internalSquads, after.internalSquads)
  ) {
    changes.internalSquads = {
      from: [...before.internalSquads],
      to: [...after.internalSquads],
    };
  }
  if (after.externalSquad !== undefined && after.externalSquad !== before.externalSquad) {
    changes.externalSquad = { from: before.externalSquad, to: after.externalSquad };
  }
  return changes;
}

/**
 * The operator's hand-typed traffic cap, as whole gigabytes or `null` for
 * unlimited.
 *
 * ── Why this is a function and not `Number(body.trafficLimit)` ─────────────
 *
 * `updateSubscription` takes `@Body() body: Record<string, unknown>`. Its
 * metatype is `Object`, so the global `ValidationPipe` (`main.ts`, with
 * `whitelist`/`forbidNonWhitelisted`) skips the route entirely: NO
 * class-validator decorator runs on this endpoint, and there is no DTO to hang
 * one on. Every other writer of this column is gated by a `@Min(1)` somewhere.
 * This one was gated by nothing at all, and `Number()` is a generous coercer —
 * `0`, `"0"`, `null`, `""`, `false` and `[]` ALL land as `0`, and a typed `-5`
 * lands as `-5`.
 *
 * ── Why `0` is the value worth refusing ───────────────────────────────────
 *
 * Remnawave has no encoding for "zero bytes allowed": its `0` IS unlimited. So
 * a locally-stored `trafficLimit: 0` is a value the other side cannot express,
 * and it fails in both directions at once —
 *
 *   • OUTBOUND, `profile-sync.processor.ts` and the desired-state PATCH both
 *     send `(trafficLimit ?? 0) * 1024 ** 3`, so the `0` goes up as `0` bytes
 *     and the panel reads UNLIMITED. The customer we recorded as capped at
 *     nothing is uncapped upstream — the exact opposite of the row.
 *   • INBOUND, the panel answers `0`/`null`, which decodes back to `null`.
 *     `bigintEq(null, 0n)` is false, the projection is never stamped APPLIED,
 *     and the sync job records drift FOREVER. Not once — on every sweep, for
 *     the life of the subscription.
 *
 * So this refuses rather than silently rewriting: an operator who typed `0`
 * meant something, and quietly storing `null` (unlimited) or `1` would hand
 * them a different product without saying so.
 *
 * `null` IS accepted, and deliberately — it is how this endpoint says
 * unlimited, and before this function there was no way to say it at all
 * (`Number(null)` is `0`, so the payload that most obviously means "no cap"
 * was the very one that minted the unrepresentable value).
 *
 * NOTE the neighbouring `deviceLimit` is validated too — see
 * `readOperatorDeviceLimit` below — but to a DIFFERENT rule, and that is not an
 * oversight: `deviceLimit <= 0` is the product's canonical UNLIMITED and
 * matches the panel's own `hwidDeviceLimit: 0`, so `0` is legal there and
 * refused here. Same digit, opposite meaning, one line apart. See
 * `remnawave/utils/panel-traffic-limit.util.ts`.
 */
function readOperatorTrafficLimitGb(raw: unknown): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  // `Number.isInteger` rejects NaN, ±Infinity and fractions in one check —
  // `Number('abc')` used to reach Prisma as NaN and fail at the driver, which
  // is a 500 for what is plainly a bad request.
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException(
      'trafficLimit must be a whole number of gigabytes, at least 1 — or null for unlimited. ' +
        'Zero is not a cap Remnawave can express: it spells unlimited traffic as 0 bytes, so a ' +
        'zero-gigabyte cap is pushed to the panel as no cap at all and the subscription then ' +
        'reports drift on every sync forever.',
    );
  }
  return value;
}

/**
 * The widest value `Subscription.deviceLimit` can hold: it is `Int` in
 * `schema.prisma`, i.e. a 32-bit signed Postgres `integer`. Not a product
 * opinion about how many phones a person owns — a ceiling so that a payload
 * outside the COLUMN's range is answered with a 400 here instead of blowing up
 * at the driver as a 500. `expireDays` borrows the same pair.
 */
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

/**
 * The operator's hand-typed device cap, as the column stores it.
 *
 * ── The same hole as traffic, and it was still open ────────────────────────
 *
 * `updateSubscription` has NO DTO — its `@Body()` is `Record<string, unknown>`,
 * whose metatype is `Object`, so the global `ValidationPipe` skips the route
 * and not one class-validator decorator anywhere runs on it. `deviceLimit` was
 * therefore `Number(body.deviceLimit)` and nothing else: `deviceLimit: 'abc'`
 * became `NaN`, reached Prisma, and the operator got a 500 for what is plainly
 * a bad request.
 *
 * ── Why this rule is NOT the traffic rule ─────────────────────────────────
 *
 * Read `readOperatorTrafficLimitGb` above before touching this, because the
 * two conventions are deliberately OPPOSITE and a "consistency" pass across
 * them is a data-loss bug:
 *
 *   • TRAFFIC   `null` is unlimited, so `0` is free to mean "no traffic at
 *               all" — a state Remnawave cannot express. Hence `@Min(1)`.
 *   • DEVICES   `deviceLimit <= 0` IS the product's canonical unlimited, and
 *               it matches the panel's own `hwidDeviceLimit: 0`. `0` here is
 *               not a broken cap, it is the answer "as many as you like", and
 *               it is also the column's `@default(0)`.
 *
 * So `0` must stay accepted. Refusing it — copying the traffic gate across —
 * would take away the only way this endpoint has of clearing a device cap.
 *
 * ── What IS refused ───────────────────────────────────────────────────────
 *
 * Everything that cannot be read as a count at all. `Number()` is a generous
 * coercer and every one of its generosities lands on `0`, which here is not an
 * error value but UNLIMITED — so `deviceLimit: ''`, `false` or `[]` would each
 * quietly hand the customer an uncapped subscription. Those are refused rather
 * than coerced, and only two non-numeric inputs survive:
 *
 *   • `null`, which is normalised to the canonical `0`. It is the plain way to
 *     say "no limit", it is what the traffic sibling accepts for the same
 *     purpose, and the column is NOT nullable — passing it through would fail
 *     at the driver as a 500.
 *   • a numeric string, which is what an HTML number input produces.
 *
 * Negatives below zero are accepted as written, not normalised: `<= 0` is the
 * convention every reader in the product implements (`sharing-detection.util`,
 * `entitlement-baseline`, `addon-purchase.service`, `toPanelDeviceLimit`), and
 * plan fixtures already spell unlimited `-1`. Rewriting them to `0` here would
 * make this one endpoint disagree with all of them.
 */
function readOperatorDeviceLimit(raw: unknown): number {
  // The one non-numeric spelling of "no limit" this endpoint accepts. It has
  // to become `0` rather than pass through: the column is `Int`, not `Int?`.
  if (raw === null) return 0;
  const refuse = (): never => {
    throw new BadRequestException(
      'deviceLimit must be a whole number of devices — a positive count, or 0 (or null) for ' +
        'unlimited. Note that 0 means UNLIMITED here and is accepted, unlike trafficLimit: ' +
        'Remnawave spells an uncapped device count `hwidDeviceLimit: 0` and this column follows ' +
        'it. Blank, boolean and array payloads are refused rather than coerced, because ' +
        'Number() turns every one of them into 0 and would silently uncap the subscription.',
    );
  };
  // Guarded BEFORE `Number()`, which is the whole point: `Number(false)`,
  // `Number([])` and `Number('')` are all `0`, and `0` is a legitimate value
  // on this field, so a coercion here is indistinguishable from a decision.
  if (typeof raw !== 'number' && typeof raw !== 'string') refuse();
  if (typeof raw === 'string' && raw.trim().length === 0) refuse();
  const value = Number(raw);
  // `Number.isInteger` rejects NaN, ±Infinity and fractions in one check.
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) refuse();
  return value;
}

/**
 * The operator's relative expiry nudge, in days.
 *
 * Same missing-DTO hole, and its failure was quieter than the others because
 * the guard that follows it LOOKS like it covers the case and does not:
 * `Number('abc')` is `NaN`, `base.getTime() + NaN` is `NaN`, `new Date(NaN)` is
 * an Invalid Date, and `NaN < Date.now()` is **false** — so the "expiry would
 * be in the past" refusal waves it straight through and the Invalid Date lands
 * on Prisma as a 500. A merely enormous value does the same thing without any
 * NaN in the payload: ECMAScript caps a Date at ±8.64e15 ms, so
 * `expireDays: 1e15` overflows into an Invalid Date by arithmetic alone.
 *
 * Fractions are allowed on purpose — half a day is a coherent extension — but
 * blanks, booleans and arrays are not, for the same reason as `deviceLimit`:
 * `Number('')` is `0`, and a `0`-day nudge still rewrites `expiresAt` to
 * `max(expiresAt, now)`, which for an already-expired row silently moves the
 * expiry to this instant.
 */
function readOperatorExpireDays(raw: unknown): number {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new BadRequestException('expireDays must be a number of days.');
  }
  if (typeof raw === 'string' && raw.trim().length === 0) {
    throw new BadRequestException('expireDays must be a number of days.');
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new BadRequestException('expireDays must be a number of days.');
  }
  return value;
}

@Controller('admin/users')
@UseGuards(AdminJwtAuthGuard, RbacGuard)
@RequirePermission('subscriptions', 'view')
export class AdminUserSubscriptionsController {
  private readonly logger = new Logger(AdminUserSubscriptionsController.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly remnawaveApiService: RemnawaveApiService,
    private readonly profileSyncQueueService: ProfileSyncQueueService,
    private readonly systemEvents: SystemEventsService,
    private readonly subscriptionDeletionService: SubscriptionDeletionService,
    private readonly subscriptionMutationsService: SubscriptionMutationsService,
    private readonly subscriptionTermHooks: SubscriptionTermHooksService,
  ) {}

  // ── Subscription Mutations ─────────────────────────────────────────────

  @Patch('subscriptions/:subscriptionId')
  @RequirePermission('subscriptions', 'edit')
  public async updateSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const sub = await this.prismaService.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException('Subscription not found');

    const data: Prisma.SubscriptionUpdateInput = {};
    let assignedPlanId: string | null = null;
    // The assigned plan: what a subscription in the term model is rotated onto.
    let assignedPlan: Plan | null = null;
    // Its snapshot. Written in the transaction below, with the import's own
    // keys of the snapshot read under the row lock carried across.
    let assignedPlanSnapshot: Prisma.InputJsonValue | null = null;
    // The assigned plan's own two quantity limits. What the row WRITES is
    // resolved inside the transaction below — see the carry there.
    let assignedPlanLimits: QuantityLimits | null = null;
    // The limit values this request WRITES, collected beside `data` so the
    // audit entry below describes the same numbers that reach the row rather
    // than re-deriving them from the body and drifting.
    const writtenLimits: {
      trafficLimit?: number | null;
      deviceLimit?: number;
      internalSquads?: readonly string[];
      externalSquad?: string | null;
    } = {};

    if (body.status !== undefined) {
      if (body.status !== SubscriptionStatus.ACTIVE && body.status !== SubscriptionStatus.DISABLED) {
        throw new BadRequestException('Only ACTIVE or DISABLED can be set by the subscription editor');
      }
      data.status = body.status;
    }

    if (body.planId !== undefined && body.planId !== null) {
      // `String()` never throws on a JSON value, so this branch could not 500 —
      // but `String({})` is `'[object Object]'` and `String(['a','b'])` is
      // `'a,b'`, and both go on to answer "Plan not found". A 404 is the wrong
      // account of a malformed field: it says the plan is missing when what is
      // actually wrong is the request. `Plan.id` is a cuid string, so requiring
      // a string costs no caller anything.
      if (typeof body.planId !== 'string' || body.planId.length === 0) {
        throw new BadRequestException('planId must be a non-empty plan id string.');
      }
      const planId = body.planId;
      // A deleted plan is gone for the operator too: it is never offered in the
      // picker, and assigning one from a stale page would put a subscriber on a
      // plan nobody can renew.
      const plan = await this.prismaService.plan.findUnique({ where: { id: planId, deletedAt: null } });
      if (!plan) throw new NotFoundException('Plan not found');
      assignedPlanSnapshot = buildPlanSnapshot(plan);
      // Plans dictate the squads at the moment of assignment, and the limits
      // too — plus what the row held above its old plan, which is resolved in
      // the transaction below, under the row lock.
      const planInternalSquads = Array.isArray(plan.internalSquads) ? [...plan.internalSquads] : [];
      data.internalSquads = planInternalSquads;
      data.externalSquad = plan.externalSquad ?? null;
      writtenLimits.internalSquads = planInternalSquads;
      writtenLimits.externalSquad = plan.externalSquad ?? null;
      assignedPlanLimits = { trafficLimit: plan.trafficLimit, deviceLimit: plan.deviceLimit };
      assignedPlanId = plan.id;
      assignedPlan = plan;
    }
    if (body.trafficLimit !== undefined && assignedPlanId === null) {
      // Validated, not coerced — this route has no DTO, so the gate every other
      // writer of this column gets from `@Min(1)` has to live here.
      const trafficLimit = readOperatorTrafficLimitGb(body.trafficLimit);
      data.trafficLimit = trafficLimit;
      writtenLimits.trafficLimit = trafficLimit;
    }
    if (body.deviceLimit !== undefined && assignedPlanId === null) {
      // Validated, not coerced — same missing-DTO hole as traffic above, but to
      // the OPPOSITE rule: `0` is unlimited here and stays legal.
      const deviceLimit = readOperatorDeviceLimit(body.deviceLimit);
      data.deviceLimit = deviceLimit;
      writtenLimits.deviceLimit = deviceLimit;
    }
    if (body.expireDays !== undefined) {
      const days = readOperatorExpireDays(body.expireDays);
      const base = sub.expiresAt === null
        ? new Date()
        : new Date(Math.max(sub.expiresAt.getTime(), Date.now()));
      const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      // `Number.isNaN` FIRST, and not folded into the comparison below: an
      // Invalid Date has a `NaN` timestamp, and `NaN < Date.now()` is false, so
      // the "in the past" refusal waves it through and Prisma gets the Invalid
      // Date as a 500. A finite `days` can still land here — the Date range
      // stops at ±8.64e15 ms, so a big enough nudge overflows by arithmetic.
      if (Number.isNaN(newExpiry.getTime())) {
        throw new BadRequestException(
          'expireDays moves the expiry outside the range a date can represent.',
        );
      }
      if (newExpiry.getTime() < Date.now()) {
        throw new BadRequestException(
          'Resulting expiry date would be in the past. Use a larger positive value or a smaller negative value.',
        );
      }
      data.expiresAt = newExpiry;
    }
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      // `new Date('abc')` is an Invalid Date, not a throw, and Prisma rejects it
      // at the driver — a 500 for a typo. There is no `Number()` in this branch
      // to blame; `String()` is just as generous.
      const parsedExpiresAt = new Date(String(body.expiresAt));
      if (Number.isNaN(parsedExpiresAt.getTime())) {
        throw new BadRequestException('expiresAt must be a valid date.');
      }
      data.expiresAt = parsedExpiresAt;
    }

    // Anything that changes the underlying profile shape must be propagated
    // to Remnawave. The local mutation and durable job live in one transaction;
    // a queue outage only delays the push because the sweep can recover PENDING.
    const requiresPanelPush =
      assignedPlanId !== null
      || body.trafficLimit !== undefined
      || body.deviceLimit !== undefined
      || body.expireDays !== undefined
      || body.expiresAt !== undefined
      || body.status !== undefined;
    const carryOnto = assignedPlanLimits;
    const rotateOnto = assignedPlan;
    const planSnapshotOnto = assignedPlanSnapshot;
    // Who moved it, on the add-on events a term re-timing writes.
    const termEdit: AlignTailOptions = {
      correlationId: `admin-subscription-edit:${subscriptionId}`,
      actorType: AddOnEntitlementActorType.ADMIN,
      actorId: admin.id,
    };
    const outcome = await this.prismaService.$transaction(async (tx) => {
      let carried: QuantityLimits | null = null;
      if (carryOnto !== null) {
        // What the subscription holds ABOVE its old plan — a paid add-on (with
        // the durable model off it lives nowhere but these columns), an
        // earlier raise, a bonus — carries onto the new plan instead of being
        // written over and pushed off the panel. The same rule a paid upgrade
        // and a renewal follow (`resolvePlanChangeLimitCarry`). Read under the
        // row lock so an add-on increment committed a moment ago is part of it
        // rather than overwritten.
        const carry = await resolvePlanChangeLimitCarryInTransaction(tx, subscriptionId, carryOnto);
        carried = carry.columns;
        data.trafficLimit = carry.columns.trafficLimit;
        data.deviceLimit = carry.columns.deviceLimit;
        writtenLimits.trafficLimit = carry.columns.trafficLimit;
        writtenLimits.deviceLimit = carry.columns.deviceLimit;
      }
      if (planSnapshotOnto !== null) {
        // The plan's snapshot replaces the stored one, less the import's own
        // keys, which are carried across (`carryImportDomainKeys`), read under
        // the row lock the carry above took. Replaced wholesale, the snapshot
        // lost `sourceSubscriptionId`: on an installation moved from another
        // panel the next import of the same backup found the row by nothing
        // and created a second subscription beside it.
        const stored = await tx.subscription.findUnique({
          where: { id: subscriptionId },
          select: { planSnapshot: true },
        });
        data.planSnapshot = carryImportDomainKeys(stored?.planSnapshot ?? null, planSnapshotOnto);
      }
      if (data.deviceLimit !== undefined) {
        // WHO IS MOVING THE LIMIT, told to the trigger that stamps the
        // reduction, through a setting that is local to this transaction.
        //
        // The anti-fraud grace refuses to excuse a reduction from "unlimited"
        // because `0` is the column default and the "never synced" value as
        // much as it is unlimited — one importer sweep would otherwise silence
        // the whole customer base. That refusal is about a downgrade the
        // CUSTOMER chose. This is a human typing a number in the panel, and the
        // customer's existing devices were not an overage until they did.
        //
        // `set_config(..., true)` is transaction-local: it cannot outlive this
        // statement, cannot be left set on a pooled connection, and cannot be
        // inherited by the next writer. Every other writer of `device_limit`
        // sets nothing and records nothing, which is the behaviour that already
        // existed.
        await tx.$executeRaw`SELECT set_config('rezeis.device_limit_source', ${OPERATOR_LIMIT_SOURCE}, true)`;
      }
      let updated = await tx.subscription.update({
        where: { id: subscriptionId },
        data,
      });

      // ── THE TERM MODEL, decided by the term row and never by a flag ────────
      //
      // A PLAN ASSIGNMENT ROTATES THE TERM. The recompute builds `desired` on
      // the carried columns written above — their own share, whoever wrote it
      // (`entitlement-baseline.ts`) — and live add-ons are summed once on top:
      // the carried columns already hold their recorded share, which the
      // recompute subtracts first. The rotation keeps the TERM right as well:
      // the period on the plan the subscription is now on (the base a column
      // that cannot be read falls back to), and no queued term minted for the
      // old plan left to start later and copy the old plan's snapshot back. The
      // columns then mirror `desired`, as every other projection writer leaves
      // them.
      //
      // A queued renewal term is cancelled — its paid days are already in
      // `expiresAt`, which the new term runs to — unless it carries add-ons
      // bought for it: that paid period is not the operator's to cancel here.
      //
      // ANY OTHER WRITE OF `expiresAt` moves the tail term with it, so an
      // add-on sold "until the end of the subscription" ends when the
      // subscription does. (The rotation aligns first, for the same reason.)
      // Neither reads a rollout flag: a subscription with no term is left
      // exactly as the column path always left it.
      let projection: RecomputeProjectionResult | null = null;
      if (rotateOnto !== null && carried !== null) {
        const moved = await this.subscriptionTermHooks.rotateForPlanChangeInTransaction(
          tx,
          {
            subscriptionId,
            plan: rotateOnto,
            snapshotSource: ADMIN_PLAN_ASSIGNMENT_TERM,
            scheduledTerms: 'CANCEL_UNBOUND',
          },
          termEdit,
        );
        if (moved.outcome === 'SCHEDULED_TERMS_BLOCK') {
          // With a code the SPA puts in the operator's language (listed in
          // `SAFE_PRODUCT_CODES`, or the filter strips it); the sentence stays
          // for a client that does not know the code yet.
          throw new ConflictException({
            code: PLAN_ASSIGNMENT_REFUSAL_CODES.queuedRenewalWithAddOns,
            message:
              'A paid renewal period is queued for this subscription and carries add-ons bought for it ' +
              `(${moved.boundEntitlements}). Assigning a plan now would cancel that period, so nothing ` +
              'was changed. Assign the plan once the queued period has started.',
          });
        }
        if (moved.outcome === 'ROTATED') {
          projection = moved.projection;
          const mirrored = numericColumnsFromProjection(projection, carried);
          // The audit describes what reached the row.
          writtenLimits.trafficLimit = mirrored.trafficLimit;
          writtenLimits.deviceLimit = mirrored.deviceLimit;
          if (mirrored.trafficLimit !== updated.trafficLimit || mirrored.deviceLimit !== updated.deviceLimit) {
            updated = await tx.subscription.update({ where: { id: subscriptionId }, data: mirrored });
          }
        }
      } else if (data.expiresAt !== undefined) {
        await this.subscriptionTermHooks.followExpiryInTransaction(tx, subscriptionId, termEdit);
      }

      // A generic editor update must never provision a second panel profile
      // for an imported/legacy row whose link is missing. Creation remains an
      // explicit "give subscription" flow; operators can repair a link before
      // pushing local edits upstream.
      if (!requiresPanelPush || updated.remnawaveId === null) {
        return {
          updated,
          syncJobId: null as string | null,
          remnawaveLinkRequired: requiresPanelPush && updated.remnawaveId === null,
        };
      }

      const syncJob = await tx.profileSyncJob.create({
        data: {
          subscriptionId: updated.id,
          action: SyncAction.UPDATE,
          status: SyncJobStatus.PENDING,
          // The revision it pushes, when a projection backs the change, exactly
          // as the paid upgrade and plan migration record it.
          ...(projection === null
            ? {}
            : {
                aggregateKey: updated.id,
                desiredRevision: projection.desiredRevision,
                cause: 'PLAN_CHANGE',
              }),
          payload: {
            source: 'ADMIN_MUTATION',
            // Remnawave only receives status when the operator explicitly
            // changed it. Derived EXPIRED/LIMITED states must never be pushed.
            propagateStatus: body.status !== undefined,
          } as Prisma.InputJsonObject,
        },
        select: { id: true },
      });
      return { updated, syncJobId: syncJob.id, remnawaveLinkRequired: false };
    });

    // Written after the commit, like every other `auditLog` call in this file,
    // and BEFORE the panel push so the evidence exists even if the push path
    // throws. `assignedPlanId` is the discriminator rather than a guess from
    // the shape of the change set: a plan assignment sets all four limits AND
    // rewrites `plan_snapshot` with the plan's own, so it leaves the row
    // inherited — apart from whatever it held above its old plan, which stays
    // the row's own on the new one — while an individual edit moves a column
    // away from its snapshot on purpose.
    // Read backwards they are opposites, and only the controller knows which
    // one happened.
    await this.auditLimitChange({
      admin,
      req,
      subscription: sub,
      after: writtenLimits,
      source: assignedPlanId === null ? 'operator_edit' : 'plan_assignment',
      assignedPlanId,
    });

    if (outcome.syncJobId !== null) {
      try {
        await this.profileSyncQueueService.enqueue(outcome.syncJobId);
      } catch (error: unknown) {
        // The state and job are already durable. The periodic queue recovery
        // picks this up, so do not turn a successful edit into a false failure.
        this.systemEvents.warn(
          EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
          'SYSTEM',
          'Admin subscription update queued for deferred Remnawave sync',
          { subscriptionId, syncJobId: outcome.syncJobId, error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    if (outcome.remnawaveLinkRequired) {
      // The operator already sees this: the response flag drives a toast on the
      // user detail panel. What was missing is a DURABLE trace — the toast is
      // gone the moment the screen is closed, and the divergence it announced
      // is not: the row now holds limits, squads or an expiry that its panel
      // profile does not, with no job queued and nothing that will ever
      // reconcile the two. Weeks later, "why is this customer on the old
      // device limit" has no record to answer it.
      //
      // WARNING and not ERROR, and no refusal: refusing to save would leave an
      // operator no way to correct a row at all, and provisioning a profile
      // from a generic edit is exactly what this branch exists to prevent —
      // creation stays the explicit "give subscription" flow.
      this.systemEvents.warn(
        EVENT_TYPES.SYSTEM_REMNAWAVE_SYNC,
        'SYSTEM',
        'Admin subscription update saved locally only — no Remnawave link to push it through',
        {
          subscriptionId,
          userId: outcome.updated.userId,
          remnawavePanelUsername: outcome.updated.remnawavePanelUsername,
          // The operator card prints no message; the consequence is its note.
          note: 'Изменения сохранены только в rezeis: у подписки нет привязки к профилю Remnawave, и панель их не получит.',
        },
      );
    }

    return {
      ...outcome.updated,
      syncPending: outcome.syncJobId !== null,
      remnawaveLinkRequired: outcome.remnawaveLinkRequired,
    };
  }

  @Patch('subscriptions/:subscriptionId/squads')
  @RequirePermission('subscriptions', 'edit')
  public async updateSquads(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { internalSquads?: string[]; externalSquad?: string | null },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const sub = await this.prismaService.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new NotFoundException('Subscription not found');
    const data: Prisma.SubscriptionUpdateInput = {};
    if (body.internalSquads !== undefined) data.internalSquads = body.internalSquads;
    if (body.externalSquad !== undefined) data.externalSquad = body.externalSquad;
    const updated = await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data,
    });
    // Squads are two of the same four plan-inherited columns, and this endpoint
    // can only ever set them by hand — there is no plan assignment on this
    // route — so every change it records is an individual override.
    await this.auditLimitChange({
      admin,
      req,
      subscription: sub,
      after: {
        internalSquads: body.internalSquads,
        externalSquad: body.externalSquad,
      },
      source: 'operator_edit',
      assignedPlanId: null,
    });
    await this.enqueueSubscriptionSync(updated.id, updated.remnawaveId);
    return updated;
  }

  /**
   * Explicitly repairs a legacy local-to-panel link. Generic edits never
   * create a profile for an unlinked row: that could duplicate an existing
   * imported user. The identifier — the 3.x numeric id, see
   * {@link isLinkableRemnawaveId} — is verified against the panel before
   * persisting, and the profile that read identifies is then checked against
   * every other subscription, not just the string the operator typed.
   *
   * A ROW WITH NO LINK, OR WITH A STALE ONE. Besides an empty `remnawaveId`, it
   * overwrites one that is not a decimal (`isStalePanelIdentity`: a 2.x uuid, or
   * imported junk) — such an id names nobody on a 3.x panel, every destructive
   * path refuses it, and without this endpoint those rows had no remedy but the
   * automatic check (owner's decision, 24.09.2026). The same ownership proof
   * applies, and the audit row keeps the id it replaced. A NUMERIC link is
   * never overwritten here: that is a working link to a real profile.
   *
   * It is also where the panel-link repair and the duplicate merge send every
   * profile they refuse for want of proof, so it must be able to link one:
   * besides the `reiwa_id` line it accepts a matching Telegram id, account
   * e-mail or verified web-account e-mail, and, with none of them, the
   * operator's explicit `confirmedWithoutProof` (audited as such). A line
   * naming another customer refuses with no override (owner's decision,
   * 19.09.2026).
   */
  @Patch('subscriptions/:subscriptionId/remnawave-link')
  @RequirePermission('subscriptions', 'edit')
  public async linkRemnawaveProfile(
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: { remnawaveId?: unknown; confirmedWithoutProof?: unknown },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const pasted = typeof body.remnawaveId === 'string' ? body.remnawaveId.trim() : '';
    if (!isLinkableRemnawaveId(pasted)) {
      throw new BadRequestException(REMNAWAVE_ID_REQUIRED_MESSAGE);
    }
    // The panel's own spelling of the number, never `0042`: the stored string is
    // compared as a string by the duplicate guard below and by every later
    // lookup, and the panel only ever reports `42`. Stripped as text, not
    // through `Number`, which would round anything past 2^53.
    const remnawaveId = pasted.replace(/^0+(?=\d)/, '');

    const subscription = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        userId: true,
        remnawaveId: true,
        configUrl: true,
        user: {
          select: {
            id: true,
            telegramId: true,
            email: true,
            // For web-only customers the address lives on the web account alone.
            webAccount: { select: { email: true, emailNormalized: true, emailVerifiedAt: true } },
          },
        },
      },
    });
    if (subscription === null) throw new NotFoundException('Subscription not found');
    if (subscription.remnawaveId !== null && !isStalePanelIdentity(subscription.remnawaveId)) {
      throw new BadRequestException('Subscription already has a Remnawave profile linked');
    }

    // A bare string on purpose: the operator has just READ this identifier off
    // the panel in front of them, so it already names the profile. There is no
    // stored row to widen it from — that is the very thing this endpoint is
    // repairing.
    //
    // `getPanelUserOutcome`, not `getPanelUser`: the latter answers `null` for
    // an outage, an expired token, a 5xx and a timeout as well as for a profile
    // that genuinely is not there, and this endpoint reported all of them to
    // the operator as "profile was not found" — i.e. "your identifier is
    // wrong". A panel blip is exactly when someone is repairing a link, so the
    // one moment the endpoint is used was the one moment it lied.
    const panelOutcome = await this.remnawaveApiService.getPanelUserOutcome(remnawaveId);
    if (panelOutcome.kind === 'unavailable') {
      throw new ServiceUnavailableException(
        'The Remnawave panel could not be reached, so this profile identifier could not be verified. ' +
          'Nothing was changed — try again once the panel is answering.',
      );
    }
    if (panelOutcome.kind === 'missing') {
      throw new NotFoundException('Remnawave profile was not found');
    }
    const panelUser = panelOutcome.user;

    // ── Duplicate guard: compare the PROFILE, not the string ────────────────
    //
    // Two subscriptions addressing one panel profile is the failure this check
    // exists to prevent: a later delete on either destroys the other's live
    // profile, and every limit/device write races. `remnawaveId` carries no
    // `@unique` and no index, so this application check is the only thing
    // standing there — and it runs after the read above rather than before it
    // because the question it has to answer ("is this the same PROFILE?")
    // cannot be answered from the pasted string alone.
    //
    // A string comparison is not that check. One profile has two legitimate
    // names across the panel eras — the 2.x uuid a row linked back then still
    // stores, and the numeric id a 3.x panel shows the operator — and the two
    // forms can never compare equal. So subscription A holding profile P as
    // `330f2b38-…` and an operator repairing subscription B with the `5150` off
    // their 3.x screen both address P, and the old `findFirst` saw nothing. The
    // ownership check below does not catch it either: it verifies the USER, and
    // both rows can legitimately belong to the same one.
    //
    // Which comparisons are sound, and why only these three:
    //   • pasted string vs `remnawaveId` — the original check, and the whole
    //     answer whenever both rows were linked in the same panel era.
    //   • numeric id vs `remnawaveId` — a row linked on 3.x stores that number,
    //     in decimal, AS its identity string. The two stored forms cannot be
    //     confused: a uuid always carries `-`, so it never equals a decimal.
    //   • numeric id vs `remnawavePanelId` — the panel's immutable primary key,
    //     which BOTH eras put on every user row, so a row linked on 2.x has
    //     usually been carrying it since long before the upgrade. This is the
    //     comparison that closes the reported hole.
    //
    // NOT the username, though `remnawavePanelUsername` sits right beside those
    // and looks like it would close the last gap. A name is not an identity: an
    // operator can rename a profile in the panel (the same reason
    // `panelUserPatchKey` prefers the immutable key over the name), and a name
    // freed by a rename or a delete can be taken by a DIFFERENT profile later —
    // so a stored name can be stale, or can belong to somebody else entirely.
    // Matching on it would refuse a legitimate repair, and this endpoint is the
    // only way out of a broken link: a false refusal here leaves the operator
    // with no move at all.
    //
    // What stays open, knowingly: a row linked on 2.x that never recorded a
    // numeric id, on a panel since upgraded to 3.x. The panel has no uuid column
    // left to report, so nothing SOUND connects the two rows. That row is
    // equally unnameable to the panel adapter (`panelUserAddress` → `impossible`)
    // — already broken by the same missing fact, not by this guard.
    const profilePanelId = panelProfileNumericId(panelUser.panelId, remnawaveId);
    const namesSameProfile: Prisma.SubscriptionWhereInput[] = [{ remnawaveId }];
    if (profilePanelId !== null) {
      namesSameProfile.push(
        { remnawaveId: String(profilePanelId) },
        { remnawavePanelId: profilePanelId },
      );
    }
    const alreadyLinked = await this.prismaService.subscription.findFirst({
      where: { OR: namesSameProfile, NOT: { id: subscriptionId } },
      select: { id: true },
    });
    if (alreadyLinked !== null) {
      throw new BadRequestException('This Remnawave profile is already linked to another subscription');
    }

    // ── Whose profile it is, decided in this order ──────────────────────────
    //
    // 1. A `reiwa_id` LINE naming ANOTHER customer refuses, whatever else
    //    matches and whatever the operator confirms. The line is rezeis's own
    //    write; a Telegram id or an e-mail can be re-bound, reused or mistyped.
    //    The refusal names that customer, so the operator knows whose it is.
    // 2. Marker lines that all name THIS customer prove it.
    // 3. Otherwise a matching Telegram id, account e-mail or VERIFIED web
    //    account e-mail proves it — the last is the only address a web-only
    //    customer has, and the repair tools send exactly those customers here.
    // 4. With no proof at all, the operator may confirm it by hand. The link is
    //    written, and the audit row says it was confirmed without proof.
    //
    // The lines are read the one way every owner check reads them: a line that
    // IS the marker, never a `reiwa_id:` inside a display name.
    const markerOwners = [...new Set(readProfileOwnerMarkers(panelUser.description))];
    const otherOwners = markerOwners.filter((owner) => owner !== subscription.user.id);
    if (otherOwners.length > 0) {
      throw new BadRequestException(
        `The reiwa_id line of this Remnawave user names another customer: ${await this.describeMarkerOwners(otherOwners)}. ` +
          "It cannot be linked here, confirmed or not. Link it on that customer's card, or correct " +
          'the line in Remnawave first.',
      );
    }
    const panelEmail = panelUser.email?.trim().toLowerCase() ?? null;
    const sameEmail = (candidate: string | null | undefined): boolean =>
      panelEmail !== null &&
      panelEmail.length > 0 &&
      typeof candidate === 'string' &&
      candidate.trim().toLowerCase() === panelEmail;
    const webAccount = subscription.user.webAccount;
    const proof: 'reiwa_id' | 'telegram_id' | 'email' | 'web_account_email' | null =
      markerOwners.length > 0
        ? 'reiwa_id'
        : subscription.user.telegramId !== null &&
            panelUser.telegramId !== null &&
            subscription.user.telegramId.toString() === String(panelUser.telegramId)
          ? 'telegram_id'
          : sameEmail(subscription.user.email)
            ? 'email'
            : webAccount?.emailVerifiedAt instanceof Date &&
                (sameEmail(webAccount.email) || sameEmail(webAccount.emailNormalized))
              ? 'web_account_email'
              : null;
    const confirmedWithoutProof = proof === null && body.confirmedWithoutProof === true;
    if (proof === null && !confirmedWithoutProof) {
      throw new BadRequestException(
        "Nothing proves this Remnawave user is this customer's: no reiwa_id line names them, and " +
          "neither the Telegram id nor an e-mail matches (the account's, or the web account's once " +
          'verified). If you have checked that it is theirs, confirm that and link again.',
      );
    }

    const linked = await this.prismaService.subscription.update({
      where: { id: subscriptionId },
      data: {
        remnawaveId,
        // The verification read above already handed us the numeric id and the
        // panel's own username, so record them with the link. A repair done on
        // a 2.x panel that stored the uuid ALONE would leave exactly the row
        // that becomes unaddressable the day the operator upgrades to 3.x —
        // which is the situation this endpoint exists to get people out of.
        // `?? undefined` so a panel that omitted a field leaves the stored one
        // alone rather than clearing it.
        remnawavePanelId: panelUser.panelId ?? undefined,
        remnawavePanelUsername: panelUser.username || undefined,
        configUrl: panelUser.subscriptionUrl || subscription.configUrl,
        // Linked: nothing is left for a CREATE to look for under the name its
        // last attempt recorded (`ProfileSyncProcessor.handleCreate`).
        remnawavePendingUsername: null,
        remnawavePendingOwnerId: null,
      },
    });
    await this.auditLog(admin, req, 'user.subscription.remnawave_linked', {
      userId: subscription.userId,
      subscriptionId,
      previousRemnawaveId: subscription.remnawaveId,
      remnawaveId,
      remnawaveUsername: panelUser.username || null,
      ownershipVerifiedBy: proof ?? 'operator_confirmation',
      confirmedWithoutProof,
      configUrlChanged: (panelUser.subscriptionUrl || subscription.configUrl) !== subscription.configUrl,
    });
    return linked;
  }

  @Delete('subscriptions/:subscriptionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'delete')
  public async deleteSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const result = await this.subscriptionDeletionService.deleteByOperator(
      subscriptionId,
      admin.id,
    );

    await this.auditLog(admin, req, 'user.subscription.deleted', {
      userId: result.userId,
      subscriptionId,
      hadRemnawaveProfile: result.hadRemnawaveProfile,
    });

    return { deleted: true };
  }

  // ── Remnawave panel actions ────────────────────────────────────────────

  @Post('subscriptions/:subscriptionId/reset-traffic')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async resetTraffic(
    @Param('subscriptionId') subscriptionId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      // The two supplementary identity columns come along wherever the row is
      // handed to the panel adapter. Without them a profile created on 2.x is
      // unnameable once the panel is upgraded to 3.x, which drops the uuid this
      // row still stores.
      select: {
        remnawaveId: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        configUrl: true,
        user: { select: { isBlocked: true } },
      },
    });
    const identity = storedIdentityOf(sub);
    if (identity === null) return { reset: false, message: 'No Remnawave profile linked' };
    await this.remnawaveApiService.resetPanelUserTraffic(identity);
    // THE RESET IS A PUSH OF OURS (the owner, 24.09.2026). Recorded as one —
    // completed now, after the panel answered — so a `user.limited` Remnawave
    // stamped before the reset and delivered after it no longer puts LIMITED
    // back on a subscription in the term model (`term-model-readback.ts`).
    // The `user.enabled` the reset itself sets off is outranked the same way,
    // so the status the reset produced is read back here, at once, and written
    // by the rule every push's answer follows (`panel-answer-status.ts`) —
    // which also lifts LIMITED on an install whose webhooks are off.
    // Best-effort: the counter is zeroed whatever this bookkeeping does.
    try {
      const reset = await recordOperatorTrafficReset(this.prismaService, subscriptionId);
      const after = await this.remnawaveApiService.getPanelUserOutcome(identity);
      const answer = after.kind === 'ok' ? readPanelUserStatus(after.user.status) : null;
      const moved =
        answer === null
          ? null
          : await takePanelAnswerStatus(this.prismaService, {
              job: reset,
              answer,
              now: new Date(),
              push: { sent: null, ownerBlocked: sub?.user?.isBlocked === true },
            });
      if (moved !== null) {
        this.logger.log(
          `Subscription ${subscriptionId} is ${moved.to} (was ${moved.from}): Remnawave's answer to the traffic reset`,
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Traffic reset of ${subscriptionId}: the reset was not recorded, or its status not read back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // AFTER the panel call, like every other audited action in this file: a
    // row written first would answer "who reset this" about a reset that
    // threw. The same action name the bulk toolbar writes, so one query
    // answers the question whichever screen performed it.
    await this.auditLog(admin, req, 'user.subscription.traffic_reset', { subscriptionId });
    return { reset: true };
  }

  @Post('subscriptions/:subscriptionId/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async syncSubscription(
    @Param('subscriptionId') subscriptionId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        remnawaveId: true,
        configUrl: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        userId: true,
        trafficLimit: true,
        deviceLimit: true,
        ...TERM_MODEL_MARKER_SELECT,
        // What `expiryTaken` below compares Remnawave's date with.
        expiresAt: true,
      },
    });
    const identity = storedIdentityOf(sub);
    // Each refusal carries a stable `code` BESIDE its sentence — see
    // `subscription-sync-refusals.ts` for why the sentence alone was not
    // enough. The wording is unchanged and stays the human-readable half.
    if (identity === null) {
      return {
        synced: false,
        code: SUBSCRIPTION_SYNC_REFUSAL_CODES.notLinked,
        message: 'No Remnawave profile linked',
      };
    }
    // Same distinction the link-repair endpoint makes, and for the same reason:
    // this answer goes straight to an operator. `getPanelUser` reports an
    // outage, an expired token, a 5xx and a timeout with the identical `null`
    // it uses for a genuinely missing profile, so the old message told an
    // operator their profile was gone whenever the panel merely blinked — and
    // "gone" is what makes someone start repairing a link that was never broken.
    //
    // Timed BEFORE the request: a subscription in the term model takes the
    // expiry from this read only when nothing rezeis pushed landed after it —
    // a push that completes while the answer travels is newer than the answer
    // (`term-model-readback.ts`).
    const readAt = new Date();
    const outcome = await this.remnawaveApiService.getPanelUserOutcome(identity);
    if (outcome.kind === 'unavailable') {
      return {
        synced: false,
        code: SUBSCRIPTION_SYNC_REFUSAL_CODES.panelUnavailable,
        message: 'Remnawave panel could not be reached — try again',
      };
    }
    if (outcome.kind === 'missing') {
      return {
        synced: false,
        code: SUBSCRIPTION_SYNC_REFUSAL_CODES.profileMissing,
        message: 'Profile not found on panel',
      };
    }
    const panelUser = outcome.user;
    // WHAT THIS BUTTON IS ALLOWED TO WRITE, and why it is not the importer's
    // write set — the full derivation, from what `ProfileSyncProcessor`
    // actually pushes, lives in `panel-field-ownership.ts`.
    //
    // This subscription is one rezeis PROVISIONS: the sync processor pushes the
    // plan's traffic limit, device limit, squads and expiry INTO the panel on
    // every mutation. Pulling those columns back out of a panel answer would
    // let panel drift silently replace the plan an operator assigned, and the
    // next push would then fight the pull. `parsePanelUserRow` makes it worse
    // than a race: it defaults an absent `trafficLimitBytes`/`hwidDeviceLimit`
    // to `0` and an absent squad list to `[]`, so a thin panel answer would
    // read as "unlimited traffic, no devices, no squads" and write exactly
    // that over the operator's settings.
    //
    // So the refresh adopts ONLY what the panel alone can know, and adopts
    // nothing the panel did not positively state — see `panelRefreshWrites`.
    const stated = panelRefreshWrites(panelUser);
    // A subscription in the term model follows the rule every Remnawave
    // read-back shares (`term-model-readback.ts`): the expiry is taken only
    // when nothing rezeis pushed landed after `readAt` — this button used to
    // roll a paid renewal back to the date its push had not yet reached — and
    // a profile holding other limits than rezeis would push gets rezeis' own
    // pushed back. The limits were never taken here in any case.
    const verdict = await judgePanelRowReadback(this.prismaService, {
      existing: sub === null ? null : { ...sub, id: subscriptionId },
      panel: panelUser,
      readAt,
      claims: [
        ...panelProfileClaims(panelUser),
        ...(sub?.remnawaveId == null ? [] : [{ remnawaveId: sub.remnawaveId }]),
      ],
    });
    // Outside the model too, a subscription with no end takes no date from
    // Remnawave (`withLocalOpenEndKept`): the date an older CREATE gave a
    // lifetime profile (thirty days), or one set in Remnawave's own UI, would
    // have ended a subscription sold for ever. In the model the verdict says so
    // (`keepsOpenEnd`).
    const refreshed: PanelRefreshWrites =
      verdict === null
        ? withLocalOpenEndKept(stated, sub?.expiresAt)
        : withoutWithheldReadbackFields(stated, verdict);
    if (Object.keys(refreshed).length > 0) {
      await this.prismaService.$transaction(async (tx) => {
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: refreshed,
        });
        // The pull moves `expiresAt` to whatever the panel holds — forward, or
        // BACK to a date an extension that never reached the panel did not
        // move. The tail term follows it either way, in the same transaction,
        // so the add-ons that end with the subscription show the date it now
        // ends on.
        if (refreshed.expiresAt !== undefined) {
          await this.subscriptionTermHooks.followExpiryInTransaction(tx, subscriptionId, {
            correlationId: `admin-subscription-refresh:${subscriptionId}`,
            actorType: AddOnEntitlementActorType.ADMIN,
            actorId: admin.id,
          });
        }
      });
    }
    // After the write: the push is built from the columns when it runs, and
    // must carry the expiry this read may just have brought in.
    const readbackInput = {
      subscriptionId,
      profile: panelUser.uuid,
      source: 'Refresh from Remnawave',
    };
    const limitsPutBack =
      verdict === null
        ? null
        : await finishTermModelReadback(this.prismaService, verdict, {
            ...readbackInput,
            logger: this.logger,
            enqueue: (syncJobId) => this.profileSyncQueueService.enqueue(syncJobId),
          });
    const limitsNote = verdict === null ? null : describeLimitsVerdict(verdict.limits, readbackInput);
    // The same action name the all-subscriptions button writes, with the one
    // subscription named — so "who re-synced this" is one query whether the
    // operator pushed one row or all of them. In the term model the audit row
    // also says what became of the expiry and the limits the panel reported,
    // so a put-back, or the reason for none, is on record beside the press.
    await this.auditLog(admin, req, 'user.sync.requested', {
      subscriptionId,
      refreshed: Object.keys(refreshed),
      ...(verdict === null
        ? {}
        : {
            panelLimits: verdict.limits,
            expiryTaken: verdict.takeExpiry,
            ...(limitsPutBack === null ? {} : { limitsPutBackSyncJobId: limitsPutBack }),
            ...(limitsNote === null ? {} : { panelLimitsNote: limitsNote }),
          }),
    });
    // The same verdict, for the card the operator pressed ↻ on — which would
    // otherwise go on printing a drift the put-back is already fixing. Only in
    // the term model, where the verdict exists at all; `sub` is the row it was
    // judged on, so its columns are the limits the put-back sends.
    //
    // `expiryTaken` is `false` only when a push of rezeis' own WITHHELD an
    // expiry: the read is outranked, and Remnawave stated one (a date, or no
    // end) that differs from the row's. The card then says the change has
    // not reached Remnawave yet, which is the reason in exactly that case. The
    // audit row above keeps the verdict itself. Told "not taken" over two
    // equal dates, the card warned on every press while any push was queued,
    // running or failed — and after a failed one, for good.
    const statedExpiry = stated.expiresAt;
    const expiryWithheld =
      verdict !== null &&
      !verdict.takeExpiry &&
      statedExpiry !== undefined &&
      (statedExpiry?.getTime() ?? null) !== (sub?.expiresAt?.getTime() ?? null);
    const readback: SubscriptionSyncReadback | null =
      verdict === null || sub === null
        ? null
        : {
            panelLimits: SYNC_PANEL_LIMITS[verdict.limits],
            expiryTaken: !expiryWithheld,
            limitsPutBack:
              limitsPutBack === null
                ? null
                : { syncJobId: limitsPutBack, trafficLimit: sub.trafficLimit, deviceLimit: sub.deviceLimit },
          };
    // What the panel says about the columns rezeis owns. Echoed so the drift is
    // VISIBLE, never written — an operator who sees the panel reporting a
    // different device limit has a real problem to act on, and the act is to
    // fix the plan, not to let the panel rewrite it.
    const panelReports = panelReportedRezeisOwnedFields(panelUser);
    // `refreshed`: what actually changed, so the operator is not told "synced"
    // and left to guess. Keys are present only when the panel stated the field.
    // `readback` only in the term model: any other answer is exactly what an
    // older client already reads.
    if (readback === null) return { synced: true, refreshed, panelReports };
    return { synced: true, refreshed, panelReports, readback };
  }

  /**
   * Device list for the operator's user panel.
   *
   * `deviceCount: 0` here means "this subscription has no Remnawave profile",
   * a fact we hold locally. A PANEL read that did not answer is NOT allowed to
   * produce the same payload — it used to, and an operator triaging "the
   * customer says they can't add a device" read a confident 0 while the panel
   * was down. `requirePanelDeviceList` turns that into a 5xx, which
   * `DevicesSection` in the admin SPA already renders as its
   * `devicesList.loadError` line instead of `devicesList.empty`.
   */
  @Get('subscriptions/:subscriptionId/devices')
  public async getDevices(@Param('subscriptionId') subscriptionId: string) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: { remnawaveId: true, remnawavePanelId: true, remnawavePanelUsername: true, configUrl: true },
    });
    const identity = storedIdentityOf(sub);
    if (identity === null) return { devices: [], deviceCount: 0 };
    const result = requirePanelDeviceList(
      await this.remnawaveApiService.strictGetPanelUserDevices(identity),
    );
    return { devices: result.devices, deviceCount: result.total };
  }

  @Delete('subscriptions/:subscriptionId/devices/:hwid')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'delete')
  public async revokeDevice(
    @Param('subscriptionId') subscriptionId: string,
    @Param('hwid') hwid: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const sub = await this.prismaService.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        remnawaveId: true,
        configUrl: true,
        remnawavePanelId: true,
        remnawavePanelUsername: true,
        planSnapshot: true,
        userId: true,
        user: { select: { telegramId: true, username: true, name: true } },
      },
    });
    // Split out of the `identity === null` test below rather than folded into
    // it. `storedIdentityOf` answers `null` for a missing row and for a row with
    // no panel profile alike, so one test did cover both — but the event payload
    // further down reads the row field by field, and nothing there could see
    // which of the two cases had been ruled out. Same exception, same message:
    // the two were never distinguishable to the operator and still are not.
    if (sub === null) throw new NotFoundException('No Remnawave profile linked');
    const identity = storedIdentityOf(sub);
    if (identity === null) throw new NotFoundException('No Remnawave profile linked');

    // ── THE STALE-LINK REFUSAL, ON THE DEVICE VERB ─────────────────────────
    //
    // The same hazard as the subscription delete this controller already
    // refuses, reached through a different verb: `deletePanelUserDevice` names
    // its owner through the SAME `panelUserAddress` fallback, so a stored
    // identity that is not a decimal resolves through the recorded panel id,
    // the saved subscription short uuid or the panel username to whatever
    // account is LIVE at that address — on an unrepaired duplicate pair, a
    // paying customer, whose device this would then unbind.
    //
    // The adapter refuses the same identity (`StalePanelIdentityRefusal`); this
    // check is what turns the refusal into a 409 with a code the SPA branches
    // on. OPERATOR WORDING, unlike the two reiwa-facing sites: this reader can
    // open the list the sentence names.
    if (isStalePanelIdentity(identity.remnawaveId)) {
      throw new ConflictException(staleDeviceDeleteRefusalBody('operator'));
    }

    const result = await this.remnawaveApiService.deletePanelUserDevice(identity, hwid);

    this.systemEvents.info(
      EVENT_TYPES.SUBSCRIPTION_DEVICE_REVOKED,
      'DEVICE',
      `Device revoked by admin: ${hwid}`,
      {
        userId: sub.userId,
        telegramId: sub.user?.telegramId ? String(sub.user.telegramId) : null,
        userName: sub.user?.name ?? sub.user?.username ?? sub.userId,
        username: sub.user?.username ?? null,
        subscriptionId,
        remnawaveId: sub.remnawaveId,
        ...planNamesMetadata([sub.planSnapshot]),
        hwid,
        remainingDevices: result.total,
        source: 'ADMIN_PANEL',
        adminId: admin.id,
      },
    );

    // A system event is not an audit row: the feed is a timeline operators
    // watch, the audit log is what answers "who did this" months later, and
    // only one of the two is queried by admin. Both, then — this action is not
    // undoable and the customer feels it immediately.
    // SINGULAR, and deliberately NOT the bulk toolbar's
    // `user.subscription.devices_revoked`. The other two actions on this
    // controller share a name with their bulk twin because they are the same
    // act at a different scale — a traffic reset is a traffic reset. This one
    // is not: bulk unbinds EVERY device on every profile the customer has,
    // while this unbinds one named `hwid`. Collapsing them would make "all
    // devices were cut off" and "one device was cut off" indistinguishable in
    // the trail, which is the question the customer actually asks.
    await this.auditLog(admin, req, 'user.subscription.device_revoked', {
      subscriptionId,
      hwid,
      remainingDevices: result.total,
    });

    return { revoked: true, remainingDevices: result.total };
  }

  // ── Give Subscription / Grant Trial ────────────────────────────────────

  @Post(':telegramId/give-subscription')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'create')
  public async giveSubscription(
    @Param('telegramId') telegramId: string,
    @Body() body: { planId: string; durationDays: number; isTrial?: boolean },
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    // Not a deleted plan: the give-subscription picker never lists one.
    const plan = await this.prismaService.plan.findUnique({ where: { id: body.planId, deletedAt: null } });
    if (!plan) throw new NotFoundException('Plan not found');

    if (body.isTrial === true) {
      const granted = await this.subscriptionMutationsService.grantTrial({
        userId: user.id,
        planId: plan.id,
        durationDays: body.durationDays,
      });
      const subscription = await this.prismaService.subscription.findUniqueOrThrow({
        where: { id: granted.subscriptionId },
      });
      await this.auditLog(admin, req, 'user.subscription.given', {
        userId: user.id,
        subscriptionId: subscription.id,
        planId: plan.id,
        durationDays: body.durationDays,
        isTrial: true,
      });
      return subscription;
    }

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + body.durationDays * 24 * 60 * 60 * 1000);

    const subscription = await this.prismaService.$transaction(async (tx) => {
      const created = await tx.subscription.create({
        data: {
          userId: user.id,
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          planSnapshot: buildPlanSnapshot(plan),
          trafficLimit: plan.trafficLimit,
          deviceLimit: plan.deviceLimit,
          internalSquads: plan.internalSquads,
          externalSquad: plan.externalSquad,
          startedAt,
          expiresAt,
        },
      });
      // Its first term, in the same transaction, while stage 1 is on: an add-on
      // bought on it a minute later is then ledgered with an end date, not the
      // permanent increment a subscription outside the model still gets.
      await this.subscriptionTermHooks.enterNewSubscriptionInTransaction(tx, created.id);
      return created;
    });

    await this.auditLog(admin, req, 'user.subscription.given', {
      userId: user.id,
      subscriptionId: subscription.id,
      planId: plan.id,
      durationDays: body.durationDays,
    });

    // Enqueue sync-job so the worker creates the Remnawave profile.
    await this.enqueueSubscriptionSync(subscription.id, subscription.remnawaveId);

    return subscription;
  }

  @Post(':telegramId/grant-trial')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'create')
  public async grantTrial(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    // The same selection the cabinet's trial button makes, from the same
    // function — see `selectGrantableTrialPlan`. What stood here was a local
    // `findFirst` with no `orderBy` on the plan and none on `durations`, then
    // `durations[0]`: with two active trial plans (a remnashop import can create
    // them) or one plan carrying several durations, this button and the
    // cabinet's handed out DIFFERENT products, picked by whatever order the
    // database happened to return.
    //
    // Still deliberately absent: `computeTrialEligibility`. The invited-only
    // scope and the "no active subscription" guard are user-facing rules an
    // operator overrides on purpose from this screen. WHICH plan gets granted is
    // not one of those rules — it is the same question the cabinet asks, and two
    // answers to it is only ever a defect.
    const trialPlan = await selectGrantableTrialPlan(this.prismaService);
    if (!trialPlan) throw new BadRequestException('No active trial plan configured');
    // Both refusals keep their exact condition and their exact wording; only
    // WHICH row is examined changed.
    if (trialPlan.durationDays === null) {
      throw new BadRequestException('Trial plan has no duration configured');
    }

    const granted = await this.subscriptionMutationsService.grantTrial({
      userId: user.id,
      planId: trialPlan.id,
      durationDays: trialPlan.durationDays,
    });
    const subscription = await this.prismaService.subscription.findUniqueOrThrow({
      where: { id: granted.subscriptionId },
    });

    await this.auditLog(admin, req, 'user.trial.granted', {
      userId: user.id,
      subscriptionId: subscription.id,
    });

    return subscription;
  }

  // ── Mass sync ──────────────────────────────────────────────────────────

  /**
   * Enqueues a profile-sync for every non-deleted subscription owned by
   * the user. Donor parity: `RemnawaveService.sync_profiles_by_telegram_id`
   * in altshop, except we key the lookup by `User.id` (CUID) — our reiwa
   * id is the stable cross-channel identifier, regardless of whether the
   * user has a `telegramId` at all.
   */
  @Post(':telegramId/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('subscriptions', 'edit')
  public async syncAllUserSubscriptions(
    @Param('telegramId') telegramId: string,
    @CurrentAdmin() admin: CurrentAdminInterface,
    @Req() req: Request,
  ) {
    const user = await this.findUserByTelegramId(telegramId);
    const subscriptions = await this.prismaService.subscription.findMany({
      where: {
        userId: user.id,
        NOT: { status: SubscriptionStatus.DELETED },
      },
      select: { id: true, remnawaveId: true },
    });
    for (const subscription of subscriptions) {
      await this.enqueueSubscriptionSync(subscription.id, subscription.remnawaveId);
    }
    await this.auditLog(admin, req, 'user.sync.requested', {
      userId: user.id,
      enqueuedCount: subscriptions.length,
    });
    return { enqueued: subscriptions.length };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Enqueues a profile-sync job for a single subscription.
   *
   * - If the subscription has no `remnawaveId` yet → CREATE.
   * - Otherwise → UPDATE.
   *
   * The actual call into Remnawave happens in the BullMQ worker
   * (`ProfileSyncProcessor`), keeping HTTP latency low and giving us
   * automatic retry/backoff on transient panel errors.
   */
  private async enqueueSubscriptionSync(
    subscriptionId: string,
    remnawaveId: string | null,
  ): Promise<void> {
    const job = await this.prismaService.profileSyncJob.create({
      data: {
        subscriptionId,
        action: remnawaveId === null ? SyncAction.CREATE : SyncAction.UPDATE,
        status: SyncJobStatus.PENDING,
        payload: { source: 'ADMIN_MUTATION' } as Prisma.InputJsonObject,
      },
    });
    await this.profileSyncQueueService.enqueue(job.id);
  }

  /**
   * The route param accepts either a numeric Telegram id or a CUID (internal
   * user id); numeric is tried first.
   *
   * Digits that overflow Postgres `int8` have no second branch to fall through
   * to — no row can hold that value, and an all-digit string is not a CUID
   * either — so 404 is the truthful answer. Binding it anyway reached Postgres
   * and came back as `22003 numeric field value out of range`, i.e. a 500.
   */
  private async findUserByTelegramId(telegramId: string) {
    const isNumeric = /^\d+$/.test(telegramId);
    const numericId = isNumeric ? parseTelegramId(telegramId) : null;
    if (isNumeric && numericId === null) throw new NotFoundException('User not found');
    const user = numericId !== null
      ? await this.prismaService.user.findFirst({
          where: { telegramId: numericId },
        })
      : await this.prismaService.user.findUnique({
          where: { id: telegramId },
        });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Records that an operator moved one or more of the four plan-inherited
   * limit columns — and NOTHING when the request moved none of them.
   *
   * The empty-change guard is the point, not a saving: this log is the evidence
   * a repair job reads to tell a deliberate override from drift
   * ({@link SUBSCRIPTION_LIMITS_CHANGED_ACTION}), and an entry for a PATCH that
   * re-sent the values a row already held would be a false positive that pins
   * that row's limits for the rest of its life.
   */
  private async auditLimitChange(input: {
    readonly admin: CurrentAdminInterface;
    readonly req: Request;
    readonly subscription: SubscriptionLimitValues & {
      readonly id: string;
      readonly userId: string;
    };
    readonly after: SubscriptionLimitWrite;
    readonly source: SubscriptionLimitChangeSource;
    readonly assignedPlanId: string | null;
  }) {
    const changes = diffSubscriptionLimits(input.subscription, input.after);
    if (Object.keys(changes).length === 0) return;
    await this.auditLog(input.admin, input.req, SUBSCRIPTION_LIMITS_CHANGED_ACTION, {
      userId: input.subscription.userId,
      subscriptionId: input.subscription.id,
      source: input.source,
      assignedPlanId: input.assignedPlanId,
      changes,
    });
  }

  /**
   * The customers a `reiwa_id` line names, in words the operator can act on
   * and the safe filter lets through — NEVER the line's own value. That value
   * is text from the panel, and one shaped like a UUID, 24 hex characters,
   * `sub_…` or the word "token" makes `AdminSafeExceptionFilter` replace the
   * WHOLE refusal, which then no longer says whose the profile is. A Telegram
   * ID is digits, and it is what the customer card opens by.
   */
  private async describeMarkerOwners(ownerIds: readonly string[]): Promise<string> {
    const known = await this.prismaService.user.findMany({
      where: { id: { in: [...ownerIds] } },
      select: { id: true, telegramId: true },
    });
    const descriptions = ownerIds.map((ownerId) => {
      const owner = known.find((row) => row.id === ownerId);
      if (owner === undefined) return 'an account this panel does not have';
      return owner.telegramId !== null
        ? `the customer with Telegram ID ${owner.telegramId.toString()}`
        : 'a customer with no Telegram ID, named by the reiwa_id line in Remnawave';
    });
    return [...new Set(descriptions)].join('; ');
  }

  private async auditLog(
    admin: CurrentAdminInterface,
    req: Request,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    const rm = extractRequestMetadata(req);
    await this.prismaService.adminAuditLog.create({
      data: {
        action,
        ipAddress: rm.remoteAddress,
        userAgent: rm.userAgent,
        metadata: { requestId: rm.requestId, ...metadata } as Prisma.InputJsonObject,
        adminUser: { connect: { id: admin.id } },
      },
    });
  }
}
