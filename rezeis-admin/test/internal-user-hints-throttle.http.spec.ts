import 'reflect-metadata';

import assert from 'node:assert/strict';
import * as http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../src/common/prisma/prisma.service';
import { ThrottleModule } from '../src/common/throttle/throttle.module';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { InternalUserHintsController } from '../src/modules/user-hints/controllers/internal-user-hints.controller';
import { UserHintDeliveryService } from '../src/modules/user-hints/services/user-hint-delivery.service';

/**
 * The cabinet's hint asks are not rate-limited per address
 * ════════════════════════════════════════════════════════
 *
 * `ThrottleModule` allows every handler 600 requests a minute per caller IP.
 * Every call to `/internal/user-hints/*` comes from the cabinet's backend — one
 * address, speaking for every customer — so that ceiling was 600 hint asks a
 * minute for the whole customer base, and past it every customer's ask
 * answered 429 and nobody was shown a hint.
 *
 * Proved the way `auth-code-route-brute-force.http.spec.ts` proves a limit: the
 * real `ThrottleModule`, a real server, and a count of what 601 requests from
 * one address get back. A decorator is trivially present and proves nothing on
 * its own — under a throttler name the module does not define it exempts
 * nothing — so the metadata check at the end is an addition, never the proof.
 * Beside the hint route sits one that has no exemption, in the same app, so a
 * throttler that was never switched on cannot pass for an exemption.
 */

/** One more than the global per-address ceiling in `ThrottleModule`. */
const OVER_THE_CEILING = 601;

/** A reiwa_id in the shape `buildUserReferenceWhere` accepts (a CUID). */
const CUSTOMER = 'cmf1hintasker00000000abcd';

@Controller('internal/throttle-control')
class UnexemptedController {
  @Post('ask')
  public ask(): { ok: boolean } {
    return { ok: true };
  }
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function post(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        agent,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

/** Fires `count` requests one after another and tallies the statuses. */
async function histogram(port: number, path: string, body: unknown, count: number): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (let attempt = 0; attempt < count; attempt += 1) {
    const status = await post(port, path, body);
    tally[String(status)] = (tally[String(status)] ?? 0) + 1;
  }
  return tally;
}

describe('the cabinet’s hint routes and the global throttler', () => {
  let app: INestApplication;
  let port: number;

  before(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [InternalUserHintsController, UnexemptedController],
      providers: [
        {
          provide: UserHintDeliveryService,
          useValue: {
            nextFor: async () => null,
            raise: async () => null,
            markShown: async () => false,
            close: async () => false,
          },
        },
        { provide: PrismaService, useValue: { user: { findUnique: async () => ({ id: CUSTOMER }) } } },
      ],
    })
      // The shared secret is not what is under test; the address-based limit is.
      .overrideGuard(InternalAdminAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
  });

  after(async () => {
    agent.destroy();
    await app?.close();
  });

  it('answers every one of 601 hint asks from one address, while a route beside it is refused at 601', async () => {
    // The control first, in the same case: a throttler that never switched on
    // in this app would otherwise pass for an exemption.
    assert.deepEqual(
      await histogram(port, '/internal/throttle-control/ask', {}, OVER_THE_CEILING),
      { '201': 600, '429': 1 },
      'the throttler is not live in this app, so the hint histogram below would prove nothing',
    );
    assert.deepEqual(
      await histogram(port, '/internal/user-hints/next', { userId: CUSTOMER, locale: 'ru' }, OVER_THE_CEILING),
      { '201': OVER_THE_CEILING },
      'the hint ask is throttled per address, so one busy minute starves every customer',
    );
  });

  it('declares the exemption on the controller, so every hint route has it', () => {
    // An addition to the histogram above, not a substitute: it covers the three
    // routes not fired at, which inherit the controller's declaration.
    assert.equal(Reflect.getMetadata('THROTTLER:SKIPdefault', InternalUserHintsController), true);
    for (const handler of ['next', 'moment', 'shown', 'closed'] as const) {
      assert.notEqual(
        Reflect.getMetadata('THROTTLER:SKIPdefault', InternalUserHintsController.prototype[handler]),
        false,
        `${handler} opts back in to the throttler`,
      );
    }
  });
});
