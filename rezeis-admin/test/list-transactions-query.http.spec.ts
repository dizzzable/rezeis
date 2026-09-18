import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TransactionStatus } from '@prisma/client';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { AdminPaymentTransactionsController } from '../src/modules/payments/controllers/admin-payment-transactions.controller';
import { ListTransactionsQueryDto } from '../src/modules/payments/dto/list-transactions-query.dto';
import { PaymentRefundService } from '../src/modules/payments/services/payment-refund.service';
import { PaymentsTransactionsService } from '../src/modules/payments/services/payments-transactions.service';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';

/**
 * `GET /admin/payments/transactions` as the panel's links reach it.
 *
 * Every case goes through the real `ValidationPipe`, configured exactly as
 * `src/main.ts` configures it, because what is under test is the answer a URL
 * gets — a DTO decorator read in isolation said nothing about the 400 that
 * `?userId=<a real user id>` actually came back with.
 *
 * The service is a recorder. A case that expects a refusal also asserts the
 * service was never reached: "400" and "400 after the query already ran" are
 * different defects, and only the first is a validation answer.
 */

/** Shaped like Prisma's `cuid()`: every User / Subscription id since 21.05.2026. */
const CUID = 'cmfk2x9pq0000abcd1234efgh';
/** Shaped like the baseline schema's `uuid()`, which rows older than that carry. */
const LEGACY_UUID = '3f1c2b7e-8d4a-4c5b-9e6f-0a1b2c3d4e5f';

const PATH = '/api/admin/payments/transactions';

