import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  GetUserByIdCommand,
  RevokeUserSubscriptionCommand,
  UpdateUserCommand,
} from '@remnawave/contract-v34';

import {
  PanelCommandExecutor,
  type PanelTransport,
  type PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';
import type { PanelCommand } from '../src/modules/remnawave/services/panel-command.contract';

/**
 * The executor, driven by the REAL contract
 * ═════════════════════════════════════════
 * These tests import `@remnawave/backend-contract` and hand its actual command
 * objects to the executor. That is the point: a spec built on hand-written
 * fakes would prove only that the executor matches the structural type this
 * repository invented, which is the very thing worth doubting. The value of
 * taking routes, verbs and schemas from the vendor is that they are the
 * vendor's — so the tests have to use the vendor's.
 *
 * The most important case here is not a happy path. It is the one where the
 * executor refuses a request WE built: the panel-update body keyed `{ uuid }`.
 * Remnawave 3.x has no user uuid at all, so that body is a guaranteed `400`,
 * which the sync layer files as terminal and never retries. Today it is sent.
 * With the contract in front of it, it never leaves the process, and the
 * refusal quotes the panel's own wording.
 */

/** Records what the transport was asked to do, and answers as instructed. */
function stubTransport(answer: PanelTransportResult): {
  transport: PanelTransport;
  calls: Array<{ method: string; url: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  return {
    calls,
    transport: {
      send: async (input) => {
        calls.push({ method: input.method, url: input.url, body: input.body });
        return answer;
      },
    },
  };
}

describe('the executor takes the verb and the path from the command', () => {
  it('reads PATCH and /api/users/ off UpdateUserCommand rather than being told', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    await executor.call(UpdateUserCommand as unknown as PanelCommand, { body: { id: 4471 } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'patch');
    assert.equal(calls[0]?.url, '/api/users/');
  });

  it('builds a parameterised path through the contract’s own builder', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    await executor.call(GetUserByIdCommand as unknown as PanelCommand, { pathParts: ['4471'] });

    assert.equal(calls[0]?.method, 'get');
    // Not a template literal written here — the vendor's builder produced it.
    assert.equal(calls[0]?.url, '/api/users/4471');
  });

  it('refuses to guess when the command declares a method it does not know', async () => {
    const { transport } = stubTransport({ kind: 'ok', data: {} });
    const executor = new PanelCommandExecutor(transport);
    const broken = {
      url: '/api/users/',
      endpointDetails: { REQUEST_METHOD: 'TELEPORT' },
    } as unknown as PanelCommand;

    // Defaulting to `get` here would turn a write into a read and report
    // success. A contract we cannot read is a stop, not a guess.
    await assert.rejects(() => executor.call(broken), /unusable REQUEST_METHOD/);
  });
});

describe('a body we built wrong never reaches the panel', () => {
  it('refuses the { uuid } update key that 3.x has no field for', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: {} });
    const executor = new PanelCommandExecutor(transport);

    const outcome = await executor.call(UpdateUserCommand as unknown as PanelCommand, {
      body: { uuid: '11111111-1111-4111-8111-111111111111' },
    });

    assert.equal(outcome.kind, 'invalid-request');
    // The contract's own message, which is also the panel's.
    assert.match(
      outcome.kind === 'invalid-request' ? outcome.detail : '',
      /At least one of username, id must be provided/,
    );
    // And the whole point: nothing was sent. A 400 here would have been filed
    // as terminal and the subscription would have stopped converging.
    assert.deepStrictEqual(calls, []);
  });

  it('accepts the keys the contract does declare', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    for (const body of [{ id: 4471 }, { username: 'rz_sub_1' }]) {
      const outcome = await executor.call(UpdateUserCommand as unknown as PanelCommand, { body });
      assert.equal(outcome.kind, 'ok', JSON.stringify(body));
    }
    assert.equal(calls.length, 2);
  });

  it('does not repeat the rejected payload into the log line', async () => {
    const { transport } = stubTransport({ kind: 'ok', data: {} });
    const executor = new PanelCommandExecutor(transport);

    const outcome = await executor.call(UpdateUserCommand as unknown as PanelCommand, {
      body: { uuid: 'x', email: 'customer@example.test', telegramId: 813364774 },
    });

    // A zod issue can carry `received`, and on this integration that is
    // customer data. The detail names the field and the rule, never the value.
    const detail = outcome.kind === 'invalid-request' ? outcome.detail : '';
    assert.equal(detail.includes('customer@example.test'), false);
    assert.equal(detail.includes('813364774'), false);
  });
});

