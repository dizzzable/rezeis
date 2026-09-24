import { Prisma, SubscriptionStatus, SyncAction } from '@prisma/client';

import type { PrismaService } from '../../common/prisma/prisma.service';
import {
  isInTermModel,
  newerPanelPushPending,
  TERM_MODEL_MARKER_SELECT,
} from '../remnawave/services/term-model-readback';

/**
 * THE STATUS REMNAWAVE ANSWERS A PUSH WITH, written back onto a subscription
 * in the durable term model. It is the fresh status the rule every Remnawave
 * read-back shares (`term-model-readback.ts`) cannot take from a report the
 * same push outranks.
 *
 * ── Why the answer is fresh ────────────────────────────────────────────────
 *
 * `PATCH /api/users` and `POST /api/users` answer `UserResponseDto`, whose
 * `status` is required on 3.2.1 to 3.4.4, and the PATCH's is the status AFTER
 * the change: Remnawave's `updateUser` lifts LIMITED to ACTIVE when the limit
 * goes up or becomes unlimited, and EXPIRED to ACTIVE when the expiry moves
 * into the future, in the same call, and answers with the row it wrote. The
 * reset of the counter answers with the row re-read after it (LIMITED lifted).
 * A top-up leaves the local row LIMITED — the status is Remnawave's to derive —
 * so, with the late `user.limited` rightly withheld, nothing else would ever
 * tell the row that the customer can pass traffic again.
 *
 * ── What it may move ───────────────────────────────────────────────────────
 *
 * Among ACTIVE, LIMITED and EXPIRED — the statuses Remnawave derives — never
 * against the panel's own clock:
 *
 *  - never ACTIVE → EXPIRED. Ending a subscription the panel still counts as
 *    running is `AutoRenewService`'s: it holds a row ACTIVE past its date while
 *    autopay retries remain, and announces the expiry when it ends it;
 *  - never EXPIRED while the panel's own date runs, and never ACTIVE or LIMITED
 *    once it has passed. An answer of ACTIVE for a date already gone is a panel
 *    behind its own expiry job; LIMITED there would take the row out of the
 *    autopay retries as surely as EXPIRED.
 *
 * DISABLED is never derived: somebody switched the profile off. Who, the push
 * itself tells (the owner, 24.09.2026, R1-03):
 *
 *  - INTO DISABLED when this push sent no status and the owner is not blocked.
 *    A PATCH without a status leaves the profile's as it was, and our own
 *    switch-offs — the operator's toggle, a block — send one. So the answer's
 *    DISABLED is a switch-off made in Remnawave's own UI, whose `user.disabled`
 *    this very push outranked; without this the row stayed ACTIVE, autopay
 *    charged it, and nothing later corrected it. A blocked owner's answer says
 *    DISABLED because the push sent it, and the row keeps its status on
 *    purpose: written DISABLED, the unblock would push DISABLED back.
 *  - OUT OF DISABLED only to ACTIVE, and only when either
 *      · this push itself sent ACTIVE — the operator's own switch-on, or the
 *        unblock; or
 *      · it sent no status, the owner is not blocked, and the DISABLED is not
 *        the panel's own: the latest push of ours that decided a status did
 *        not send DISABLED (`statusSent`, recorded by `ProfileSyncProcessor`
 *        when a PATCH carries one). That is a DISABLED an earlier Remnawave
 *        read brought, lifted in Remnawave's UI while this push was on its way.
 *    A decision whose value was never recorded (made before this release)
 *    counts as the panel's own: an operator's switch-off is never undone on a
 *    guess.
 *
 * And only from the push that is newest: one created after it and not yet
 * completed carries a later state of ours (`newerPanelPushPending`).
 *
 * Rows outside the model keep today's behaviour: the answer is not read for
 * them. The webhook takes every report there as it arrives, the echo of this
 * very push (`user.modified`, the same row) included.
 */

/** The four statuses a panel profile can have. */
const PANEL_STATUSES: ReadonlyMap<string, SubscriptionStatus> = new Map([
  ['ACTIVE', SubscriptionStatus.ACTIVE],
  ['LIMITED', SubscriptionStatus.LIMITED],
  ['EXPIRED', SubscriptionStatus.EXPIRED],
  ['DISABLED', SubscriptionStatus.DISABLED],
]);

/** The three Remnawave derives on its own. */
const DERIVED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.LIMITED,
  SubscriptionStatus.EXPIRED,
]);

/**
 * `payload` key of a sync job that SENT a status: `'ACTIVE'` or `'DISABLED'`,
 * written by `ProfileSyncProcessor` once the PATCH carrying it succeeded. The
 * record of the panel's own status decisions the rule above reads.
 */
export const STATUS_SENT_KEY = 'statusSent';

/**
 * A panel answer's `status`; `null` for a status this build does not know,
 * and for an answer that carries none — nothing validates a panel body on its
 * way here.
 */
export function readPanelUserStatus(raw: unknown): SubscriptionStatus | null {
  if (typeof raw !== 'string') return null;
  return PANEL_STATUSES.get(raw.trim().toUpperCase()) ?? null;
}