describe('ListTransactionsQueryDto over HTTP', () => {
  let application: INestApplication;
  const listCalls: ListTransactionsQueryDto[] = [];

  before(async () => {
    const transactionsService = {
      listTransactions: async (query: ListTransactionsQueryDto) => {
        listCalls.push(query);
        return { items: [], total: 0 };
      },
    } satisfies Pick<PaymentsTransactionsService, 'listTransactions'>;
    const refundService = {
      getEligibility: async (): Promise<never> => {
        throw new Error('this spec never asks for refund eligibility');
      },
      refundTransaction: async (): Promise<never> => {
        throw new Error('this spec never refunds');
      },
    } satisfies Pick<PaymentRefundService, 'getEligibility' | 'refundTransaction'>;

    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [AdminPaymentTransactionsController],
      providers: [
        { provide: PaymentsTransactionsService, useValue: transactionsService },
        { provide: PaymentRefundService, useValue: refundService },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({ canActivate: (): boolean => true })
      .overrideGuard(RbacGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();

    application = testingModule.createNestApplication();
    application.setGlobalPrefix('api');
    application.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
  });

  beforeEach(() => {
    listCalls.length = 0;
  });

  after(async () => {
    await application.close();
  });

  async function refused(query: string, field: string): Promise<void> {
    const response = await request(application.getHttpServer()).get(`${PATH}?${query}`).expect(400);
    const messages: unknown = response.body.message;
    assert.ok(Array.isArray(messages), `expected ValidationPipe's per-field messages for ${query}`);
    assert.ok(
      messages.some((message) => typeof message === 'string' && message.startsWith(field)),
      `expected a message naming ${field} for ${query}, got ${JSON.stringify(messages)}`,
    );
    assert.equal(listCalls.length, 0, `the service must not run for ${query}`);
  }

  describe('userId', () => {
    it('accepts a cuid — the shape User.id actually has', async () => {
      await request(application.getHttpServer()).get(PATH).query({ userId: CUID }).expect(200);

      assert.equal(listCalls.length, 1);
      assert.ok(listCalls[0] instanceof ListTransactionsQueryDto);
      assert.equal(listCalls[0]?.userId, CUID);
    });

    it('still accepts a UUID, which users created before the schema moved to cuid carry', async () => {
      await request(application.getHttpServer()).get(PATH).query({ userId: LEGACY_UUID }).expect(200);

      assert.equal(listCalls[0]?.userId, LEGACY_UUID);
    });

    it('answers anything that cannot be a user id with 400, never with an unfiltered list', async () => {
      // A Telegram id is the likeliest wrong value: `userSearch` takes it, `userId` does not.
      await refused('userId=123456789', 'userId');
      await refused('userId=not-an-id', 'userId');
      await refused(`userId=${CUID.toUpperCase()}`, 'userId');
      await refused('userId=c123', 'userId');
      await refused('userId=', 'userId');
    });
  });

  describe('subscriptionId', () => {
    it('accepts a cuid and a legacy UUID', async () => {
      await request(application.getHttpServer()).get(PATH).query({ subscriptionId: CUID }).expect(200);
      await request(application.getHttpServer())
        .get(PATH)
        .query({ subscriptionId: LEGACY_UUID })
        .expect(200);

      assert.deepStrictEqual(
        listCalls.map((query) => query.subscriptionId),
        [CUID, LEGACY_UUID],
      );
    });

    it('refuses a malformed one', async () => {
      await refused('subscriptionId=sub-1', 'subscriptionId');
      await refused('subscriptionId=', 'subscriptionId');
    });
  });

  describe('q — one payment reference', () => {
    it('takes a pasted reference with its padding trimmed', async () => {
      await request(application.getHttpServer())
        .get(PATH)
        .query({ q: '  2d8e4f1a-000f-5000-9000-1b2c3d4e5f60  ' })
        .expect(200);

      assert.equal(listCalls[0]?.q, '2d8e4f1a-000f-5000-9000-1b2c3d4e5f60');
    });

    it('takes a provider reference that is no id of ours, since gateways choose their own', async () => {
      await request(application.getHttpServer())
        .get(PATH)
        .query({ q: 'stxAbC_123-charge.9' })
        .expect(200);

      assert.equal(listCalls[0]?.q, 'stxAbC_123-charge.9');
    });

    it('refuses an empty, blank, oversized, repeated or control-character search', async () => {
      await refused('q=', 'q');
      await refused('q=%20%20%20', 'q');
      await refused(`q=${'a'.repeat(201)}`, 'q');
      await refused('q=first&q=second', 'q');
      await refused(`q=${encodeURIComponent(`pay${String.fromCharCode(7)}ment`)}`, 'q');
    });

    it('accepts the longest reference it promises to', async () => {
      await request(application.getHttpServer()).get(PATH).query({ q: 'a'.repeat(200) }).expect(200);

      assert.equal(listCalls[0]?.q?.length, 200);
    });
  });

  describe('userSearch', () => {
    it('takes the longest e-mail address there can be', async () => {
      const email = `${'a'.repeat(64)}@${'b'.repeat(184)}.test`;
      assert.equal(email.length, 254);

      await request(application.getHttpServer()).get(PATH).query({ userSearch: email }).expect(200);

      assert.equal(listCalls[0]?.userSearch, email);
    });

    it('refuses anything longer, as it refuses an over-long q', async () => {
      await refused(`userSearch=${'a'.repeat(255)}`, 'userSearch');
    });
  });

  it('filters by REFUNDED, the status the panel used to leave out of its picker', async () => {
    await request(application.getHttpServer())
      .get(PATH)
      .query({ status: TransactionStatus.REFUNDED })
      .expect(200);

    assert.equal(listCalls[0]?.status, TransactionStatus.REFUNDED);
  });

  it('refuses a status that does not exist', async () => {
    await refused('status=PAID', 'status');
  });

  it('refuses a parameter the endpoint does not know, so a UI-only key cannot leak into the request', async () => {
    // `payment` is the SPA's "which payment is open" key. It belongs in the
    // address bar, never in the API request — and if it ever is sent, the
    // answer is a 400 naming it, not a list that quietly ignored it.
    const response = await request(application.getHttpServer())
      .get(PATH)
      .query({ payment: CUID })
      .expect(400);

    assert.ok(
      (response.body.message as string[]).some((message) => message.includes('payment should not exist')),
    );
    assert.equal(listCalls.length, 0);
  });
});
