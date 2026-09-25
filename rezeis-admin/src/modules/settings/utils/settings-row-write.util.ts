import { Prisma, type PrismaClient, type Settings } from '@prisma/client';

/**
 * EVERY WRITE TO THE `settings` ROW GOES THROUGH THIS FILE
 * ═══════════════════════════════════════════════════════
 * `settings` is a single row, and most of its columns are JSON blobs that
 * unrelated features share. `systemNotifications` alone holds the encrypted
 * admin bot token, the SMTP password, the VAPID keypair and its adoption
 * marker, Telegram delivery routing, payment-ops alerts, backup settings, the
 * custom emoji packs and their seed marker. Every writer reads the blob, merges
 * its own key in JavaScript and writes the whole column back.
 *
 * None of them used to lock the row. Under READ COMMITTED two writes that
 * overlap both read the same version, and the one that commits second writes
 * its copy over the first one's change. Nothing errors and nothing is logged:
 * an operator saves the SMTP password while the worker adopts VAPID keys at
 * boot, and one of the two simply is not there afterwards.
 *
 * So the row is fenced here, once, for every writer:
 *
 *   1. `SELECT ... FOR UPDATE` is the first statement that touches `settings`
 *      in the transaction. A second writer blocks on it until the first one
 *      commits or rolls back.
 *   2. The row is read AFTER the lock is granted, so the merge starts from the
 *      version the previous writer committed, not the one it overwrote.
 *   3. The merge, the write and any audit row a caller adds through `tx` run in
 *      that same transaction.
 *
 * The functions take the Prisma client (or a transaction) as an argument and
 * need no dependency injection on purpose: ten specs construct
 * `SettingsService` positionally, and the writers live in modules that would
 * otherwise have to import the settings module and risk an import cycle.
 *
 * `test/settings-row-write-invariant.spec.ts` fails on any write to the row
 * that does not go through here, and `test/settings-row-lock-postgres.spec.ts`
 * proves the lock against a real PostgreSQL.
 *
 * ── Lock ordering ────────────────────────────────────────────────────────────
 * Every transaction that writes or locks `settings` takes this lock before it
 * locks anything else: the helpers below take it before the caller's `mutate`
 * runs, and the one caller that uses the row as a mutex (`WheelSectorService`)
 * takes it as its first statement. A deadlock needs a transaction that holds
 * some other row lock and then waits for this one, and none exists. The audit
 * rows written after the lock take a key-share lock on their `admin_users` row;
 * the transaction that could block that (deleting the admin) never waits for
 * `settings` afterwards, because nothing takes `settings` second. Plain reads
 * of `settings` inside other transactions take no lock and do not count.
 *
 * ── Isolation level ──────────────────────────────────────────────────────────
 * The first-install path below relies on READ COMMITTED (the PostgreSQL and
 * Prisma default): after losing the insert race, the next statement must see
 * the row the winner committed. Under REPEATABLE READ or SERIALIZABLE that row
 * stays invisible to the transaction's snapshot. No writer overrides the level.
 */

/**
 * Bumped whenever a transaction that may have written the row settles, commit
 * or rollback.
 *
 * `SettingsService` caches the row for five seconds. A cache that is only
 * CLEARED when a write starts gets refilled by any read landing between the
 * clear and the commit — with the old row and a fresh timestamp. The reiwa
 * invalidation `updateBrandingSettings` fires right after the commit drops the
 * cabinet's own cache, the cabinet's next request re-reads through exactly
 * that stale entry, and keeps the answer for its own 60 seconds: the
 * operator's save looks lost for a minute. With this counter the cache can
 * refuse both: an entry is valid only while its generation is current, and a
 * fetch stores its result only if no write settled while it was in flight.
 *
 * Module-level rather than a `WeakMap` keyed by the Prisma client. A write
 * reaches this file sometimes with the base client and sometimes with only a
 * transaction client (the config import owns its transaction), and a client
 * derived through `$extends` is a different object again. A map keyed by
 * client would miss every such mismatch in the stale direction: the cache
 * would simply never be invalidated. A single counter can only err the other
 * way — two clients in one process (specs, the admin CLI) invalidate each
 * other's caches, which costs a re-read and never serves a stale row.
 *
 * Per process. The API and the worker are separate processes and a write in
 * one does not bump the other's counter, so the other process may serve the
 * previous row until its own five-second TTL runs out. That is the staleness
 * budget `SettingsService.getAntiFraudTunablesRuntime` already documents, and
 * it is deliberately not closed with pub/sub.
 */