describe('what the contract accepted is what goes on the wire', () => {
  it('applies a schema default the caller did not spell out', async () => {
    // `RevokeUserSubscriptionCommand`'s body is a zod `preprocess` with a
    // default. Validating the caller's object and then sending the caller's
    // object — which is what this did at first — meant the default was
    // computed and thrown away, so the panel received a body missing a field
    // the contract says it always carries.
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    await executor.call(RevokeUserSubscriptionCommand as unknown as PanelCommand, {
      pathParts: ['4471'],
      body: {},
    });

    assert.deepStrictEqual(calls[0]?.body, { revokeOnlyPasswords: false });
  });

  it('strips a field the contract does not declare rather than sending it', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    await executor.call(UpdateUserCommand as unknown as PanelCommand, {
      body: { id: 4471, description: 'ok', bogusField: 'x' },
    });

    // The contract is the authority on what the panel accepts. Enforcement
    // that only reads and never rewrites is advisory, and advisory validation
    // reads as a guarantee it does not give.
    assert.deepStrictEqual(calls[0]?.body, { id: 4471, description: 'ok' });
  });
});

describe('a response we did not expect is drift, not failure', () => {
  it('hands back a body the pinned schema rejects, and says so', async () => {
    // The lesson `panel-response-decoders.ts` records: a vendor schema run
    // against a live panel of a different minor took a whole feature down.
    // The contract is pinned to one panel minor while the fleet runs several.
    const drifts: string[] = [];
    const { transport } = stubTransport({ kind: 'ok', data: { unexpected: 'shape' } });
    const executor = new PanelCommandExecutor(transport, (report) => drifts.push(report.url));

    const outcome = await executor.call(GetUserByIdCommand as unknown as PanelCommand, {
      pathParts: ['4471'],
    });

    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' ? outcome.drifted : null, true);
    assert.deepStrictEqual(outcome.kind === 'ok' ? outcome.data : null, { unexpected: 'shape' });
    // Lenient is not silent.
    assert.deepStrictEqual(drifts, ['/api/users/4471']);
  });

  it('reports no drift on a REAL captured 3.3.2 panel answer', async () => {
    // Not a hand-built object: the fixture is a response captured from a live
    // panel 3.3.2. It validating cleanly against the contract pinned at 3.4.2
    // is the practical confirmation of the version mapping — contract 3.4.x
    // belongs to panel 3.3.x, which the numbers themselves do not suggest.
    const realAnswer = JSON.parse(
      readFileSync('test/fixtures/remnawave/3.3.2/user.json', 'utf8'),
    ) as unknown;
    const drifts: string[] = [];
    const { transport } = stubTransport({ kind: 'ok', data: realAnswer });
    const executor = new PanelCommandExecutor(transport, (report) => drifts.push(report.url));

    const outcome = await executor.call(UpdateUserCommand as unknown as PanelCommand, {
      body: { id: 4471 },
    });

    // Guards the guard: if every response were reported as drift, the flag
    // would carry no information and the log would be noise.
    assert.equal(outcome.kind === 'ok' ? outcome.drifted : null, false);
    assert.deepStrictEqual(drifts, []);
  });

  it('passes a transport failure through untouched', async () => {
    const { transport } = stubTransport({
      kind: 'rejected',
      status: 404,
      code: 'A025',
      detail: 'User not found',
      retryAfterMs: null,
    });
    const executor = new PanelCommandExecutor(transport);

    const outcome = await executor.call(GetUserByIdCommand as unknown as PanelCommand, {
      pathParts: ['4471'],
    });

    // Not turned into a drift, not turned into an empty ok. The caller decides
    // what a 404 means for its own operation.
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' ? outcome.code : null, 'A025');
  });
});
