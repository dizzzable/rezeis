import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { WheelSectorKind, WheelSpinStatus } from '@prisma/client';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { SupportTicketsService } from '../src/modules/support-tickets/services/support-tickets.service';
import type { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';
import { WheelManualPrizeService } from '../src/modules/wheel-prizes/services/wheel-manual-prize.service';

/**
 * The prizes a human hands over, against a real PostgreSQL.
 *
 * What is worth checking here is again mostly the database: that opening a
 * conversation twice leaves ONE conversation and no orphan, that two operators
 * clicking together cannot both settle the same prize, and that a refusal
 * writes a reason somebody can read. None of that is visible to a fake.
 *
 * Skipped without TEST_DATABASE_URL, like every live spec.
 */
const testUrl = process.env.TEST_DATABASE_URL;
const run = testUrl === undefined ? describe.skip : describe;
const prefix = `mprize-${process.pid}-${Date.now()}`;

let prisma: PrismaService;
let service: WheelManualPrizeService;

/** Records what would have been delivered; delivery itself is support's own. */
const announced: Array<{ ticketId: string; userId: string }> = [];
const notifications = {
  notifyAdminReply: async (input: { ticketId: string; user: { id: string } | null }) => {
    if (input.user !== null) announced.push({ ticketId: input.ticketId, userId: input.user.id });
  },
} as unknown as SupportNotificationsService;

const createdUsers: string[] = [];
const createdSectors: string[] = [];

async function createUser(suffix: string): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.user.create({ data: { id, referralCode: `${id}-ref`, name: suffix } });
  createdUsers.push(id);
  return id;
}

async function createSector(suffix: string, title: string, instructions: string): Promise<string> {
  const id = `${prefix}-${suffix}`;
  await prisma.wheelSector.create({
    data: {
      id,
      kind: WheelSectorKind.MANUAL,
      title: { ru: title },
      manualInstructions: instructions,
      weight: 1,
      // DISABLED, and that is load-bearing. There is one wheel and these
      // specs share a database, so an enabled sector here is a sector
      // `wheel-spin-postgres.spec.ts` can land on while it runs beside this
      // file. Nothing here ever spins — the wins are written directly — so
      // these sectors have no business being on anybody's wheel.
      enabled: false,
    },
  });
  createdSectors.push(id);
  return id;
}

/** A MANUAL win exactly as `WheelSpinService` records one. */
async function recordWin(input: {
  readonly userId: string;
  readonly sectorId: string;
  readonly title: string;
  readonly instructions: string;
  readonly key: string;
}): Promise<string> {
  const spin = await prisma.wheelSpin.create({
    data: {
      userId: input.userId,
      sectorId: input.sectorId,
      sectorSnapshot: {
        id: input.sectorId,
        kind: 'MANUAL',
        title: { ru: input.title },
        rarity: 'LEGENDARY',
        amount: 0,
        order: 0,
      },
      kind: WheelSectorKind.MANUAL,
      amount: 0,
      status: WheelSpinStatus.PENDING,
      paidWith: 'BALANCE',
      idempotencyKey: input.key,
      outcome: { manual: true, instructions: input.instructions },
    },
    select: { id: true },
  });
  return spin.id;
}