let settingsRowGeneration = 0;

/** The current generation. See {@link settingsRowGeneration}. */
export function readSettingsRowGeneration(): number {
  return settingsRowGeneration;
}

/**
 * The client a settings write opens its own transaction on. `PrismaService`
 * satisfies it; so does a spec double that runs the callback.
 */
export interface SettingsWriteClient {
  $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/** What a mutation sees once the lock is held. */
export interface SettingsRowMutation {
  /** The transaction holding the lock, for writes that must commit with this one. */
  readonly tx: Prisma.TransactionClient;
  /** The row as it stands under the lock. */
  readonly row: Settings;
  /**
   * True when this transaction inserted the row a moment ago (first install),
   * so no other transaction has ever seen it.
   */
  readonly created: boolean;
  /** Update the locked row. The only sanctioned way to write it. */
  write(data: Prisma.SettingsUpdateInput): Promise<Settings>;
}

type SettingsRowMutator<T> = (mutation: SettingsRowMutation) => Promise<T>;

type LockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Every row of the table, in id order. There is one row; locking all of them
 * rather than `WHERE "id" = 1` keeps the fence on whatever row the readers'
 * `findFirst` picks even if that ever stops being id 1, and the order keeps
 * two lockers from taking rows in different orders if the table ever held more.
 */
const LOCK_SETTINGS_ROW = Prisma.sql`SELECT "id" FROM "settings" ORDER BY "id" FOR UPDATE`;
const SAVEPOINT = Prisma.sql`SAVEPOINT settings_row_insert`;
const RELEASE_SAVEPOINT = Prisma.sql`RELEASE SAVEPOINT settings_row_insert`;
const ROLLBACK_TO_SAVEPOINT = Prisma.sql`ROLLBACK TO SAVEPOINT settings_row_insert`;

/**
 * Take the row lock inside `tx`. Answers whether there was a row to lock.
 *
 * Exported for the one caller that needs the row only as a mutex and writes
 * nothing to it (`WheelSectorService`, which serialises the whole wheel
 * configuration on it). Anything that WRITES the row uses the mutators below.
 */
export async function lockSettingsRow(tx: LockClient): Promise<boolean> {
  const locked = await tx.$queryRaw<ReadonlyArray<{ readonly id: number }>>(LOCK_SETTINGS_ROW);
  return locked.length > 0;
}

/**
 * Read-modify-write on the row in a transaction of its own, creating the
 * defaults when the table is empty. The generation is bumped once the
 * transaction settles, before this promise resolves — so code that runs after
 * `await` (a reiwa invalidation, say) already sees the cache as stale.
 */
export function mutateSettingsRow<T>(
  client: SettingsWriteClient,
  mutate: SettingsRowMutator<T>,
): Promise<T> {
  return runSettingsWriteTransaction(client, (tx) =>
    lockReadAndMutate(tx, mutate, { create: {} }),
  );
}

/**
 * The same, for writers that must NOT create the row: on an empty table
 * `whenAbsent` answers instead and nothing is written.
 */
export function mutateExistingSettingsRow<T, A>(
  client: SettingsWriteClient,
  mutate: SettingsRowMutator<T>,
  whenAbsent: () => A | Promise<A>,
): Promise<T | A> {
  return runSettingsWriteTransaction(client, (tx) =>
    lockReadAndMutate<T, A>(tx, mutate, { whenAbsent }),
  );
}

/**
 * Read-modify-write inside a transaction the CALLER owns, creating the row
 * from `createWith` when the table is empty.
 *
 * Does not bump the generation: only the caller knows when its transaction
 * settles. Open that transaction with {@link runSettingsWriteTransaction},
 * which does. The invariant spec fails on a file that calls this and not that.
 */
export function mutateSettingsRowInTransaction<T>(
  tx: Prisma.TransactionClient,
  mutate: SettingsRowMutator<T>,
  options: { readonly createWith: Prisma.SettingsCreateInput },
): Promise<T> {
  return lockReadAndMutate(tx, mutate, { create: options.createWith });
}

/**
 * `client.$transaction(work)`, bumping the generation once it settles, commit
 * or rollback. For callers that own a transaction in which the row may be
 * written.
 */
export async function runSettingsWriteTransaction<T>(
  client: SettingsWriteClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await client.$transaction(work);
  } finally {
    settingsRowGeneration += 1;
  }
}

