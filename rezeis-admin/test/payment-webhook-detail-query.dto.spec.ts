import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

import { PaymentWebhookEventDetailQueryDto } from '../src/modules/payments/dto/list-payment-webhook-events-query.dto';

/**
 * `includeRaw` decides whether `GET /admin/payments/webhooks/:eventId` returns
 * the webhook's raw provider payload, and every reveal writes an audit entry
 * (`AdminPaymentWebhooksController.getEventDetail` ->
 * `PaymentWebhookOpsService.auditPayloadReveal`).
 *
 * It used to be declared `@Type(() => Boolean)`. On a query string that is
 * plain `Boolean(string)`, so `?includeRaw=false` and `?includeRaw=0` both
 * arrived as `true`, and only a valueless `?includeRaw=` produced `false`. A
 * "hide raw payload" control wired to that field would have revealed the
 * payload AND logged an operator as having revealed it - the one direction
 * this flag must never fail in. It went unexploited only because the detail
 * route has no client caller yet.
 *
 * These cases drive the REAL global `ValidationPipe` (the `main.ts` options)
 * over the REAL DTO, so the coercion cannot regress behind a hand-rolled
 * stand-in that agrees with whatever the DTO currently happens to say.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const metadata: ArgumentMetadata = {
  type: 'query',
  metatype: PaymentWebhookEventDetailQueryDto,
  data: undefined,
};

async function transformQuery(
  query: Record<string, unknown>,
): Promise<PaymentWebhookEventDetailQueryDto> {
  return (await pipe.transform(query, metadata)) as PaymentWebhookEventDetailQueryDto;
}

function constraintMessages(error: unknown): readonly string[] {
  const response = (error as { getResponse: () => unknown }).getResponse();
  const message = (response as { message?: unknown }).message;
  return Array.isArray(message) ? (message as readonly string[]) : [String(message)];
}

describe('PaymentWebhookEventDetailQueryDto includeRaw coercion', () => {
  it('reads ?includeRaw=false as false (it coerced to true before)', async () => {
    const dto = await transformQuery({ includeRaw: 'false' });
    // Computed BEFORE any assertion narrows the type - this is verbatim the
    // expression the controller branches on.
    const wouldReveal: boolean = dto.includeRaw === true;

    assert.equal(
      wouldReveal,
      false,
      'the controller gates auditPayloadReveal on `=== true`; false must not trip it',
    );
    assert.equal(dto.includeRaw, false);
  });

  it('reads ?includeRaw=0 as false (it coerced to true before)', async () => {
    const dto = await transformQuery({ includeRaw: '0' });
    const wouldReveal: boolean = dto.includeRaw === true;

    assert.equal(wouldReveal, false);
    assert.equal(dto.includeRaw, false);
  });

  it('reads ?includeRaw=true as true', async () => {
    const dto = await transformQuery({ includeRaw: 'true' });

    assert.equal(dto.includeRaw, true);
  });

  it('reads ?includeRaw=1 as true', async () => {
    const dto = await transformQuery({ includeRaw: '1' });

    assert.equal(dto.includeRaw, true);
  });

  it('leaves an absent flag undefined so the payload stays hidden', async () => {
    const dto = await transformQuery({});
    const wouldReveal: boolean = dto.includeRaw === true;

    assert.equal(wouldReveal, false);
    assert.equal(dto.includeRaw, undefined);
  });

  it('treats a valueless ?includeRaw= as absence', async () => {
    const dto = await transformQuery({ includeRaw: '' });
    const wouldReveal: boolean = dto.includeRaw === true;

    assert.equal(wouldReveal, false);
    assert.equal(dto.includeRaw, undefined);
  });

  it('refuses an ambiguous value instead of guessing it into a reveal', async () => {
    await assert.rejects(
      () => transformQuery({ includeRaw: 'banana' }),
      (error: unknown) => {
        const messages = constraintMessages(error);
        assert.ok(
          messages.some((entry) => entry.includes('includeRaw')),
          `expected an includeRaw constraint, got ${JSON.stringify(messages)}`,
        );
        return true;
      },
    );
  });

  it('refuses ?includeRaw=2, which Boolean() would have turned into a reveal', async () => {
    await assert.rejects(() => transformQuery({ includeRaw: '2' }));
  });

  it('still refuses an unknown query parameter', async () => {
    await assert.rejects(() => transformQuery({ includeRawPlease: '1' }));
  });
});
