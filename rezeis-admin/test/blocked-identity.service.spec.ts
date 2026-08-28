import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BlockedIdentityKind, Prisma } from '@prisma/client';

import { BlockedIdentityService } from '../src/modules/blocked-identities/services/blocked-identity.service';
import { normaliseBlockedIdentity } from '../src/modules/blocked-identities/utils/normalise-identity.util';

/**
 * The identity blocklist.
 *
 * A blocklist has one failure mode that matters and it is silent: the entry is
 * there, the operator can see it in the table, and it matches nothing. Every
 * case below is a way that happens.
 *
 * The normalisation half is where most of them live, because the unique index
 * is `(kind, value)` — so what "the same person" means is decided entirely by
 * that function, and a writer and a reader that disagree by one space produce a
 * list that quietly does nothing.
 */

function fakePrisma(rows: Array<Record<string, unknown>> = []) {
  const store = [...rows];
  const calls: unknown[] = [];
  return {
    calls,
    store,
    blockedIdentity: {
      findUnique: async ({ where }: { where: { kind_value: { kind: string; value: string } } }) => {
        calls.push(['findUnique', where]);
        return (
          store.find(
            (r) => r.kind === where.kind_value.kind && r.value === where.kind_value.value,
          ) ?? null
        );
      },
      findFirst: async (args: unknown) => {
        calls.push(['findFirst', args]);
        return store[0] ?? null;
      },
      findMany: async (args: unknown) => {
        calls.push(['findMany', args]);
        return store;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (store.some((r) => r.kind === data.kind && r.value === data.value)) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = { id: `row-${store.length + 1}`, expiresAt: null, ...data };
        store.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push(['delete', where]);
        return null;
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        calls.push(['deleteMany', args.where]);
        return { count: 1 };
      },
    },
  };
}

function buildService(rows: Array<Record<string, unknown>> = []) {
  const prisma = fakePrisma(rows);
  return { service: new BlockedIdentityService(prisma as never), prisma };
}

describe('blocklist value normalisation', () => {
  it('reduces a Telegram id to digits, whatever shape it was pasted in', () => {
    // Operators paste ids the way their client shows them. All of these name
    // one person, and storing them as four rows would mean three of the four
    // match nothing.
    for (const raw of ['123456789', ' 123456789 ', 'id123456789', 'tg://user?id=123456789']) {
      assert.deepStrictEqual(
        normaliseBlockedIdentity(BlockedIdentityKind.TELEGRAM_ID, raw),
        { ok: true, value: '123456789' },
        raw,
      );
    }
  });

  it('strips leading zeros so one id cannot be two entries', () => {
    assert.deepStrictEqual(
      normaliseBlockedIdentity(BlockedIdentityKind.TELEGRAM_ID, '000123'),
      { ok: true, value: '123' },
    );
  });

  it('refuses a Telegram id with no digits rather than storing an empty value', () => {
    // The failure this prevents: `""` stored under a kind whose whole job is to
    // match a numeric id, silently matching the next caller who also has none.
    assert.deepStrictEqual(
      normaliseBlockedIdentity(BlockedIdentityKind.TELEGRAM_ID, '@durov'),
      { ok: false, reason: 'NOT_NUMERIC' },
    );
  });

  it('lower-cases e-mails and logins', () => {
    // `User@Example.com` walking past an entry for `user@example.com` is the
    // canonical way a blocklist looks right and does nothing.
    assert.deepStrictEqual(
      normaliseBlockedIdentity(BlockedIdentityKind.EMAIL, '  User@Example.COM '),
      { ok: true, value: 'user@example.com' },
    );
    assert.deepStrictEqual(
      normaliseBlockedIdentity(BlockedIdentityKind.WEB_LOGIN, ' AbUser '),
      { ok: true, value: 'abuser' },
    );
  });

  it('refuses something that is not an address at all', () => {
    assert.deepStrictEqual(
      normaliseBlockedIdentity(BlockedIdentityKind.EMAIL, 'not an email'),
      { ok: false, reason: 'NOT_AN_EMAIL' },
    );
  });

  it('refuses an empty value and an absurdly long one', () => {
    assert.deepStrictEqual(normaliseBlockedIdentity(BlockedIdentityKind.WEB_LOGIN, '   '), {
      ok: false,
      reason: 'EMPTY',
    });
    assert.deepStrictEqual(
      normaliseBlockedIdentity(BlockedIdentityKind.WEB_LOGIN, 'x'.repeat(255)),
      { ok: false, reason: 'TOO_LONG' },
    );
  });
});

describe('adding to the blocklist', () => {
  it('reports each row separately instead of failing the paste', async () => {
    // Two hundred lines with three typos must add the other hundred and
    // ninety-seven. Refusing the whole list teaches operators to paste smaller
    // lists, not to fix typos.
    const { service } = buildService();
    const result = await service.addMany({
      kind: BlockedIdentityKind.TELEGRAM_ID,
      values: ['111', '@durov', '222', '111'],
    });

    assert.equal(result.added.length, 2);
    assert.deepStrictEqual(
      result.added.map((r) => r.value),
      ['111', '222'],
    );
    // The repeat inside one paste is a duplicate of the first occurrence, not
    // an error.
    assert.deepStrictEqual(result.duplicates, ['111']);
    assert.deepStrictEqual(result.rejected, [{ value: '@durov', reason: 'NOT_NUMERIC' }]);
  });

  it('treats an identity already listed as a duplicate, not a failure', async () => {
    // Re-pasting a list that overlaps last week's is normal operator
    // behaviour. Surfacing the unique-index violation as an error would make
    // the safe action look broken.
    const { service } = buildService([
      { id: 'row-1', kind: BlockedIdentityKind.TELEGRAM_ID, value: '111', expiresAt: null },
    ]);
    const result = await service.addMany({
      kind: BlockedIdentityKind.TELEGRAM_ID,
      values: ['111'],
    });

    assert.deepStrictEqual(result.added, []);
    assert.deepStrictEqual(result.duplicates, ['111']);
  });

  it('stores the normalised value, not what was typed', async () => {
    const { service, prisma } = buildService();
    await service.addMany({
      kind: BlockedIdentityKind.EMAIL,
      values: ['  Abuser@Example.COM '],
    });
    assert.equal(prisma.store[0]?.value, 'abuser@example.com');
  });
});