/**
 * The row for a READ path, creating the defaults on a first install.
 *
 * Autocommit, so the losing side of two concurrent first reads cannot abort a
 * transaction: its insert fails with a unique violation, and the row the
 * winner committed is what it answers with. It used to answer HTTP 500.
 *
 * Must be given the base client. Inside a transaction a unique violation
 * aborts the whole transaction; the mutators above handle that case with a
 * savepoint.
 */
export async function ensureSettingsRow(client: Pick<PrismaClient, 'settings'>): Promise<Settings> {
  try {
    return await client.settings.create({ data: {} });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await client.settings.findFirst({ orderBy: { updatedAt: 'asc' } });
    if (winner === null) throw error;
    return winner;
  } finally {
    settingsRowGeneration += 1;
  }
}

type WhenRowAbsent<A> =
  | { readonly create: Prisma.SettingsCreateInput }
  | { readonly whenAbsent: () => A | Promise<A> };

async function lockReadAndMutate<T, A = never>(
  tx: Prisma.TransactionClient,
  mutate: SettingsRowMutator<T>,
  absent: WhenRowAbsent<A>,
): Promise<T | A> {
  let row = await readUnderLock(tx);
  let created = false;
  if (row === null) {
    if ('whenAbsent' in absent) return absent.whenAbsent();
    row = await insertSettingsRow(tx, absent.create);
    if (row !== null) {
      created = true;
    } else {
      // Another transaction inserted the row first and has committed — the
      // unique violation is only raised once it has. That row is now visible
      // to this statement, so lock it and merge onto it like any other.
      row = await readUnderLock(tx);
      if (row === null) {
        throw new Error('The settings row was created concurrently but is not visible after the conflict');
      }
    }
  }
  const locked = row;
  return mutate({
    tx,
    row: locked,
    created,
    write: (data) => tx.settings.update({ where: { id: locked.id }, data }),
  });
}

async function readUnderLock(tx: Prisma.TransactionClient): Promise<Settings | null> {
  const locked = await lockSettingsRow(tx);
  const row = await tx.settings.findFirst({ orderBy: { updatedAt: 'asc' } });
  if (row === null || locked) return row;
  // The lock met an empty table and the read found a row: a first-install
  // creator committed in between. That row is not locked by this transaction,
  // and a merge onto it could still be overwritten, so lock it and read again.
  await lockSettingsRow(tx);
  return tx.settings.findFirst({ orderBy: { updatedAt: 'asc' } });
}

/**
 * Insert the singleton under a savepoint. `null` when a concurrent creator won.
 *
 * Without the savepoint the loser's unique violation would abort its whole
 * transaction (PostgreSQL 25P02) and the write it was about to make would be
 * lost with it — the same pattern `bindResetEpochWindow` uses for its epochs.
 */
async function insertSettingsRow(
  tx: Prisma.TransactionClient,
  data: Prisma.SettingsCreateInput,
): Promise<Settings | null> {
  await tx.$executeRaw(SAVEPOINT);
  try {
    const created = await tx.settings.create({ data });
    await tx.$executeRaw(RELEASE_SAVEPOINT);
    return created;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await tx.$executeRaw(ROLLBACK_TO_SAVEPOINT);
    return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
