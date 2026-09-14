import { Job, Queue, type JobsOptions, type MinimalQueue } from 'bullmq';

/**
 * BullMQ's own admission check, without a Redis
 * ═════════════════════════════════════════════
 * Every fake queue in this suite used to be `add: async (name, data, opts) =>
 * { calls.push(...) }`. It accepted anything. So `reiwa.user.notify:<cuid>`,
 * `sysevt:…` keys and `broadcast-start:<id>` all "enqueued" in the specs, while
 * the real library refused every one of them with "Custom Id cannot contain :"
 * — every subscriber notification and operator card went out on the
 * one-attempt fallback, and starting a broadcast answered 500. Green specs over
 * a queue that carried almost nothing.
 *
 * A copied regex would be the next thing to drift: BullMQ's rule is not "no
 * colons" (three parts pass) and its own source says the rule will change in
 * the next major. So nothing here restates the rule. `admitThroughBullMq` runs
 * the library's REAL code for `Queue.add` — `Queue.prototype.addJob` (the
 * `'0'` / `0:` guard and the option merge), the real `Job` constructor, and
 * `Job.validateOptions` — and stops exactly where `Job.addJob` would hand the
 * job to a Lua script. Everything that decides whether BullMQ ACCEPTS a job
 * runs; only the Redis write does not.
 *
 * It leans on two library internals — `Queue#addJob` delegating to
 * `this.Job.create`, and `validateOptions` — and both are guarded by the
 * anchor spec (`bullmq-job-id-invariant.spec.ts`): if an upgrade moves the
 * check somewhere this harness no longer reaches, that spec's "refuses what
 * BullMQ refuses" case goes red instead of every fake going lenient again.
 */

/** A `Job` whose `create` ends where Redis would begin. */
class AdmissionOnlyJob extends Job {
  public static override async create<T = unknown, R = unknown, N extends string = string>(
    queue: MinimalQueue,
    name: N,
    data: T,
    opts?: JobsOptions,
  ): Promise<Job<T, R, N>> {
    // `Job.create` builds the job exactly like this, and `Job.addJob` then
    // calls `validateOptions(asJSON())` before `scripts.addJob`.
    const job = new this(queue, name, data, opts, opts?.jobId);
    job.validateOptions(job.asJSON());
    return job as unknown as Job<T, R, N>;
  }
}

/**
 * Run `Queue.add`'s admission path for one job on a queue named `queueName`.
 * Resolves with the job BullMQ would have written; rejects with BullMQ's own
 * error when the library would refuse it.
 */
export async function admitThroughBullMq(
  queueName: string,
  jobName: string,
  data: unknown,
  opts?: JobsOptions,
): Promise<Job> {
  // The minimum `Queue#addJob` and the `Job` constructor read. No connection:
  // `client` is only awaited by the Redis half, which never runs.
  const context = {
    name: queueName,
    qualifiedName: `bull:${queueName}`,
    jobsOpts: {},
    Job: AdmissionOnlyJob,
    keys: {},
    toKey: (type: string): string => `bull:${queueName}:${type}`,
    opts: {},
    closing: undefined,
    client: Promise.resolve({}),
    emit: (): boolean => true,
  };
  const addJob = (
    Queue.prototype as unknown as {
      addJob(this: unknown, name: string, data: unknown, opts?: JobsOptions): Promise<Job>;
    }
  ).addJob;
  return addJob.call(context, jobName, data, opts);
}

type OfflineJobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';

interface HeldJob<TData> {
  readonly id: string;
  readonly name: string;
  readonly data: TData;
  readonly opts: JobsOptions;
  state: OfflineJobState;
  /** When a worker first took it, as BullMQ's `prepareJobForProcessing` stamps it. */
  processedOn?: number;
}

/** What a spec sees of a job, shaped like the parts of `Job` the producers call. */
export interface OfflineJobHandle<TData> {
  readonly id: string;
  readonly name: string;
  readonly data: TData;
  readonly opts: JobsOptions;
  /** Set once a worker has taken the job (`Job.processedOn`). */
  readonly processedOn?: number;
  getState(): Promise<OfflineJobState>;
  remove(): Promise<void>;
}

export interface AdmittedAdd<TData> {
  readonly name: string;
  readonly data: TData;
  readonly opts: JobsOptions;
  readonly jobId: string;
  /** BullMQ found a job under this id already and handed that one back. */
  readonly collapsed: boolean;
}

