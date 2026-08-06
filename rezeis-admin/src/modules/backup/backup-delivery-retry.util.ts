import type { NotifyDeliveryResult } from '../notifications/services/bot-notifier.client';

/**
 * Which relay outcomes are worth another BullMQ attempt.
 * ─────────────────────────────────────────────────────
 * `backup.deliver-telegram` is queued with `attempts: 3`, but BullMQ only
 * retries a job whose processor THROWS — and the processor used to return
 * `{ delivered }` for every outcome, so those attempts had never once fired.
 * Making it throw is only half the decision; the other half is WHICH failures
 * deserve it, because a retry is not free: the relay hands the bot a download
 * token and the bot uploads the file itself, so a second attempt can put a
 * second copy of the backup in the operator's Telegram topic.
 *
 * The trade is duplicate file vs. no off-site copy at all, and it is not the
 * same trade for every status:
 *
 *  - `timeout` → RETRY. We aborted at 4s without hearing back. The bot may
 *    already have fetched and uploaded the file, so a retry may well duplicate
 *    it — but it may equally have never received the instruction. An extra
 *    50 MB in a backup topic is an annoyance; a backup that exists only on the
 *    machine it is meant to survive is the thing this whole feature exists to
 *    prevent. Retry.
 *
 *  - `failed` → RETRY. `fetch` threw before any response: DNS, refused
 *    connection, socket reset. The likeliest reading is that nothing reached
 *    reiwa at all, so this is the cheapest retry of the set and the one most
 *    likely to succeed.
 *
 *  - `rejected` → RETRY ONLY WHAT THE TRANSPORT CALLS TEMPORARY. A 5xx (or
 *    408/429) is reiwa or the bot having a bad moment; the identical payload
 *    succeeds a few seconds later. Any other 4xx is reiwa refusing THIS
 *    request — a bad signature, an unknown chat id, an event it does not
 *    handle. Ten seconds later it refuses it identically, so two more attempts
 *    buy nothing except a 30-second delay on telling the operator.
 *
 *  - `unconfirmed` → NOT RETRIED, and this is the close call.
 *
 *    It means reiwa answered 2xx but named no Telegram message id: either a
 *    204, or a 200 whose body carried none. The instruction was accepted and
 *    we simply have no proof of what became of it — which makes it the status
 *    most likely to mean the delivery actually worked.
 *
 *    The argument for retrying is consistency: this codebase has already
 *    decided that a backup is delivered only when Telegram gives a message id,
 *    and `unconfirmed` fails that test, so it is an undelivered backup and
 *    undelivered backups should be retried.
 *
 *    The argument against — the one taken here — is that `unconfirmed` is the
 *    only failure in this set that is SYSTEMATIC rather than incidental. A
 *    timeout or a 502 happens to some deliveries; a reiwa build that does not
 *    echo `messageId` produces `unconfirmed` for EVERY delivery, forever,
 *    across a whole deployment pair. Retrying an incidental failure costs at
 *    worst one duplicate on the rare occasions it fires. Retrying a systematic
 *    one turns every nightly backup into three uploads of the same file into
 *    the same topic — and still ends in "not delivered", because the reason we
 *    got no message id is that this responder never sends one. A retry earns
 *    its cost only when it might change the answer, and here it cannot.
 *
 *    Nothing is silently lost by declining: the record is still stamped
 *    local-only, the operator is still alerted on the spot, and retention
 *    already favours sole copies over duplicated ones. The price is a genuinely
 *    truncated response that a second attempt would have completed — bounded,
 *    visible, and far cheaper than the alternative.
 *
 *  - `confirmed` → delivered; nothing to retry.
 *  - `disabled` → REIWA_URL/WEBHOOK_SECRET_HEADER are unset. No number of
 *    attempts configures them.
 */
export function isRetryableRelayOutcome(outcome: NotifyDeliveryResult): boolean {
  switch (outcome.status) {
    case 'timeout':
    case 'failed':
      return true;
    case 'rejected':
      // `httpStatus` is always set for `rejected`; if that ever stops being
      // true, treat the unknown as transient rather than burying a backup.
      return outcome.httpStatus === null || isTransientHttpStatus(outcome.httpStatus);
    case 'unconfirmed':
    case 'confirmed':
    case 'disabled':
      return false;
    default:
      return false;
  }
}

/** 5xx plus the two 4xx codes that explicitly mean "ask again". */
function isTransientHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** The shape of a BullMQ `Job` this module needs to count attempts. */
export interface AttemptCountedJob {
  readonly attemptsMade: number;
  readonly opts?: { readonly attempts?: number };
}

/**
 * Whether the attempt CURRENTLY RUNNING inside the processor is the last one
 * BullMQ will make.
 *
 * bullmq 5 increments `attemptsMade` *after* the processor settles — the
 * counter is bumped inside `Job.moveToFailed`/`moveToCompleted`, and its own
 * type calls it "number of attempts after the job has failed". So inside the
 * processor it counts attempts that have already failed: attempt 1 sees 0,
 * attempt 3 of 3 sees 2. (`attemptsStarted` is the one that counts the running
 * attempt.) BullMQ's own retry gate is `attemptsMade + 1 < opts.attempts`;
 * this is exactly that predicate negated, and
 * `test/backup-telegram-delivery-retry.spec.ts` pins it against the installed
 * `Job.shouldRetryJob` so an upgrade that flips the base fails there rather
 * than silently alerting on attempt 2 of 3 — or never.
 */
export function isFinalProcessorAttempt(job: AttemptCountedJob): boolean {
  return job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

/**
 * The same question asked from the worker's `failed` event, which fires on
 * EVERY failed attempt — not only the last one: `Worker.handleFailed` emits it
 * unconditionally, right after `moveToFailed` has decided retry-vs-fail. By
 * then `attemptsMade` has already been incremented, so the same attempt that
 * saw N-1 in the processor is seen as N here. Hence the different comparison.
 */
export function isFinalFailedAttempt(job: AttemptCountedJob): boolean {
  return job.attemptsMade >= (job.opts?.attempts ?? 1);
}
