import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { UserHintCtaKind } from '@prisma/client';

import { AdminUserHintsController } from '../src/modules/user-hints/controllers/admin-user-hints.controller';
import {
  HINT_DOORS_HEADER,
  InternalUserHintsController,
  parseHintDoors,
} from '../src/modules/user-hints/controllers/internal-user-hints.controller';
import { HINT_DOOR_TARGETS, HINT_ROUTE_TARGETS } from '../src/modules/user-hints/dto/user-hint.dto';
import { openableDoorsForQuery } from '../src/modules/user-hints/services/user-hint-delivery.service';
import { UserHintService } from '../src/modules/user-hints/services/user-hint.service';

/**
 * THE `@connect` DOOR.
 *
 * A hint's button normally names a cabinet path, and the cabinet navigates to
 * it verbatim. `@connect` is not a path: the cabinet opens whatever its
 * Connect button opens — the internal connect screen or the external
 * subscription page — by the operator's one switch. So:
 *
 *   - the panel accepts it for a ROUTE button and for nothing else;
 *   - the editor is offered it in the route vocabulary;
 *   - a cabinet DECLARES that it opens it, in `x-reiwa-hint-doors`, and one
 *     that did not is never handed such a hint (the query half is in
 *     `user-hint-delivery.spec.ts` and on PostgreSQL).
 *
 * Doors are CASE-SENSITIVE. Modes are upper-cased on the way in; doors never
 * are — the cabinet sends `@connect`, and that string is the whole contract.
 */

const ROOT = join(__dirname, '..');

// ── Authoring ────────────────────────────────────────────────────────────────

function authoring() {
  const written: Array<Record<string, unknown>> = [];
  const prisma = {
    userHint: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return { id: 'hint-1', ...data };
      },
    },
  };
  return { service: new UserHintService(prisma as never), written };
}

function hintWith(ctaKind: UserHintCtaKind, ctaTarget: string) {
  return {
    key: 'connect-door',
    titleRu: 'Не получилось подключиться?',
    bodyRu: 'Откройте экран подключения.',
    ctaKind,
    ctaLabelRu: 'Подключить',
    ctaTarget,
  };
}

describe('authoring a button aimed at the door', () => {
  it('is accepted for a ROUTE button, stored exactly as named', async () => {
    const { service, written } = authoring();

    await service.create(hintWith(UserHintCtaKind.ROUTE, '@connect') as never);

    assert.equal(written.length, 1);
    assert.equal(written[0]?.ctaKind, UserHintCtaKind.ROUTE);
    assert.equal(written[0]?.ctaTarget, '@connect');
  });

  it('is refused for an EXTERNAL button, which is a URL and nothing else', async () => {
    const { service, written } = authoring();

    await assert.rejects(
      () => service.create(hintWith(UserHintCtaKind.EXTERNAL, '@connect') as never),
      BadRequestException,
    );
    assert.deepStrictEqual(written, []);
  });

  it('refuses a door this panel does not know, and the right door in the wrong case', async () => {
    for (const target of ['@x', '@CONNECT', '@Connect', '@', '@connect/', ' @connect-now']) {
      const { service, written } = authoring();

      await assert.rejects(
        () => service.create(hintWith(UserHintCtaKind.ROUTE, target) as never),
        BadRequestException,
        `${JSON.stringify(target)} was accepted as a door`,
      );
      assert.deepStrictEqual(written, []);
    }
  });

  it('keeps accepting every ordinary route, and still refuses the connect screen by path', async () => {
    for (const route of HINT_ROUTE_TARGETS) {
      const { service } = authoring();
      await service.create(hintWith(UserHintCtaKind.ROUTE, route) as never);
    }
    const { service } = authoring();
    await assert.rejects(
      () => service.create(hintWith(UserHintCtaKind.ROUTE, '/subscription/connect') as never),
      BadRequestException,
    );
  });

  it('names the door in the refusal an operator reads', async () => {
    const { service } = authoring();

    await assert.rejects(
      () => service.create(hintWith(UserHintCtaKind.ROUTE, '/nowhere') as never),
      (error: unknown) => {
        assert.match(String((error as Error).message), /@connect/);
        return true;
      },
    );
  });
});

