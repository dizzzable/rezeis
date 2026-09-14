import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

import type {
  UndeliveredRecord,
  UndeliveredRecorder,
  UndeliveredRecording,
} from './undelivered-record';

/**
 * One operator alert per cause, not one per message
 * ═════════════════════════════════════════════════
 * An undelivered record used to become a system event every time — an
 * `AdminAuditLog` row, a realtime push and an operator card each. That is right
 * for one lost message and a storm for a cause that refuses them all: a
 * template Telegram will not parse, a button URL it rejects, custom emoji on a
 * bot whose owner has no Premium, a webhook secret the cabinet no longer
 * shares. A broadcast to a thousand subscribers then wrote a thousand rows,
 * pushed a thousand cards into the operator's topic, and said nothing the first
 * card had not.
 *
 * So the recorder asks this gate first, per signature (`UndeliveredRecord.
 * signature`: route, what was sent, outcome, reason, the operator's chat and
 * topic — never the recipient; see `alertSignature`). The first record of a
 * signature alerts at once. Every later one inside the cooldown is only
 * counted. The next record of that signature after the cooldown alerts again
 * and carries the count, in its sentence and as `repeatsSincePreviousAlert`, so
 * a cause that is still there comes back with its size, at most four times an
 * hour. A broadcast's channel post is keyed on its own event id, so no other
 * failure can swallow its card.
 *
 * What that leaves unsaid: a storm that ends inside its window reports its
 * count only when the same cause next occurs — possibly days later, hence the
 * week-long counter. The first card already named the cause; a trailing
 * summary would need a timer that survives restarts and runs once across two
 * containers, which is a queue of its own and not worth it for a number.
 *
 * ── Where the state lives ───────────────────────────────────────────────────
 *
 * In Redis, through the transport queue's own connection. The API container
 * and the worker both run these processors and producers, so a window kept in
 * memory would let each alert once per cause — and forget it on every deploy.
 * Two plain commands, no script: `SET … NX PX` opens a window atomically, and a
 * `MULTI` counts or collects the repeats. Between the two, a repeat counted by
 * another process can land in the count this alert carries instead of the next
 * one — early, never lost, never twice.
 *
 * When Redis does not answer in time, this process keeps its own window
 * instead (`local`). Silence is the wrong way to fail for an alert, and an
 * unbounded storm is the thing being fixed, so the fallback is neither: during
 * an outage each container coalesces for itself, which costs at most one alert
 * per cause per container per window. A command that timed out is not
 * cancelled, though — ioredis replays it when Redis is back — so a window can
 * open in Redis behind an alert this process already raised on its own; repeats
 * right after the outage are then counted into the next alert rather than
 * raising one.
 */

/** How long a signature stays quiet after it alerted. */
export const UNDELIVERED_ALERT_COOLDOWN_MS = 15 * 60 * 1_000;

/**
 * How long a count of repeats waits for the alert that will carry it. Long,
 * because that alert is the next occurrence of the cause, and a daily job that
 * broke yesterday next runs tomorrow.
 */
export const UNDELIVERED_REPEATS_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The longest an alert waits on Redis before this process decides alone. Short:
 * a relay worker slot is held for it, and the fallback is a correct answer.
 */
export const UNDELIVERED_GATE_REDIS_TIMEOUT_MS = 500;

/** Signatures the in-process fallback remembers before it forgets the oldest. */
const LOCAL_SIGNATURE_LIMIT = 1_000;

/** Versioned, so a later change of meaning does not read this one's counters. */
const KEY_PREFIX = 'rezeis:undelivered-alert:v1';

export interface UndeliveredAlertVerdict {
  /** Emit the record now. */
  readonly alert: boolean;
  /**
   * With `alert`: repeats counted since the previous alert of this signature,
   * which this one carries. Without: repeats counted so far, this one included.
   */
  readonly repeats: number;
}

/** The commands the gate sends. ioredis — and so BullMQ's connection — has them. */
export interface UndeliveredGateRedis {
  set(key: string, value: string, px: 'PX', milliseconds: number, nx: 'NX'): Promise<unknown>;
  multi(): UndeliveredGatePipeline;
}

export interface UndeliveredGatePipeline {
  get(key: string): UndeliveredGatePipeline;
  del(key: string): UndeliveredGatePipeline;
  incr(key: string): UndeliveredGatePipeline;
  pexpire(key: string, milliseconds: number): UndeliveredGatePipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface UndeliveredAlertGateOptions {
  readonly cooldownMs?: number;
  readonly repeatsTtlMs?: number;
  readonly redisTimeoutMs?: number;
  /** The clock of the in-process fallback. */
  readonly now?: () => number;
}

export class UndeliveredAlertGate {
  private readonly logger = new Logger(UndeliveredAlertGate.name);
  private readonly local = new Map<string, { quietUntil: number; repeats: number }>();
  private readonly cooldownMs: number;
  private readonly repeatsTtlMs: number;
  private readonly redisTimeoutMs: number;
  private readonly now: () => number;
  /** Said once when Redis stops answering, once when it is back. */
  private sharedAnswering = true;

