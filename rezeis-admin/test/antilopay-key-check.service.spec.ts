import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';
import { Observable, of, throwError } from 'rxjs';

import {
  AntilopayKeyCheckService,
  readAntilopaySignatureCheckReply,
} from '../src/modules/payments/services/antilopay-key-check.service';

const KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const STORED = {
  projectIdentificator: 'project-1',
  secretId: 'secret-id-1',
  privateKey: KEY_PAIR.privateKey,
  publicKey: KEY_PAIR.publicKey,
};

interface Call {
  readonly url: string;
  readonly body: string;
  readonly options: {
    readonly headers: Record<string, string>;
    readonly timeout?: number;
    readonly validateStatus?: (status: number) => boolean;
  };
}

/** The service on a stored gateway, and what it asked Antilopay. */
function build(input: {
  readonly type?: PaymentGatewayType;
  readonly settings?: Record<string, unknown>;
  readonly missing?: boolean;
  readonly answer?: { readonly status?: number; readonly data: unknown } | Error;
}): { readonly service: AntilopayKeyCheckService; readonly calls: Call[] } {
  const calls: Call[] = [];
  const service = new AntilopayKeyCheckService(
    {
      paymentGateway: {
        findUnique: async () =>
          input.missing === true
            ? null
            : { id: 'gw-1', type: input.type ?? PaymentGatewayType.ANTILOPAY, settings: input.settings ?? STORED },
      },
    } as never,
    {
      post: (url: string, body: string, options: Call['options']): Observable<unknown> => {
        calls.push({ url, body, options });
        const answer = input.answer ?? { status: 200, data: { status: 'ok' } };
        return answer instanceof Error ? throwError(() => answer) : of(answer);
      },
    } as never,
  );
  return { service, calls };
}

describe('readAntilopaySignatureCheckReply', () => {
  it('reads {"status":"ok"} as the keys being right', () => {
    for (const data of [{ status: 'ok' }, { status: 'OK' }, { code: 0 }]) {
      assert.deepEqual(readAntilopaySignatureCheckReply(200, data), {
        verdict: 'OK',
        code: null,
        httpStatus: 200,
        failure: null,
      });
    }
  });

  it('maps the documented refusals to what the operator has to do', () => {
    const table: ReadonlyArray<readonly [number, string]> = [
      [3, 'SIGNATURE_REFUSED'],
      [1, 'SECRET_ID_REJECTED'],
      [2, 'SECRET_ID_REJECTED'],
      [22, 'IP_NOT_ALLOWED'],
    ];
    for (const [code, verdict] of table) {
      // Whichever HTTP status carries it: the code is what is read, not the status.
      for (const httpStatus of [200, 400, 401, 403]) {
        assert.deepEqual(readAntilopaySignatureCheckReply(httpStatus, { code, error: 'text is never read' }), {
          verdict,
          code,
          httpStatus,
          failure: null,
        });
      }
    }
  });

  it('reports a code it does not know, or a page that is not JSON, as no answer, with what it got', () => {
    assert.deepEqual(readAntilopaySignatureCheckReply(200, { code: 5, error: 'Something else' }), {
      verdict: 'NOT_ANSWERED',
      code: 5,
      httpStatus: 200,
      failure: null,
    });
    for (const data of ['<html>502 Bad Gateway</html>', null, undefined, [], 42, { status: 'fail' }, {}]) {
      assert.deepEqual(readAntilopaySignatureCheckReply(502, data), {
        verdict: 'NOT_ANSWERED',
        code: null,
        httpStatus: 502,
        failure: null,
      });
    }
  });
});

