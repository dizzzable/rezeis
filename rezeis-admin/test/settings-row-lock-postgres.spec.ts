import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { ConfigType } from '@nestjs/config';

import type { appConfig } from '../src/common/config/app.config';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { readJsonObject } from '../src/common/utils/read-json-object.util';
import { EmailDeliveryService } from '../src/modules/email/services/email-delivery.service';
import { EmailTemplateRendererService } from '../src/modules/email/services/email-template-renderer.service';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import {
  ensureSettingsRow,
  mutateSettingsRow,
} from '../src/modules/settings/utils/settings-row-write.util';

/**
 * The settings row lock, against a real PostgreSQL.
 *
 * A fake Prisma cannot say anything about this: the defect was two
 * transactions under READ COMMITTED both reading the same version of a JSON
 * column and the second commit overwriting the first one's change, and the
 * repair is `SELECT ... FOR UPDATE` making the second reader wait. Only an
 * engine blocks. So each case here is an interleaving forced on purpose:
 *
 *   - writer A takes the lock and reads, signals, and holds for 200 ms before
 *     it writes and commits;
 *   - writer B starts only after that signal, so it is certainly inside A's
 *     window, and completes in a few milliseconds if nothing makes it wait.
 *
 * Without the lock B reads the pre-A row, commits first, and A's write from
 * its own stale read then erases B's key — which is what these cases assert
 * against. The first-install cases do the same with the INSERT: A has
 * inserted the missing row and not committed, and B, arriving to create it
 * too, must neither fail with a unique violation (the old HTTP 500) nor lose
 * its write.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec; CI's PostgreSQL job
 * runs it. The settings singleton is shared with the other live specs, so it is
 * copied aside in `before` and put back exactly in `after`.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;

const HOLD_MS = 200;
const BACKUP_TABLE = `settings_row_lock_spec_${process.pid}`;

let prisma: PrismaService;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise that resolves when `signal` is called, for ordering the writers. */
function checkpoint(): { readonly reached: Promise<void>; readonly signal: () => void } {
  let signal: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { reached, signal };
}

async function storedSystemNotifications(): Promise<Record<string, unknown>> {
  const rows = await prisma.settings.findMany();
  assert.equal(rows.length, 1, `the singleton must be exactly one row, found ${rows.length}`);
  return readJsonObject(rows[0]!.systemNotifications);
}