/** What the push itself said about the status. */
export interface PanelAnswerPush {
  /** The status its PATCH carried (an operator's toggle, a block, an unblock), or `null` for none. */
  readonly sent: 'ACTIVE' | 'DISABLED' | null;
  /** The owner is blocked when the push ran. */
  readonly ownerBlocked: boolean;
}

/**
 * THE RULE: the status a row in the model takes from an answer saying
 * `answer`, or `null` to leave it as it is. `disabledByPanel` is only read for
 * a DISABLED row: whether the panel's own latest status decision was (or may
 * have been) DISABLED. See the file comment for each arm.
 */
export function panelAnswerStatusMove(
  row: { readonly status: SubscriptionStatus; readonly expiresAt: Date | null },
  answer: SubscriptionStatus,
  now: Date,
  push: PanelAnswerPush,
  disabledByPanel: boolean,
): SubscriptionStatus | null {
  if (answer === row.status) return null;
  if (answer === SubscriptionStatus.DISABLED) {
    return DERIVED_STATUSES.has(row.status) && push.sent === null && !push.ownerBlocked ? answer : null;
  }
  if (!DERIVED_STATUSES.has(answer)) return null;
  const ended = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
  if (row.status === SubscriptionStatus.DISABLED) {
    const enabledHere = push.sent === 'ACTIVE';
    const enabledInRemnawave = push.sent === null && !push.ownerBlocked && !disabledByPanel;
    return answer === SubscriptionStatus.ACTIVE && (enabledHere || enabledInRemnawave) && !ended ? answer : null;
  }
  if (!DERIVED_STATUSES.has(row.status)) return null;
  if (answer === SubscriptionStatus.EXPIRED) {
    return ended && row.status !== SubscriptionStatus.ACTIVE ? answer : null;
  }
  return ended ? null : answer;
}

/** What an answer moved. */
export interface PanelAnswerStatusMoved {
  readonly from: SubscriptionStatus;
  readonly to: SubscriptionStatus;
}

/**
 * Whether the panel's own latest status decision for a row was, or may have
 * been, DISABLED — asked only to lift a DISABLED row. The decisions are the
 * pushes that sent a status or were queued to (`propagateStatus`); this job
 * itself sent none, and is left out.
 */
async function panelOwnDisable(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  jobId: string,
): Promise<boolean> {
  const decision = await tx.profileSyncJob.findFirst({
    where: {
      subscriptionId,
      id: { not: jobId },
      supersededAt: null,
      action: { in: [SyncAction.UPDATE, SyncAction.CREATE] },
      OR: [
        { payload: { path: ['propagateStatus'], equals: true } },
        { payload: { path: [STATUS_SENT_KEY], equals: 'ACTIVE' } },
        { payload: { path: [STATUS_SENT_KEY], equals: 'DISABLED' } },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { payload: true },
  });
  if (decision === null) return false;
  const payload = decision.payload;
  const sent =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)[STATUS_SENT_KEY]
      : undefined;
  return sent !== 'ACTIVE';
}

/**
 * Writes the status an answer reports onto the subscription `job` pushed, when
 * the row is in the model and {@link panelAnswerStatusMove} allows it.
 *
 * UNDER THE ROW'S LOCK, because the question "is a newer push on its way" and
 * the write must not be split by one. A renewal writes ACTIVE and queues its
 * UPDATE in one transaction: it has either committed before the lock is
 * granted — and its push, newer than this one, is seen — or it waits for this
 * write and lands after it. Without the lock, an older push's EXPIRED could
 * fall between the two and overwrite the renewal it never saw.
 *
 * Returns what moved, or `null`.
 */
export async function takePanelAnswerStatus(
  prisma: PrismaService,
  input: {
    readonly job: { readonly id: string; readonly subscriptionId: string; readonly createdAt: Date };
    readonly answer: SubscriptionStatus;
    readonly now: Date;
    readonly push: PanelAnswerPush;
  },
): Promise<PanelAnswerStatusMoved | null> {
  const subscriptionId = input.job.subscriptionId;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`);
    const row = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: { status: true, expiresAt: true, ...TERM_MODEL_MARKER_SELECT },
    });
    if (row === null || !isInTermModel(row)) return null;
    // Read only when it can decide something: lifting a DISABLED on a push
    // that sent no status.
    const disabledByPanel =
      row.status === SubscriptionStatus.DISABLED &&
      input.answer === SubscriptionStatus.ACTIVE &&
      input.push.sent === null &&
      !input.push.ownerBlocked
        ? await panelOwnDisable(tx, subscriptionId, input.job.id)
        : true;
    const to = panelAnswerStatusMove(row, input.answer, input.now, input.push, disabledByPanel);
    if (to === null) return null;
    if (await newerPanelPushPending(tx, input.job)) return null;
    await tx.subscription.update({ where: { id: subscriptionId }, data: { status: to } });
    return { from: row.status, to };
  });
}