describe('AntilopayKeyCheckService', () => {
  it('signs a small JSON with the stored keys and posts it to signature/check as every call is signed', async () => {
    const { service, calls } = build({});

    const result = await service.check('gw-1');

    assert.deepEqual(result, { verdict: 'OK', code: null, httpStatus: 200, failure: null });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://lk.antilopay.com/api/v1/signature/check');
    assert.equal(call.options.headers['X-Apay-Secret-Id'], 'secret-id-1');
    assert.equal(call.options.headers['X-Apay-Sign-Version'], '1');
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    assert.doesNotThrow(() => JSON.parse(call.body), 'any JSON, and this one is');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(call.body);
    assert.equal(
      verifier.verify(createPublicKey(KEY_PAIR.publicKey), call.options.headers['X-Apay-Sign'] ?? '', 'base64'),
      true,
      'the signature is over the exact bytes sent',
    );
    assert.equal(call.options.timeout, 8_000, 'a button waits eight seconds, not the default forty-five');
    assert.equal(call.options.validateStatus?.(400), true, 'a refusal is a body, whichever status carries it');
    assert.equal(call.options.validateStatus?.(500), true);
  });

  it('answers what Antilopay answered, and never a credential', async () => {
    for (const [data, verdict] of [
      [{ code: 3, error: 'Invalid signature' }, 'SIGNATURE_REFUSED'],
      [{ code: 1, error: 'No secret id' }, 'SECRET_ID_REJECTED'],
      [{ code: 2, error: 'Wrong secret id' }, 'SECRET_ID_REJECTED'],
      [{ code: 22, error: 'IP is not allowed' }, 'IP_NOT_ALLOWED'],
    ] as const) {
      const { service } = build({ answer: { status: 400, data } });
      const result = await service.check('gw-1');
      assert.equal(result.verdict, verdict);
      const wire = JSON.stringify(result);
      assert.equal(wire.includes('secret-id-1'), false);
      assert.equal(wire.includes('BEGIN'), false);
    }
  });

  it('asks nothing when the Secret ID or the private key is not stored', async () => {
    for (const settings of [
      { projectIdentificator: 'p', privateKey: KEY_PAIR.privateKey },
      { projectIdentificator: 'p', secretId: 'secret-id-1' },
      { projectIdentificator: 'p', secretId: '   ', privateKey: KEY_PAIR.privateKey },
      {},
    ]) {
      const { service, calls } = build({ settings });
      assert.deepEqual(await service.check('gw-1'), {
        verdict: 'KEYS_MISSING',
        code: null,
        httpStatus: null,
        failure: null,
      });
      assert.equal(calls.length, 0);
    }
  });

  it('asks nothing of a private key that cannot sign, and says so', async () => {
    const { service, calls } = build({ settings: { ...STORED, privateKey: 'not-a-key' } });

    assert.deepEqual(await service.check('gw-1'), {
      verdict: 'PRIVATE_KEY_UNREADABLE',
      code: null,
      httpStatus: null,
      failure: null,
    });
    assert.equal(calls.length, 0);
  });

  it('tells a timeout from any other failure to connect', async () => {
    const timeout = Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    const refused = Object.assign(new Error('connect ECONNREFUSED 203.0.113.9:443'), { code: 'ECONNREFUSED' });
    const lookup = Object.assign(new Error('getaddrinfo ENOTFOUND lk.antilopay.com'), { code: 'ENOTFOUND' });

    assert.deepEqual(await build({ answer: timeout }).service.check('gw-1'), {
      verdict: 'NOT_ANSWERED',
      code: null,
      httpStatus: null,
      failure: 'TIMEOUT',
    });
    for (const error of [refused, lookup]) {
      assert.deepEqual(await build({ answer: error }).service.check('gw-1'), {
        verdict: 'NOT_ANSWERED',
        code: null,
        httpStatus: null,
        failure: 'NETWORK',
      });
    }
  });

  it('refuses a gateway that does not exist, and a gateway that is not Antilopay', async () => {
    await assert.rejects(build({ missing: true }).service.check('nope'), NotFoundException);
    const other = build({ type: PaymentGatewayType.PLATEGA });
    await assert.rejects(other.service.check('gw-1'), (error: unknown) => {
      assert.equal(error instanceof BadRequestException, true);
      assert.equal((error as BadRequestException).message, 'PAYMENT_GATEWAY_KEY_CHECK_UNSUPPORTED');
      return true;
    });
    assert.equal(other.calls.length, 0);
  });
});