describe('reading the blocklist', () => {
  it('matches a raw value against the stored normalised one', async () => {
    // The reader normalises too. If only the writer did, an entry added as
    // `user@example.com` would never match a sign-up as `User@Example.com` —
    // the exact case the normalisation exists for.
    const { service } = buildService([
      { id: 'row-1', kind: BlockedIdentityKind.EMAIL, value: 'abuser@example.com', expiresAt: null },
    ]);
    const found = await service.find(BlockedIdentityKind.EMAIL, ' AbUser@Example.com ');
    assert.equal(found?.id, 'row-1');
  });

  it('treats an expired entry as absent without deleting it', async () => {
    // A ban that erases its own record leaves an operator unable to answer
    // "was this person ever blocked, and why".
    const expired = {
      id: 'row-1',
      kind: BlockedIdentityKind.TELEGRAM_ID,
      value: '111',
      expiresAt: new Date(Date.now() - 1_000),
    };
    const { service, prisma } = buildService([expired]);

    assert.equal(await service.find(BlockedIdentityKind.TELEGRAM_ID, '111'), null);
    // Still on the list — the row was not removed by reading it.
    assert.equal(prisma.store.length, 1);
    assert.equal((await service.list()).length, 1);
  });

  it('honours an expiry still in the future', async () => {
    const { service } = buildService([
      {
        id: 'row-1',
        kind: BlockedIdentityKind.TELEGRAM_ID,
        value: '111',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    assert.equal((await service.find(BlockedIdentityKind.TELEGRAM_ID, '111'))?.id, 'row-1');
  });

  it('never asks whether the empty identity is blocked', async () => {
    // A web sign-up has no Telegram id and an anonymous one has no e-mail.
    // Looking those up would be asking whether `""` is on the list — which,
    // with a permissive normaliser, is how everyone gets blocked at once.
    const { service, prisma } = buildService();
    const match = await service.findFirstMatch([
      { kind: BlockedIdentityKind.TELEGRAM_ID, value: null },
      { kind: BlockedIdentityKind.EMAIL, value: undefined },
      { kind: BlockedIdentityKind.WEB_LOGIN, value: '   ' },
    ]);

    assert.equal(match, null);
    assert.deepStrictEqual(prisma.calls, [], 'must not reach the database');
  });

  it('filters expiry inside the multi-identity lookup too', async () => {
    // The single-identity read filters in JavaScript; this one has to do it in
    // the query, and a missed filter there would enforce expired bans.
    const { service, prisma } = buildService([
      { id: 'row-1', kind: BlockedIdentityKind.TELEGRAM_ID, value: '111', expiresAt: null },
    ]);
    await service.findFirstMatch([
      { kind: BlockedIdentityKind.TELEGRAM_ID, value: '111' },
    ]);

    const [, args] = prisma.calls[0] as [string, { where: { AND: unknown[] } }];
    assert.deepStrictEqual(args.where.AND, [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: (args.where.AND[0] as { OR: { expiresAt: { gt: Date } }[] }).OR[1].expiresAt.gt } }] },
    ]);
  });
});

describe('cascading a user block onto their identities', () => {
  it('captures every identity the account carries', async () => {
    // This is what makes blocking outlast the account: without it, the same
    // person signs up again and the ban is gone.
    const { service, prisma } = buildService();
    const captured = await service.captureFromUser({
      telegramId: 123n,
      email: 'Abuser@Example.com',
      webLogin: 'AbUser',
      reason: 'spam',
    });

    assert.equal(captured, 3);
    assert.deepStrictEqual(
      prisma.store.map((r) => [r.kind, r.value, r.source]),
      [
        [BlockedIdentityKind.TELEGRAM_ID, '123', 'cascade'],
        [BlockedIdentityKind.EMAIL, 'abuser@example.com', 'cascade'],
        [BlockedIdentityKind.WEB_LOGIN, 'abuser', 'cascade'],
      ],
    );
  });

  it('skips the identities the account does not have', async () => {
    const { service, prisma } = buildService();
    const captured = await service.captureFromUser({
      telegramId: null,
      email: null,
      webLogin: 'only-login',
    });
    assert.equal(captured, 1);
    assert.equal(prisma.store.length, 1);
  });

  it('releases only what the cascade created, never a hand-typed entry', async () => {
    // Unblocking has to undo its own cascade or the person stays locked out by
    // the entries their ban created — a bug that looks exactly like "unblock
    // does nothing". But an operator who listed this id by hand meant it, and
    // unblocking one account is not consent to drop that.
    const { service, prisma } = buildService();
    await service.releaseCascadeForUser({
      telegramId: 123n,
      email: null,
      webLogin: null,
    });

    const [, where] = prisma.calls[0] as [string, Record<string, unknown>];
    assert.equal(where.source, 'cascade');
    assert.deepStrictEqual(where.OR, [
      { kind: BlockedIdentityKind.TELEGRAM_ID, value: '123' },
    ]);
  });
});
