import type { JobsOptions, Queue } from 'bullmq';

import { OfflineBullMqQueue, type OfflineJobHandle } from './bullmq-offline-queue';

/**
 * A queue whose Redis goes away and comes back
 * ════════════════════════════════════════════
 * `OfflineBullMqQueue.goDown()` models a Redis that REFUSES: every `add`
 * rejects at once. The blip that matters for a timed-out enqueue is the other
 * kind: ioredis does not refuse a command it cannot send, it holds it in its
 * offline queue and replays it — in order — once the connection is back. The
 * caller's one-second bound has long since given up by then, and the job lands
 * anyway.
 *
 * This double holds every command issued while Redis is away and replays them
 * in issue order on `reconnect()`, over an `OfflineBullMqQueue` that still runs
 * BullMQ's own admission check. Nothing is answered while away, so a bounded
 * caller times out exactly as it would against the real thing.
 */
export class ReconnectingBullMqQueue<TData = unknown> {
  public readonly inner: OfflineBullMqQueue<TData>;
  /** Command names in the order they reached Redis, replays included. */
  public readonly executed: string[] = [];
  private away = false;
  /**
   * Set while the held commands replay. A command issued meanwhile — say, by a
   * callback that ran because the replayed add resolved — queues BEHIND the
   * replay, as it does on a real connection: ioredis flushes its offline queue
   * before anything issued after the reconnect.
   */
  private replaying = false;
  private readonly held: Array<() => Promise<void>> = [];
  private reconnectOn: string | null = null;

  public constructor(name: string) {
    this.inner = new OfflineBullMqQueue<TData>(name);
  }

  /** Every later command waits, unanswered, until `reconnect()`. */
  public goAway(): void {
    this.away = true;
  }

  /** Come back as soon as a command of this name is issued (it is replayed last). */
  public reconnectWhen(command: 'add' | 'getJob' | 'remove'): void {
    this.reconnectOn = command;
  }

  /** Redis is back: replay what was held, in the order it was issued. */
  public async reconnect(): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    this.away = false;
    while (this.held.length > 0) {
      const next = this.held.shift() as () => Promise<void>;
      await next();
    }
    this.replaying = false;
  }

  public add(name: string, data: TData, opts: JobsOptions = {}): Promise<OfflineJobHandle<TData>> {
    return this.run('add', () => this.inner.add(name, data, opts));
  }

  public getJob(jobId: string): Promise<OfflineJobHandle<TData> | undefined> {
    return this.run('getJob', () => this.inner.getJob(jobId));
  }

  public remove(jobId: string): Promise<number> {
    return this.run('remove', () => this.inner.remove(jobId));
  }

  public asQueue<T = TData>(): Queue<T> {
    return this as unknown as Queue<T>;
  }

  private run<T>(name: string, command: () => Promise<T>): Promise<T> {
    if (!this.away && !this.replaying) {
      this.executed.push(name);
      return command();
    }
    const answer = new Promise<T>((resolve, reject) => {
      this.held.push(async () => {
        this.executed.push(name);
        await command().then(resolve, reject);
      });
    });
    if (this.reconnectOn === name) {
      this.reconnectOn = null;
      void this.reconnect();
    }
    return answer;
  }
}