run('the settings row lock on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.$executeRawUnsafe(`CREATE TABLE "${BACKUP_TABLE}" AS SELECT * FROM "settings"`);
  });

  after(async () => {
    if (prisma === undefined) return;
    await prisma.$executeRawUnsafe('DELETE FROM "settings"');
    await prisma.$executeRawUnsafe(`INSERT INTO "settings" SELECT * FROM "${BACKUP_TABLE}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE "${BACKUP_TABLE}"`);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.settings.deleteMany({});
  });

  it('keeps both keys when two writers merge different keys of systemNotifications at once', async () => {
    await prisma.settings.create({
      data: { id: 1, systemNotifications: { untouched: 'kept' } },
    });
    const aHoldsTheLock = checkpoint();

    const writerA = mutateSettingsRow(prisma, async ({ row, write }) => {
      aHoldsTheLock.signal();
      await sleep(HOLD_MS);
      await write({
        systemNotifications: { ...readJsonObject(row.systemNotifications), a: 'from A' },
      });
    });
    await aHoldsTheLock.reached;

    let bRead: Record<string, unknown> | null = null;
    const writerB = mutateSettingsRow(prisma, async ({ row, write }) => {
      bRead = readJsonObject(row.systemNotifications);
      await write({
        systemNotifications: { ...readJsonObject(row.systemNotifications), b: 'from B' },
      });
    });
    await Promise.all([writerA, writerB]);

    assert.deepEqual(
      bRead,
      { untouched: 'kept', a: 'from A' },
      'B must have waited for A to commit, and merged onto what A wrote',
    );
    assert.deepEqual(await storedSystemNotifications(), {
      untouched: 'kept',
      a: 'from A',
      b: 'from B',
    });
  });

  it('serialises a converted service writer (SMTP settings) behind a writer holding the row', async () => {
    // The same interleaving, with B being production code rather than the
    // helper called directly: the SMTP password shares this column with the
    // bot token and the VAPID keys, and used to be written with no transaction
    // at all.
    await prisma.settings.create({
      data: { id: 1, systemNotifications: { botTokenEnc: 'bot-token-ciphertext' } },
    });
    const email = new EmailDeliveryService(
      {
        enabled: false,
        host: null,
        port: 587,
        username: null,
        password: null,
        fromAddress: 'no-reply@example.test',
        fromName: 'Spec',
        useTls: true,
        useSsl: false,
      },
      prisma,
      new EmailTemplateRendererService(prisma),
    );
    const aHoldsTheLock = checkpoint();

    const writerA = mutateSettingsRow(prisma, async ({ row, write }) => {
      aHoldsTheLock.signal();
      await sleep(HOLD_MS);
      await write({
        systemNotifications: {
          ...readJsonObject(row.systemNotifications),
          webPush: { publicKey: 'vapid-public-key' },
        },
      });
    });
    await aHoldsTheLock.reached;
    const writerB = email.saveSmtpSettings({ host: 'smtp.example.test', password: 'smtp-secret' });
    await Promise.all([writerA, writerB]);

    const stored = await storedSystemNotifications();
    assert.equal(stored.botTokenEnc, 'bot-token-ciphertext', 'the untouched key survives both writes');
    assert.deepEqual(stored.webPush, { publicKey: 'vapid-public-key' }, "A's key survives B's write");
    assert.equal(
      readJsonObject(stored.email).password,
      'smtp-secret',
      "B's SMTP password survives A's write",
    );
  });

  it('lets two writers race to create the missing row: no unique violation, and both writes kept', async () => {
    const aInserted = checkpoint();

    let aCreated: boolean | null = null;
    const writerA = mutateSettingsRow(prisma, async ({ row, created, write }) => {
      aCreated = created;
      aInserted.signal();
      // A's INSERT is not committed yet, so B's INSERT of the same id has to
      // wait for it — and then collide with it.
      await sleep(HOLD_MS);
      await write({
        systemNotifications: { ...readJsonObject(row.systemNotifications), a: 'from A' },
      });
    });
    await aInserted.reached;

    let bCreated: boolean | null = null;
    const writerB = mutateSettingsRow(prisma, async ({ row, created, write }) => {
      bCreated = created;
      await write({
        systemNotifications: { ...readJsonObject(row.systemNotifications), b: 'from B' },
      });
    });
    await Promise.all([writerA, writerB]);

    assert.equal(aCreated, true, 'A found the table empty and inserted the row');
    assert.equal(bCreated, false, 'B lost the insert race and merged onto the row A committed');
    assert.deepEqual(await storedSystemNotifications(), { a: 'from A', b: 'from B' });
  });

  it('answers a first read that races a first write with the row, not an error', async () => {
    // The read path creates the defaults too (`SettingsService.getPlatformSettings`
    // on a fresh install). Two of them at once used to be one 200 and one 500.
    const settingsService = new SettingsService(
      prisma,
      {} as IconUploadService,
      { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as ConfigType<typeof appConfig>,
    );
    const aInserted = checkpoint();

    const writerA = mutateSettingsRow(prisma, async ({ write }) => {
      aInserted.signal();
      await sleep(HOLD_MS);
      await write({ rulesLink: 'https://example.test/rules' });
    });
    await aInserted.reached;

    const [platform, ensured] = await Promise.all([
      settingsService.getPlatformSettings(),
      ensureSettingsRow(prisma),
      writerA,
    ]);

    // Both creators waited for A's uncommitted row, collided with it, and read
    // the committed row instead of failing.
    assert.equal(platform.rulesLink, 'https://example.test/rules');
    assert.equal(ensured.rulesLink, 'https://example.test/rules');
    assert.equal((await prisma.settings.findMany()).length, 1);
  });

  it('rolls the insert back with the write when the writer that created the row fails', async () => {
    // Creating the row belongs to the transaction that needed it: a save that
    // is refused must not leave a defaults row behind.
    await assert.rejects(
      mutateSettingsRow(prisma, async () => {
        throw new Error('refused by the caller');
      }),
      /refused by the caller/,
    );
    assert.equal((await prisma.settings.findMany()).length, 0);
  });
});
