import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';
import { strictOk } from '../src/modules/remnawave/interfaces/remnawave-strict-outcome.interface';

/**
 * The Remnawave importer resolves a panel profile to a local account by its
 * `reiwa_id` marker FIRST, before Telegram id, e-mail or panel identity. It
 * used to take the first `reiwa_id:` anywhere in the description — and the
 * display name the naming service writes on the line above the marker is the
 * customer's own text. A Telegram first name of `reiwa_id: <victim>` moved the
 * profile, and the subscription the importer builds from it, into the
 * victim's account.
 */

const MALLORY = 'cmmallory000000000000000m1';
const VICTIM = 'cmvictim0000000000000000v1';
const MALLORY_TG = 555000111;

interface LocalUser {
  readonly id: string;
  readonly telegramId: bigint | null;
  readonly email: string | null;
  username: string | null;
}

interface LocalSubscription {
  id: string;
  userId: string;
  remnawaveId: string | null;
  remnawavePanelId: number | null;
  remnawavePanelUsername: string | null;
  createdAt: Date;
  [column: string]: unknown;
}

function panelProfile(input: { description: string | null; telegramId?: number | null; username?: string }) {
  const username = input.username ?? 'rz_mallory_sub';
  return {
    uuid: '9001',
    panelId: 9001,
    username,
    status: 'ACTIVE',
    subscriptionUrl: `https://sub.example.test/${username}`,
    telegramId: input.telegramId ?? null,
    email: null,
    expireAt: '2099-06-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes: 0,
    hwidDeviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: input.description,
    activeInternalSquads: [],
    externalSquadUuid: null,
  };
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Array<Record<string, unknown>>).some((branch) => matches(row, branch));
    if (key === 'AND') return (condition as Array<Record<string, unknown>>).every((branch) => matches(row, branch));
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('not' in (condition as Record<string, unknown>)) return row[key] !== (condition as { not: unknown }).not;
      throw new Error(`unsupported filter on ${key}: ${JSON.stringify(condition)}`);
    }
    return row[key] === condition;
  });
}