describe('the vocabulary the editor builds its picker from', () => {
  it('offers the door among the routes, after every path', () => {
    const controller = new AdminUserHintsController({} as never, {} as never);

    const { routes } = controller.vocabulary();

    assert.deepStrictEqual([...routes], [...HINT_ROUTE_TARGETS, ...HINT_DOOR_TARGETS]);
    assert.ok(routes.includes('@connect'));
  });

  it('holds doors that all start with "@", which no path does — the delivery filter depends on it', () => {
    assert.ok(HINT_DOOR_TARGETS.length > 0);
    for (const door of HINT_DOOR_TARGETS) assert.match(door, /^@[a-z-]+$/);
    for (const route of HINT_ROUTE_TARGETS) assert.match(route, /^\//);
  });
});

// ── The header ───────────────────────────────────────────────────────────────

describe('reading the doors header', () => {
  it('takes the door a cabinet names', () => {
    assert.deepStrictEqual(parseHintDoors('@connect'), ['@connect']);
  });

  it('answers none when the cabinet said nothing', () => {
    // A cabinet older than the header navigates to a target verbatim.
    assert.deepStrictEqual(parseHintDoors(undefined), []);
    assert.deepStrictEqual(parseHintDoors(''), []);
    assert.deepStrictEqual(parseHintDoors(' , , '), []);
  });

  it('tolerates the spacing a comma-separated header picks up, and names a door once', () => {
    assert.deepStrictEqual(parseHintDoors(' @connect , @connect '), ['@connect']);
  });

  it('is case-sensitive — never upper-cased the way modes are', () => {
    assert.deepStrictEqual(parseHintDoors('@CONNECT'), []);
    assert.deepStrictEqual(parseHintDoors('@Connect'), []);
  });

  it('ignores doors this panel does not know, and keeps the ones it does', () => {
    assert.deepStrictEqual(parseHintDoors('@teleport,@connect,/plans'), ['@connect']);
  });

  it('is bounded in length and count, because it arrives from the network', () => {
    // What a bound can cost is a door, which HOLDS a hint — never one handed
    // to a cabinet that cannot open it.
    const flood = Array.from({ length: 5000 }, (_, index) => `@door${index}`).join(',');
    assert.deepStrictEqual(parseHintDoors(flood), []);
    assert.deepStrictEqual(parseHintDoors(`${flood},@connect`), [], 'read past its bounds');
    assert.deepStrictEqual(parseHintDoors(`@connect,${flood}`), ['@connect']);
    assert.deepStrictEqual(parseHintDoors(`${'x'.repeat(600)},@connect`), [], 'read past its length bound');
  });

  it('is a header name Node will actually deliver', () => {
    assert.equal(HINT_DOORS_HEADER, HINT_DOORS_HEADER.toLowerCase());
    assert.equal(HINT_DOORS_HEADER, 'x-reiwa-hint-doors');
  });

  it('travels in a header, not in the body an older panel would refuse', () => {
    const controller = readFileSync(
      join(ROOT, 'src', 'modules', 'user-hints', 'controllers', 'internal-user-hints.controller.ts'),
      'utf8',
    );
    const dtoStart = controller.indexOf('class HintAudienceDto {');
    const dtoEnd = controller.indexOf('\n}', dtoStart);
    assert.ok(dtoStart > 0, 'HintAudienceDto is gone');
    assert.equal(controller.slice(dtoStart, dtoEnd).includes('doors'), false);
    assert.match(controller, /@Headers\(HINT_DOORS_HEADER\)/);
  });
});

describe('the doors a cabinet declared', () => {
  function build() {
    const asks: Array<{ readonly audience: { readonly doors?: readonly string[] } }> = [];
    const deliveries = {
      nextFor: async (input: { readonly audience: { readonly doors?: readonly string[] } }) => {
        asks.push(input);
        return null;
      },
    };
    const prisma = { user: { findUnique: async () => ({ id: 'user-1' }) } };
    return { controller: new InternalUserHintsController(deliveries as never, prisma as never), asks };
  }

  async function doorsAskedFor(header: string | undefined): Promise<readonly string[] | undefined> {
    const { controller, asks } = build();
    await controller.next({ telegramId: '123' } as never, undefined, header);
    assert.equal(asks.length, 1, 'the delivery service was not asked exactly once');
    return asks[0]?.audience.doors;
  }

  it('reach the delivery service', async () => {
    assert.deepStrictEqual(await doorsAskedFor('@connect'), ['@connect']);
  });

  it('are none when the cabinet said nothing', async () => {
    assert.deepStrictEqual(await doorsAskedFor(undefined), []);
  });

  it('are filtered again by the service, so an unknown or mis-cased door never reaches the query', () => {
    assert.deepStrictEqual(openableDoorsForQuery(['@connect', '@CONNECT', '@x']), ['@connect']);
    assert.deepStrictEqual(openableDoorsForQuery(undefined), []);
  });
});
