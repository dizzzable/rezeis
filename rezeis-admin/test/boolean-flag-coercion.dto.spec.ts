import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

import { ListFraudExemptionsQueryDto } from '../src/modules/anti-fraud/dto/create-fraud-exemption.dto';
import { ReplayPaymentWebhookEventDto } from '../src/modules/payments/dto/replay-payment-webhook-event.dto';

/**
 * The remaining `@Type(() => Boolean)` flags found by sweeping `src/`, both of
 * which decoded `'false'` and `'0'` as `true`.
 *
 * They are grouped here because they share one root cause and one fix, but they
 * are reached differently and fail differently:
 *
 *   `activeOnly` is a QUERY flag and already has a client advertising it
 *     (`web/src/features/fraud/fraud-api.ts` takes `activeOnly?: boolean`, and
 *     axios serialises boolean `false` to the string `'false'`). It NARROWS the
 *     result set, so arriving inverted HIDES the revoked and expired exemptions
 *     an operator is looking for.
 *
 *   `force` is a BODY flag, which looks safe because JSON carries real
 *     booleans - except `main.ts` boots with `bodyParser: false` and then
 *     registers `useBodyParser('urlencoded', ...)`, so a form-encoded
 *     `force=false` arrives as the string `'false'` and forced a payment
 *     webhook replay.
 *
 * Both drive the REAL global pipe over the REAL DTO.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

function meta(metatype: unknown, type: 'query' | 'body'): ArgumentMetadata {
  return { type, metatype: metatype as ArgumentMetadata['metatype'], data: undefined };
}

describe('ListFraudExemptionsQueryDto activeOnly coercion', () => {
  async function query(raw: Record<string, unknown>): Promise<ListFraudExemptionsQueryDto> {
    return (await pipe.transform(raw, meta(ListFraudExemptionsQueryDto, 'query'))) as
      ListFraudExemptionsQueryDto;
  }

  it('reads ?activeOnly=false as false (it coerced to true before)', async () => {
    const dto = await query({ activeOnly: 'false' });
    // The controller narrows on `=== true`; computed before assertions narrow it.
    const wouldNarrow: boolean = dto.activeOnly === true;

    assert.equal(wouldNarrow, false, 'false must not hide revoked/expired exemptions');
    assert.equal(dto.activeOnly, false);
  });

  it('reads ?activeOnly=0 as false (it coerced to true before)', async () => {
    const dto = await query({ activeOnly: '0' });
    const wouldNarrow: boolean = dto.activeOnly === true;

    assert.equal(wouldNarrow, false);
    assert.equal(dto.activeOnly, false);
  });

  it('reads ?activeOnly=true and ?activeOnly=1 as true', async () => {
    assert.equal((await query({ activeOnly: 'true' })).activeOnly, true);
    assert.equal((await query({ activeOnly: '1' })).activeOnly, true);
  });

  it('leaves an absent flag undefined so history stays visible', async () => {
    const dto = await query({});
    const wouldNarrow: boolean = dto.activeOnly === true;

    assert.equal(wouldNarrow, false);
    assert.equal(dto.activeOnly, undefined);
  });

  it('refuses an ambiguous value instead of inverting the filter', async () => {
    await assert.rejects(() => query({ activeOnly: 'banana' }));
    await assert.rejects(() => query({ activeOnly: '2' }));
  });
});

describe('ReplayPaymentWebhookEventDto force coercion', () => {
  async function body(raw: Record<string, unknown>): Promise<ReplayPaymentWebhookEventDto> {
    return (await pipe.transform(raw, meta(ReplayPaymentWebhookEventDto, 'body'))) as
      ReplayPaymentWebhookEventDto;
  }

  it('reads a form-encoded force=false as false (it forced a replay before)', async () => {
    const dto = await body({ reason: 'investigating', force: 'false' });
    // The controller passes `body.force ?? false` straight into replayEvent.
    const wouldForce: boolean = dto.force === true;

    assert.equal(wouldForce, false, 'declining to force must not force');
    assert.equal(dto.force, false);
  });

  it('reads a form-encoded force=0 as false', async () => {
    const dto = await body({ reason: 'investigating', force: '0' });

    assert.equal(dto.force, false);
  });

  it('agrees with the JSON spelling of the same intent', async () => {
    const asJson = await body({ reason: 'investigating', force: false });
    const asForm = await body({ reason: 'investigating', force: 'false' });

    assert.equal(asJson.force, asForm.force);
  });

  it('still honours an explicit force', async () => {
    assert.equal((await body({ reason: 'investigating', force: 'true' })).force, true);
    assert.equal((await body({ reason: 'investigating', force: true })).force, true);
  });

  it('leaves an absent flag undefined so the default stays "do not force"', async () => {
    const dto = await body({ reason: 'investigating' });

    assert.equal(dto.force, undefined);
    assert.equal(dto.force ?? false, false);
  });

  it('refuses an ambiguous value instead of guessing it into a forced replay', async () => {
    await assert.rejects(() => body({ reason: 'investigating', force: 'banana' }));
  });
});