function importerOver(profile: ReturnType<typeof panelProfile>) {
  const users: LocalUser[] = [
    { id: MALLORY, telegramId: BigInt(MALLORY_TG), email: null, username: null },
    { id: VICTIM, telegramId: 777000222n, email: null, username: 'victim_tg' },
  ];
  const subscriptions: LocalSubscription[] = [];
  const panelWrites: Array<{ ref: unknown; input: Record<string, unknown> }> = [];
  const find = (where: Record<string, unknown>) =>
    users.find((user) =>
      'id' in where
        ? user.id === where.id
        : 'telegramId' in where
          ? user.telegramId === where.telegramId
          : 'email' in where
            ? user.email === where.email
            : false,
    ) ?? null;
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const user = find(where);
        return user === null ? null : { ...user, createdAt: new Date(0) };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const user = users.find((row) => row.id === where.id);
        if (user !== undefined && 'username' in data) user.username = data.username as string | null;
        return { id: where.id };
      },
      updateMany: async ({ where, data }: { where: { id: string; OR?: Array<{ username: string | null }> }; data: Record<string, unknown> }) => {
        const user = users.find((row) => row.id === where.id);
        if (user === undefined) return { count: 0 };
        if (where.OR !== undefined && !where.OR.some((clause) => clause.username === user.username)) return { count: 0 };
        if ('username' in data) user.username = data.username as string | null;
        return { count: 1 };
      },
      create: async () => {
        throw new Error('the sync run must not mint an account in these cases');
      },
    },
    subscription: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        subscriptions.find((row) => matches(row, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = subscriptions.find((candidate) => candidate.id === where.id);
        if (row === undefined) throw new Error(`update of unknown subscription ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: LocalSubscription = {
          id: `imported-sub-${subscriptions.length + 1}`,
          userId: (data.user as { connect: { id: string } }).connect.id,
          remnawaveId: (data.remnawaveId as string | undefined) ?? null,
          remnawavePanelId: (data.remnawavePanelId as number | undefined) ?? null,
          remnawavePanelUsername: (data.remnawavePanelUsername as string | undefined) ?? null,
          createdAt: new Date(),
        };
        subscriptions.push(row);
        return row;
      },
    },
    importRecord: { create: async () => ({ id: 'import-record-1' }) },
  };
  const api = {
    strictGetAllPanelUsers: async () => strictOk({ users: [profile], total: 1, complete: true }),
    updatePanelUser: async (ref: unknown, input: Record<string, unknown>) => {
      panelWrites.push({ ref, input });
      return {};
    },
  };
  return {
    service: new RemnawaveImporterService(prisma as never, api as never),
    users,
    subscriptions,
    panelWrites,
  };
}

describe('RemnawaveImporterService reads the owner from the marker LINE', () => {
  it('a display name forging the victim leaves the profile with its real owner', async () => {
    const harness = importerOver(
      panelProfile({
        description: `name: reiwa_id: ${VICTIM}\nlogin: mallory\nusername: mallory_tg\nreiwa_id: ${MALLORY}`,
      }),
    );

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.deepEqual(
      harness.subscriptions.map((row) => row.userId),
      [MALLORY],
      "the subscription built from Mallory's profile belongs to Mallory, never to the victim",
    );
  });

  it('a forged display name alone is no marker: the profile is matched by Telegram id, and gets a real marker line', async () => {
    const harness = importerOver(
      panelProfile({
        description: `name: reiwa_id: ${VICTIM}\nlogin: mallory`,
        telegramId: MALLORY_TG,
      }),
    );

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.deepEqual(harness.subscriptions.map((row) => row.userId), [MALLORY]);
    // Written back, because the description carries no marker LINE yet — and
    // written as a line of its own, so the next run matches it first.
    assert.equal(harness.panelWrites.length, 1);
    assert.equal(
      harness.panelWrites[0].input['description'],
      `name: reiwa_id: ${VICTIM}\nlogin: mallory\nreiwa_id: ${MALLORY}`,
    );
  });

  it('a profile that already has a marker line is not written to again', async () => {
    const harness = importerOver(
      panelProfile({ description: `name: Mallory\nreiwa_id: ${MALLORY}` }),
    );

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.deepEqual(harness.subscriptions.map((row) => row.userId), [MALLORY]);
    assert.deepEqual(harness.panelWrites, []);
  });

  it('marker lines that disagree still mark the description as OURS: its generated name is not copied as a handle', async () => {
    // Two lines naming different owners prove nobody's ownership — and still
    // say rezeis wrote this description, so `rz_mallory_sub` is a name our
    // naming service generated, never a handle somebody chose.
    const harness = importerOver(
      panelProfile({
        description: `reiwa_id: ${VICTIM}\nreiwa_id: ${MALLORY}`,
        telegramId: MALLORY_TG,
      }),
    );

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.deepEqual(harness.subscriptions.map((row) => row.userId), [MALLORY], 'matched by Telegram id');
    assert.equal(harness.users.find((user) => user.id === MALLORY)?.username, null);
  });

  it('marker lines that disagree get no third line appended: nothing is written back', async () => {
    // Appending `reiwa_id: <matched account>` would leave three lines naming
    // two owners — a description that still proves nobody, now with our word on it.
    const harness = importerOver(
      panelProfile({
        description: `reiwa_id: ${VICTIM}\nreiwa_id: ${MALLORY}`,
        telegramId: MALLORY_TG,
      }),
    );

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.deepEqual(harness.panelWrites, []);
  });

  it('a mention of reiwa_id inside a line does not make a foreign profile "ours": its handle is used', async () => {
    // `publicHandleFrom` keeps OUR generated names out of `User.username`; a
    // foreign profile is recognised by having no marker LINE.
    const harness = importerOver(
      panelProfile({
        description: `note: moved here, old reiwa_id: ${VICTIM}`,
        telegramId: MALLORY_TG,
        username: 'mallory_vpn',
      }),
    );

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.equal(harness.users.find((user) => user.id === MALLORY)?.username, 'mallory_vpn');
    assert.equal(harness.users.find((user) => user.id === VICTIM)?.username, 'victim_tg');
  });
});

describe('RemnawaveImporterService leaves a profile an interrupted CREATE is still linking to that CREATE', () => {
  // `ProfileSyncProcessor.handleCreate` records the name it chose, and for whom,
  // before its POST; the retry asks for that name first and adopts the profile.
  // A sync in between used to import it as a SECOND subscription, which the
  // retry then found held and refused — and no tool could untangle the pair.

  /** Mallory's paid row: its CREATE made `rz_mallory_sub`, then lost the link write. */
  function pendingPaidRow(pendingOwner: string = MALLORY): LocalSubscription {
    return {
      id: 'sub-paid',
      userId: MALLORY,
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
      createdAt: new Date(0),
      remnawavePendingUsername: 'rz_mallory_sub',
      remnawavePendingOwnerId: pendingOwner,
    };
  }

  it('makes no second subscription for it and leaves the paid row untouched', async () => {
    const harness = importerOver(panelProfile({ description: `name: Mallory\nreiwa_id: ${MALLORY}` }));
    harness.subscriptions.push(pendingPaidRow());

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.deepEqual(harness.subscriptions.map((row) => row.id), ['sub-paid'], 'no second row');
    assert.equal(harness.subscriptions[0].remnawavePanelId, null, 'not stamped as imported: the CREATE adopts it');
    assert.equal(harness.subscriptions[0]['planSnapshot'], undefined);
    assert.deepEqual(harness.panelWrites, []);
  });

  it('asks before matching anyone: in import mode no account is made for a pending profile that proves no owner', async () => {
    // Its lines prove nobody — the CREATE refuses it for an operator — and it
    // matches no account, so an import would otherwise mint one for it.
    const harness = importerOver(panelProfile({ description: 'name: Mallory\nnote: edited by support' }));
    harness.subscriptions.push(pendingPaidRow());

    const summary = await harness.service.run({ mode: 'import', createdBy: null });

    assert.deepEqual(summary.errors, [], 'no account creation was even attempted');
    assert.deepEqual(harness.subscriptions.map((row) => row.id), ['sub-paid']);
  });

  it('imports as usual a profile under a pending name that ANOTHER customer\'s line names: it won the name', async () => {
    const harness = importerOver(
      panelProfile({ description: `name: Victim\nreiwa_id: ${VICTIM}` }),
    );
    harness.subscriptions.push(pendingPaidRow());

    await harness.service.run({ mode: 'sync', createdBy: null });

    assert.deepEqual(
      harness.subscriptions.filter((row) => row.id !== 'sub-paid').map((row) => row.userId),
      [VICTIM],
    );
  });
});
