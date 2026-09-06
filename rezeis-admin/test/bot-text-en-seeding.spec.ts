import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalBotConfigService } from '../src/modules/bot-config/services/internal-bot-config.service';

/**
 * The English bot texts have to be created on installations that already exist.
 *
 * WHAT WENT WRONG. `seedDefaultTexts` runs on every boot and skips a seed whose
 * Russian row is already there. The English sibling was created INSIDE that
 * skipped branch:
 *
 *     if (existing !== null) continue;
 *     try {
 *       await create({ key: seed.key, … });
 *       // "Checked separately because a deployment that already has the
 *       //  Russian row still needs the English one…"
 *       if (seed.valueEn !== undefined) { … }
 *
 * Every upgrade has the Russian rows, so `continue` fired for every seed and not
 * one English row was ever written. Only a virgin database got them. The comment
 * asserted precisely the behaviour the code did not have, which is why nobody
 * re-read it — and the whole English bot vocabulary silently did nothing.
 *
 * Nothing else could catch this. The contract spec next door builds the service
 * with `botText.findUnique` answering "already seeded" for everything, which is
 * the exact state in which the defect is invisible: no row is created either
 * way, and the payload it asserts is composed from operator rows, not seeds.
 *
 * So this drives the seeding itself, with a database that answers the way a real
 * upgrade does — Russian present, English absent — and asserts what gets written.
 */

interface Created {
  readonly key: string;
  readonly value: string;
}

/**
 * A service whose database already holds every Russian seed and no English one.
 *
 * `seedDefaultTexts` is private, and deliberately reached through
 * `onApplicationBootstrap` rather than through a cast: the bug was that the
 * seeding never RAN for these rows, so the test has to enter by the same door
 * production does.
 */
function buildSeedingService(): { start: () => Promise<void>; created: Created[] } {
  const created: Created[] = [];

  const prismaService = {
    settings: { findFirst: async () => null, create: async () => ({}) },
    botButton: { count: async () => 1 },
    botEmoji: { findUnique: async () => ({ id: 'seeded' }) },
    botText: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        // The shape of a real upgrade: Russian rows exist, English ones do not.
        where.key.endsWith('@en') ? null : { id: 'seeded' },
    },
  };

  const botTextsService = {
    listAll: async () => [],
    create: async (input: Created) => {
      created.push({ key: input.key, value: input.value });
      return { id: `created-${created.length}` };
    },
  };

  const service = new InternalBotConfigService(
    prismaService as never,
    { listAll: async () => [], count: async () => 1 } as never,
    { listAll: async () => [] } as never,
    botTextsService as never,
    { getActive: async () => null } as never,
  );

  return { start: () => service.onApplicationBootstrap(), created };
}

describe('English bot-text seeding', () => {
  it('writes the English rows on an installation that already has the Russian ones', async () => {
    const { start, created } = buildSeedingService();
    await start();

    const english = created.filter((row) => row.key.endsWith('@en'));
    assert.ok(
      english.length > 0,
      'no `@en` row was created — the English seeding is unreachable on every ' +
        'existing deployment, which is the defect this file exists for',
    );
    for (const row of english) {
      assert.ok(row.value.length > 0, `${row.key} was created with an empty value`);
    }
  });

  it('does not rewrite the Russian rows it found', async () => {
    // The other half of idempotence. A fix that simply dropped the guard would
    // make this pass its sibling above and overwrite operator edits on every
    // single boot.
    const { start, created } = buildSeedingService();
    await start();

    const russian = created.filter((row) => !row.key.endsWith('@en'));
    assert.deepEqual(
      russian.map((row) => row.key),
      [],
      'a seed whose Russian row already exists was written again',
    );
  });

  it('creates nothing at all when both languages are already there', async () => {
    const created: Created[] = [];
    const service = new InternalBotConfigService(
      {
        settings: { findFirst: async () => null, create: async () => ({}) },
        botButton: { count: async () => 1 },
        botEmoji: { findUnique: async () => ({ id: 'seeded' }) },
        botText: { findUnique: async () => ({ id: 'seeded' }) },
      } as never,
      { listAll: async () => [], count: async () => 1 } as never,
      { listAll: async () => [] } as never,
      {
        listAll: async () => [],
        create: async (input: Created) => {
          created.push(input);
          return { id: 'x' };
        },
      } as never,
      { getActive: async () => null } as never,
    );

    await service.onApplicationBootstrap();
    assert.deepEqual(created, [], 'seeding wrote rows into a fully seeded database');
  });
});