  public constructor(
    /** The connection to keep the windows on; `null` keeps them in this process only. */
    private readonly redis: (() => Promise<UndeliveredGateRedis>) | null,
    options: UndeliveredAlertGateOptions = {},
  ) {
    this.cooldownMs = options.cooldownMs ?? UNDELIVERED_ALERT_COOLDOWN_MS;
    this.repeatsTtlMs = options.repeatsTtlMs ?? UNDELIVERED_REPEATS_TTL_MS;
    this.redisTimeoutMs = options.redisTimeoutMs ?? UNDELIVERED_GATE_REDIS_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  public async admit(signature: string): Promise<UndeliveredAlertVerdict> {
    if (this.redis !== null) {
      const shared = await this.admitShared(this.redis, signature);
      if (shared !== null) return shared;
    }
    return this.admitLocal(signature);
  }

  /** `null` when Redis could not decide; the caller then decides locally. */
  private async admitShared(
    connect: () => Promise<UndeliveredGateRedis>,
    signature: string,
  ): Promise<UndeliveredAlertVerdict | null> {
    const digest = createHash('sha256').update(signature, 'utf8').digest('hex');
    // One hash tag, so a cluster keeps both keys on one slot.
    const windowKey = `${KEY_PREFIX}:{${digest}}:window`;
    const repeatsKey = `${KEY_PREFIX}:{${digest}}:repeats`;

    let redis: UndeliveredGateRedis;
    let opened: boolean;
    try {
      redis = await this.bounded(connect());
      opened = (await this.bounded(redis.set(windowKey, '1', 'PX', this.cooldownMs, 'NX'))) === 'OK';
    } catch (err: unknown) {
      this.noteShared(false, err);
      return null;
    }
    this.noteShared(true);

    if (opened) {
      // The window is ours, so this alert goes out whatever happens next; a
      // count that cannot be collected is a number lost, not an alert.
      let repeats = 0;
      try {
        const replies = await this.bounded(redis.multi().get(repeatsKey).del(repeatsKey).exec());
        repeats = countOf(replies?.[0]?.[1]);
      } catch (err: unknown) {
        this.logger.warn(`Could not collect the repeats of an undelivered alert: ${describe(err)}`);
      }
      return { alert: true, repeats };
    }

    // Someone alerted inside the window: count this one for the next alert.
    let repeats = 0;
    try {
      const replies = await this.bounded(
        redis.multi().incr(repeatsKey).pexpire(repeatsKey, this.repeatsTtlMs).exec(),
      );
      repeats = countOf(replies?.[0]?.[1]);
    } catch (err: unknown) {
      this.logger.warn(`Could not count a repeat of an undelivered alert: ${describe(err)}`);
    }
    return { alert: false, repeats };
  }

  /** The same decision, remembered by this process alone. */
  private admitLocal(signature: string): UndeliveredAlertVerdict {
    const now = this.now();
    const entry = this.local.get(signature);
    if (entry !== undefined && entry.quietUntil > now) {
      entry.repeats += 1;
      return { alert: false, repeats: entry.repeats };
    }
    this.local.delete(signature);
    if (this.local.size >= LOCAL_SIGNATURE_LIMIT) {
      const oldest = this.local.keys().next();
      if (oldest.done !== true) this.local.delete(oldest.value);
    }
    this.local.set(signature, { quietUntil: now + this.cooldownMs, repeats: 0 });
    return { alert: true, repeats: entry?.repeats ?? 0 };
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Redis did not answer within ${this.redisTimeoutMs}ms`)),
            this.redisTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private noteShared(answering: boolean, err?: unknown): void {
    if (answering === this.sharedAnswering) return;
    this.sharedAnswering = answering;
    if (answering) {
      this.logger.log('Redis answers again: undelivered alerts are coalesced across processes');
    } else {
      this.logger.warn(
        `Redis did not answer (${describe(err)}): undelivered alerts are coalesced per process ` +
          'until it does',
      );
    }
  }
}

/**
 * The transport's recorder: the gate, then the emit.
 *
 * The one place a record becomes an alert, shared by the processor and the
 * producer of a transport through its module's recorder token, so an exhausted
 * job and a failed direct fallback count against the same window. Never
 * rejects: a recorder failure must not change what the job it is recording did.
 *
 * It answers WHICH it did — `alerted` or only `counted` — because a caller with
 * a card of its own to raise about the same loss has to know whether one went
 * out. "Recorded" was not enough: a record the gate counted produced no card at
 * all, and the broadcast pipeline, told only that the relay had recorded its
 * lost channel post, raised none either.
 */
export function createUndeliveredRecorder(input: {
  readonly gate: UndeliveredAlertGate;
  readonly emit: (record: UndeliveredRecord) => void;
  /** Appended to the sentence of an alert that carries repeats, in the record's own language. */
  readonly describeRepeats: (repeats: number) => string;
}): UndeliveredRecorder {
  const logger = new Logger('UndeliveredRecorder');
  return async (record: UndeliveredRecord): Promise<UndeliveredRecording> => {
    try {
      const verdict = await input.gate.admit(record.signature);
      if (!verdict.alert) {
        // Debug: a storm is exactly when a line per repeat would drown the log.
        logger.debug(
          `Undelivered alert coalesced (repeat ${verdict.repeats} inside the cooldown): ${record.message}`,
        );
        return 'counted';
      }
      input.emit(
        verdict.repeats === 0
          ? record
          : {
              ...record,
              message: `${record.message}${input.describeRepeats(verdict.repeats)}`,
              metadata: { ...record.metadata, repeatsSincePreviousAlert: verdict.repeats },
            },
      );
      return 'alerted';
    } catch (err: unknown) {
      logger.warn(`Could not record an undelivered send (${record.message}): ${describe(err)}`);
      return 'failed';
    }
  };
}

function countOf(reply: unknown): number {
  const value = typeof reply === 'number' ? reply : typeof reply === 'string' ? Number(reply) : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
