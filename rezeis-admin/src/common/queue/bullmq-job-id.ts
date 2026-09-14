import { createHash } from 'node:crypto';

/**
 * A BullMQ job id for a key the application minted
 * ════════════════════════════════════════════════
 * BullMQ refuses a custom `jobId` that contains `:` unless it splits into
 * EXACTLY three parts, and refuses one that reads as an integer
 * (`Job.validateOptions`, bullmq 5.x: "Custom Id cannot contain :"). The
 * three-part exemption is not a rule anybody chose — it keeps legacy repeatable
 * jobs loadable, and the library's own source marks it for replacement by a
 * plain "no `:` at all" in its next breaking release.
 *
 * The keys this application dedupes on are full of colons. A subscriber
 * notification is keyed on its row id, so `reiwa.user.notify:<cuid>` was TWO
 * parts; a system-event card is keyed on `sysevt:<type>:<ISO time>:<route>`,
 * and the ISO time alone brings two more. Every one of those `add`s threw,
 * the enqueue helper reported nothing but "BullMQ enqueue operation failed",
 * and each caller quietly fell back to a single direct attempt — so the
 * durable queues carried almost nothing, and pressing "send" on a broadcast
 * answered 500 every time.
 *
 * ── Why a digest and not an escape ─────────────────────────────────────────
 *
 * The logical key is caller-minted and unbounded: event types are created at
 * runtime by automation rules and by the reiwa ingest. An escaping scheme
 * would have to know every character BullMQ has an opinion about, now and in
 * its next major, and would still hand Redis a key of any length. A SHA-256 hex
 * digest has one shape, one length and an alphabet BullMQ does not care about,
 * and it is one-to-one for every key this code will ever produce.
 *
 * ── Why the scope stays readable ───────────────────────────────────────────
 *
 * It is what tells jobs apart in a failed-job inspector and in the `onFailed`
 * log lines, and it keeps two scopes that share one logical key apart:
 * `reiwa.dev.notify` and `reiwa.dev.notify.document` are different cabinet
 * endpoints and must never collapse into one job. `__` joins the two for the
 * reason `WebhookQueueService` already gives — it is not `:`.
 *
 * ── What the digest is NOT ─────────────────────────────────────────────────
 *
 * It is only the QUEUE's name for the job. Whatever dedupes on the logical key
 * further down — the cabinet bot claims `metadata.eventId` — reads it from the
 * job payload, which carries it unchanged. And every lookup (`getJob`,
 * `remove`, a duplicate inspection) has to go through this same function, or
 * it will look for the job under a name nothing uses: that is how
 * `dropPendingStart` once spent a release finding nothing.
 */
export function toBullMqJobId(scope: string, logicalKey: string): string {
  // A scope is a constant in the producer, so a bad one is a programming
  // error, and it is refused here with a message that names the scope.
  //
  // That does NOT keep it off the fallback path. The producers build the id
  // inside the `try` that guards their enqueue — they never throw at their
  // callers — so this throw lands in the same `catch` a Redis outage does: the
  // event goes out on the one direct attempt, and what is loud about it is the
  // reason (this message, carried into the fallback's log line and its
  // `enqueueError`), not the path.
  if (scope.length === 0 || scope.includes(':')) {
    throw new Error(`BullMQ job id scope must be non-empty and contain no ":" (got "${scope}")`);
  }
  return `${scope}__${createHash('sha256').update(logicalKey, 'utf8').digest('hex')}`;
}

/**
 * `toBullMqJobId` for a key that may be absent: no logical key, no custom id —
 * inventing one would collapse unrelated events into one job.
 */
export function toOptionalBullMqJobId(scope: string, logicalKey: string | null): string | null {
  return logicalKey === null ? null : toBullMqJobId(scope, logicalKey);
}