run('manual wheel prizes on PostgreSQL', () => {
  before(async () => {
    process.env.DATABASE_URL = testUrl;
    process.env.DATABASE_POOL_SIZE = '8';
    prisma = new PrismaService();
    await prisma.$connect();
    service = new WheelManualPrizeService(prisma, new SupportTicketsService(prisma), notifications);
  });

  after(async () => {
    if (prisma === undefined) return;
    for (const id of createdUsers) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdSectors) {
      await prisma.wheelSector.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  beforeEach(() => {
    announced.length = 0;
  });

  it('opens a conversation the operator can reach the winner in', async () => {
    const userId = await createUser('open');
    const sectorId = await createSector('open-s', 'Джекпот 1000 ₽', 'Перевести на карту');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Джекпот 1000 ₽',
      instructions: 'Перевести на карту',
      key: 'open-1',
    });

    const ticketId = await service.openTicket(spinId);

    assert.ok(ticketId);
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { userId: true, subject: true, status: true, messages: true },
    });
    assert.equal(ticket?.userId, userId);
    assert.equal(ticket?.subject, 'Приз с колеса: Джекпот 1000 ₽');
    assert.equal(ticket?.status, 'OPEN');
    assert.equal(ticket?.messages.length, 1);
    assert.equal(ticket?.messages[0]?.authorType, 'SYSTEM');
    assert.match(ticket?.messages[0]?.content ?? '', /Джекпот 1000 ₽/);

    // Nobody is notified: the person has just watched the wheel stop on it.
    assert.deepEqual(announced, []);
  });

  it('opening twice leaves one conversation, not two', async () => {
    const userId = await createUser('twice');
    const sectorId = await createSector('twice-s', 'Футболка', 'Отправить посылку');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Футболка',
      instructions: 'Отправить посылку',
      key: 'twice-1',
    });

    const first = await service.openTicket(spinId);
    const second = await service.openTicket(spinId);

    assert.equal(second, first);
    assert.equal(await prisma.supportTicket.count({ where: { userId } }), 1);
  });

  it('two openings racing leave one conversation and no orphan', async () => {
    // The loser creates a ticket and then finds the column already claimed.
    // Rolling it back with the claim is what stops an abandoned conversation
    // nobody is ever told about from piling up in the operator's inbox.
    const userId = await createUser('race');
    const sectorId = await createSector('race-s', 'Ключ Steam', 'Выдать ключ');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Ключ Steam',
      instructions: 'Выдать ключ',
      key: 'race-1',
    });

    const [a, b] = await Promise.all([service.openTicket(spinId), service.openTicket(spinId)]);

    assert.equal(a, b);
    assert.equal(await prisma.supportTicket.count({ where: { userId } }), 1);
  });

  it('the sweep opens a conversation for everything still owed', async () => {
    const userId = await createUser('sweep');
    const sectorId = await createSector('sweep-s', 'Приз', 'Вручить');
    const one = await recordWin({
      userId,
      sectorId,
      title: 'Приз',
      instructions: 'Вручить',
      key: 'sweep-1',
    });
    const two = await recordWin({
      userId,
      sectorId,
      title: 'Приз',
      instructions: 'Вручить',
      key: 'sweep-2',
    });

    await service.openMissingTickets();

    const spins = await prisma.wheelSpin.findMany({
      where: { id: { in: [one, two] } },
      select: { manualTicketId: true },
    });
    assert.equal(
      spins.every((spin) => spin.manualTicketId !== null),
      true,
    );
    // And running it again opens nothing more.
    assert.equal(await service.openMissingTickets(), 0);
  });

  it('hands the prize over, records who did it, and tells the winner', async () => {
    const userId = await createUser('issue');
    const sectorId = await createSector('issue-s', 'Джекпот', 'Перевести');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Джекпот',
      instructions: 'Перевести',
      key: 'issue-1',
    });
    await service.openTicket(spinId);

    const settled = await service.issue({
      spinId,
      adminId: 'admin-7',
      note: 'Перевёл на карту 1000 ₽, чек в переписке',
    });

    assert.deepEqual(settled, { settled: true, status: WheelSpinStatus.SETTLED });
    const spin = await prisma.wheelSpin.findUnique({
      where: { id: spinId },
      select: { status: true, settledBy: true, settledAt: true, settlementNote: true, manualTicketId: true },
    });
    assert.equal(spin?.status, WheelSpinStatus.SETTLED);
    assert.equal(spin?.settledBy, 'admin-7');
    assert.notEqual(spin?.settledAt, null);
    assert.match(spin?.settlementNote ?? '', /1000/);

    const messages = await prisma.supportTicketMessage.findMany({
      where: { ticketId: spin?.manualTicketId ?? '' },
      orderBy: { createdAt: 'asc' },
      select: { authorType: true, authorId: true, content: true },
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.authorType, 'ADMIN');
    assert.equal(messages[1]?.authorId, 'admin-7');
    assert.match(messages[1]?.content ?? '', /вручён/i);
    assert.deepEqual(announced, [{ ticketId: spin?.manualTicketId ?? '', userId }]);
  });

  it('refuses with a reason the person can read, and does not give the spin back', async () => {
    const userId = await createUser('refuse');
    const sectorId = await createSector('refuse-s', 'Джекпот', 'Перевести');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Джекпот',
      instructions: 'Перевести',
      key: 'refuse-1',
    });
    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { spinBalance: true },
    });

    const settled = await service.refuse({
      spinId,
      adminId: 'admin-9',
      reason: 'Аккаунт заблокирован за накрутку',
    });

    assert.deepEqual(settled, { settled: true, status: WheelSpinStatus.REFUSED });
    const spin = await prisma.wheelSpin.findUnique({
      where: { id: spinId },
      select: { status: true, settlementNote: true, manualTicketId: true },
    });
    assert.equal(spin?.status, WheelSpinStatus.REFUSED);
    assert.equal(spin?.settlementNote, 'Аккаунт заблокирован за накрутку');

    // The conversation is opened on the way out even though nothing opened it
    // before: a refusal nobody can read is a refusal nobody can appeal.
    const messages = await prisma.supportTicketMessage.findMany({
      where: { ticketId: spin?.manualTicketId ?? '' },
      select: { content: true, authorType: true },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(messages.length, 2);
    assert.match(messages[1]?.content ?? '', /Аккаунт заблокирован за накрутку/);

    const after = await prisma.user.findUnique({
      where: { id: userId },
      select: { spinBalance: true },
    });
    assert.equal(after?.spinBalance, before?.spinBalance, 'the spin is not refunded automatically');
    assert.equal(
      await prisma.spinLedgerEntry.count({ where: { userId } }),
      0,
      'and nothing was written to the spin journal',
    );
  });

  it('two operators settling at once: one wins, the other is told so', async () => {
    const userId = await createUser('clash');
    const sectorId = await createSector('clash-s', 'Джекпот', 'Перевести');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Джекпот',
      instructions: 'Перевести',
      key: 'clash-1',
    });

    const [a, b] = await Promise.all([
      service.issue({ spinId, adminId: 'admin-a', note: 'выдал' }),
      service.refuse({ spinId, adminId: 'admin-b', reason: 'отказ' }),
    ]);

    const settled = [a, b].filter((result) => result.settled);
    const refused = [a, b].filter((result) => !result.settled);
    assert.equal(settled.length, 1, 'exactly one of them settled it');
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0], { settled: false, reason: 'NOT_PENDING' });

    // And the note on the row belongs to the winner, not to whoever ran last.
    const spin = await prisma.wheelSpin.findUnique({
      where: { id: spinId },
      select: { settledBy: true, settlementNote: true, status: true },
    });
    assert.ok(spin?.settledBy === 'admin-a' || spin?.settledBy === 'admin-b');
    assert.equal(
      spin?.settledBy === 'admin-a' ? spin?.status : spin?.status,
      spin?.settledBy === 'admin-a' ? WheelSpinStatus.SETTLED : WheelSpinStatus.REFUSED,
    );
  });

  it('settling something already settled changes nothing', async () => {
    const userId = await createUser('again');
    const sectorId = await createSector('again-s', 'Джекпот', 'Перевести');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Джекпот',
      instructions: 'Перевести',
      key: 'again-1',
    });

    await service.issue({ spinId, adminId: 'admin-first', note: 'выдал' });
    const second = await service.issue({ spinId, adminId: 'admin-second', note: 'и я выдал' });

    assert.deepEqual(second, { settled: false, reason: 'NOT_PENDING' });
    const spin = await prisma.wheelSpin.findUnique({
      where: { id: spinId },
      select: { settledBy: true, settlementNote: true },
    });
    assert.equal(spin?.settledBy, 'admin-first', 'the first settlement stands');
    assert.equal(spin?.settlementNote, 'выдал');
  });

  it('keeps the subject the sector had when it was won', async () => {
    const userId = await createUser('rename');
    const sectorId = await createSector('rename-s', 'Старое имя', 'Вручить');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Старое имя',
      instructions: 'Вручить',
      key: 'rename-1',
    });

    await prisma.wheelSector.update({
      where: { id: sectorId },
      data: { title: { ru: 'Совсем другое' } },
    });
    const ticketId = await service.openTicket(spinId);

    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId ?? '' },
      select: { subject: true },
    });
    assert.equal(ticket?.subject, 'Приз с колеса: Старое имя');
  });

  it('shows the queue with the winner and the operator instructions', async () => {
    const userId = await createUser('queue');
    const sectorId = await createSector('queue-s', 'Джекпот', 'Связаться и перевести 1000 ₽');
    const spinId = await recordWin({
      userId,
      sectorId,
      title: 'Джекпот',
      instructions: 'Связаться и перевести 1000 ₽',
      key: 'queue-1',
    });

    const page = await service.list({ limit: 100 });
    const row = page.items.find((item) => item.spinId === spinId);

    assert.ok(row, 'the owed prize is in the queue');
    assert.equal(row.status, WheelSpinStatus.PENDING);
    assert.equal(row.winner.id, userId);
    assert.equal(row.instructions, 'Связаться и перевести 1000 ₽');
    assert.deepEqual(row.sector.title, { ru: 'Джекпот' });

    // Once settled it leaves the default view.
    await service.issue({ spinId, adminId: 'admin-x', note: null });
    const afterSettling = await service.list({ limit: 100 });
    assert.equal(
      afterSettling.items.some((item) => item.spinId === spinId),
      false,
    );
    const settledView = await service.list({ status: WheelSpinStatus.SETTLED, limit: 100 });
    assert.equal(
      settledView.items.some((item) => item.spinId === spinId),
      true,
      'and is findable under its new status',
    );
  });
});
