import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PromocodeMetricsService } from '../src/modules/promocodes/services/promocode-metrics.service';

describe('PromocodeMetricsService', () => {
  it('emits safe activation success metadata without raw promo codes or request identifiers', () => {
    const service = new PromocodeMetricsService();
    const logs: unknown[] = [];

    (service as unknown as { readonly logger: { log: (message: unknown) => void } }).logger.log = (message: unknown): void => {
      logs.push(message);
    };

    service.recordActivationSuccess({
      source: 'admin',
      codeNormalized: 'VIP-SUPER-SECRET-CODE-2025',
      rewardType: 'SUBSCRIPTION',
      requestId: 'req_user-123_payment-secret-token',
      correlationId: 'corr_trace_secret_456',
    });

    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      event: 'promocode.activation.success',
      source: 'admin',
      codePresent: true,
      rewardType: 'SUBSCRIPTION',
      requestIdPresent: true,
      correlationIdPresent: true,
    });

    const serialized = JSON.stringify(logs);
    assert.equal(serialized.includes('VIP-SUPER-SECRET-CODE-2025'), false);
    assert.equal(serialized.includes('req_user-123_payment-secret-token'), false);
    assert.equal(serialized.includes('corr_trace_secret_456'), false);
  });

  it('emits safe failure/depleted/expired metadata without raw promo code or request identifiers', () => {
    const service = new PromocodeMetricsService();
    const warnings: unknown[] = [];

    (service as unknown as { readonly logger: { warn: (message: unknown) => void } }).logger.warn = (message: unknown): void => {
      warnings.push(message);
    };

    service.recordActivationFailure({
      source: 'internal',
      codeNormalized: 'RAW-PROMO-CODE-secret-token',
      rewardType: 'SUBSCRIPTION',
      errorCode: 'DEPLETED',
      requestId: 'request_user@example.com_secret',
    });

    assert.deepEqual(warnings, [
      {
        event: 'promocode.activation.failure',
        source: 'internal',
        codePresent: true,
        rewardType: 'SUBSCRIPTION',
        requestIdPresent: true,
        correlationIdPresent: false,
        errorCode: 'DEPLETED',
      },
      {
        event: 'promocode.activation.depleted',
        source: 'internal',
        codePresent: true,
        rewardType: 'SUBSCRIPTION',
        requestIdPresent: true,
        correlationIdPresent: false,
        errorCode: 'DEPLETED',
      },
    ]);

    const serialized = JSON.stringify(warnings);
    assert.equal(serialized.includes('RAW-PROMO-CODE-secret-token'), false);
    assert.equal(serialized.includes('request_user@example.com_secret'), false);
  });

  it('emits safe expired metadata with independent request and correlation presence flags', () => {
    const service = new PromocodeMetricsService();
    const warnings: unknown[] = [];

    (service as unknown as { readonly logger: { warn: (message: unknown) => void } }).logger.warn = (message: unknown): void => {
      warnings.push(message);
    };

    service.recordActivationFailure({
      source: 'admin',
      codeNormalized: 'EXPIRED-PROMO-CODE-secret-token',
      rewardType: 'SUBSCRIPTION',
      errorCode: 'EXPIRED',
      correlationId: 'corr_user@example.com_secret',
    });

    assert.deepEqual(warnings, [
      {
        event: 'promocode.activation.failure',
        source: 'admin',
        codePresent: true,
        rewardType: 'SUBSCRIPTION',
        requestIdPresent: false,
        correlationIdPresent: true,
        errorCode: 'EXPIRED',
      },
      {
        event: 'promocode.activation.expired',
        source: 'admin',
        codePresent: true,
        rewardType: 'SUBSCRIPTION',
        requestIdPresent: false,
        correlationIdPresent: true,
        errorCode: 'EXPIRED',
      },
    ]);

    const serialized = JSON.stringify(warnings);
    assert.equal(serialized.includes('EXPIRED-PROMO-CODE-secret-token'), false);
    assert.equal(serialized.includes('corr_user@example.com_secret'), false);
  });

  it('uses bounded emit-failure metadata when logging throws', () => {
    const service = new PromocodeMetricsService();
    const warnings: unknown[] = [];

    (service as unknown as { readonly logger: { log: (message: unknown) => void; warn: (message: unknown) => void } }).logger.log = (): void => {
      throw new Error('logger failed with promo SECRET-CODE user@example.com token');
    };
    (service as unknown as { readonly logger: { warn: (message: unknown) => void } }).logger.warn = (message: unknown): void => {
      warnings.push(message);
    };

    service.recordActivationSuccess({
      source: 'admin',
      codeNormalized: 'SECRET-CODE-2025',
      rewardType: 'SUBSCRIPTION',
      requestId: 'request-secret-1',
    });

    assert.deepEqual(warnings, [
      {
        event: 'promocode.metrics.emit_failed',
        kind: 'success',
        source: 'admin',
        errorType: 'Error',
      },
    ]);

    const serialized = JSON.stringify(warnings);
    assert.equal(serialized.includes('SECRET-CODE-2025'), false);
    assert.equal(serialized.includes('request-secret-1'), false);
    assert.equal(serialized.includes('logger failed'), false);
    assert.equal(serialized.includes('user@example.com'), false);
    assert.equal(serialized.includes('token'), false);
  });
});