/**
 * A queue double with BullMQ's admission rules and BullMQ's id semantics.
 *
 * Two behaviours of the real queue matter to the producers and both are
 * modelled: an `add` BullMQ would refuse rejects with the library's message,
 * and an `add` under an id the queue already holds (waiting, delayed, active,
 * or retained completed/failed) adds nothing and returns the job it has. That
 * second one is the entire point of a custom id, so a double without it could
 * not show a dedup working — or breaking.
 */
export class OfflineBullMqQueue<TData = unknown> {
  public readonly admitted: AdmittedAdd<TData>[] = [];
  public readonly refused: Array<{ readonly name: string; readonly opts: JobsOptions; readonly message: string }> = [];
  private readonly jobs = new Map<string, HeldJob<TData>>();
  private nextNumericId = 1;
  private outage: Error | null = null;

  public constructor(public readonly name: string) {}

  /** Every later `add` fails the way a Redis that is down fails it. */
  public goDown(error: Error = new Error('Connection is closed.')): void {
    this.outage = error;
  }

  /** Move a held job to another state, e.g. to model a worker picking it up. */
  public setState(jobId: string, state: OfflineJobState): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new Error(`no job ${jobId} on ${this.name}`);
    job.state = state;
    // A worker taking the job is what stamps it; it survives completion.
    if (state === 'active' && job.processedOn === undefined) job.processedOn = Date.now();
  }

  /** Ids of the jobs this queue holds, in insertion order. */
  public heldIds(): string[] {
    return [...this.jobs.keys()];
  }

  public async add(name: string, data: TData, opts: JobsOptions = {}): Promise<OfflineJobHandle<TData>> {
    if (this.outage !== null) throw this.outage;
    let job: Job;
    try {
      job = await admitThroughBullMq(this.name, name, data, opts);
    } catch (err: unknown) {
      this.refused.push({ name, opts, message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    // No custom id: Redis would assign the next integer.
    const jobId = job.id ?? String(this.nextNumericId++);
    const existing = this.jobs.get(jobId);
    this.admitted.push({ name, data, opts, jobId, collapsed: existing !== undefined });
    if (existing !== undefined) return this.handle(existing);
    const held: HeldJob<TData> = {
      id: jobId,
      name,
      data,
      opts,
      state: typeof opts.delay === 'number' && opts.delay > 0 ? 'delayed' : 'waiting',
    };
    this.jobs.set(jobId, held);
    return this.handle(held);
  }

  public async getJob(jobId: string): Promise<OfflineJobHandle<TData> | undefined> {
    const job = this.jobs.get(jobId);
    return job === undefined ? undefined : this.handle(job);
  }

  public async getJobs(states: readonly OfflineJobState[]): Promise<OfflineJobHandle<TData>[]> {
    return [...this.jobs.values()].filter((job) => states.includes(job.state)).map((job) => this.handle(job));
  }

  /**
   * `Queue.remove`, answered the way bullmq 5.76's `removeJob-2.lua` answers it:
   * 0 for a job a worker holds the lock on, 1 for everything else — a job it
   * removed, and an id it does not have at all. (It used to answer 0 for a
   * missing id, which the library never does; `bullmq-late-enqueue.spec.ts`
   * pins both answers to the shipped script.)
   */
  public async remove(jobId: string): Promise<number> {
    const job = this.jobs.get(jobId);
    if (job !== undefined && job.state === 'active') return 0;
    this.jobs.delete(jobId);
    return 1;
  }

  /** The double as the type a producer's constructor wants. */
  public asQueue<T = TData>(): Queue<T> {
    return this as unknown as Queue<T>;
  }

  private handle(job: HeldJob<TData>): OfflineJobHandle<TData> {
    return {
      id: job.id,
      name: job.name,
      data: job.data,
      opts: job.opts,
      ...(job.processedOn === undefined ? {} : { processedOn: job.processedOn }),
      getState: async () => job.state,
      remove: async () => {
        // BullMQ refuses to remove a job a worker holds the lock on.
        if (job.state === 'active') {
          throw new Error(`Job ${job.id} could not be removed because it is locked by another worker`);
        }
        this.jobs.delete(job.id);
      },
    };
  }
}
