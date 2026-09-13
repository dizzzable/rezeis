import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

import type { PanelCommand } from '../src/modules/remnawave/services/panel-command.contract';
import {
  PanelCommandExecutor,
  type PanelTransport,
  type PanelTransportResult,
} from '../src/modules/remnawave/services/panel-command.executor';
import { PANEL_COMMANDS } from '../src/modules/remnawave/services/panel-commands';

/**
 * The executor, driven by the hand-owned command table
 * ═════════════════════════════════════════════════════
 * These tests hand the executor the SAME command objects production does —
 * the entries of `panel-commands.ts`, which `panel-command-conformance.spec.ts`
 * holds to every era's contract. A spec built on objects invented here would
 * prove only that the executor matches a shape this file made up.
 *
 * The most important case is not a happy path. It is the one where the executor
 * refuses a request WE built: the panel-update body keyed `{ uuid }`. Remnawave
 * 3.x has no user uuid at all, so that body is a guaranteed `400`, which the
 * sync layer files as terminal and never retries. It never leaves the process,
 * and the refusal quotes the panel's own wording.
 */
Logger.overrideLogger(false);

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
  it('reads PATCH and /api/users/ off the update command rather than being told', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    await executor.call(PANEL_COMMANDS.UpdateUserCommand, { body: { id: 4471 } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'patch');
    assert.equal(calls[0]?.url, '/api/users/');
  });

  it('builds a parameterised path through the command’s own builder', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    await executor.call(PANEL_COMMANDS.GetUserByIdCommand, { pathParts: ['4471'] });

    assert.equal(calls[0]?.method, 'get');
    assert.equal(calls[0]?.url, '/api/users/4471');
  });

  it('refuses to guess when a command declares a method it does not know', async () => {
    const { transport } = stubTransport({ kind: 'ok', data: {} });
    const executor = new PanelCommandExecutor(transport);
    const broken = {
      url: '/api/users/',
      method: 'TELEPORT',
      description: 'not a real command',
    } as unknown as PanelCommand;

    // Defaulting to `get` here would turn a write into a read and report
    // success. A command we cannot read is a stop, not a guess.
    await assert.rejects(() => executor.call(broken), /unusable method/);
  });

  it('refuses a builder route called with the wrong number of segments', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: {} });
    const executor = new PanelCommandExecutor(transport);

    // `/api/users/undefined` addresses nobody, and a 404 from it reads to the
    // caller as "the profile is gone".
    await assert.rejects(
      () => executor.call(PANEL_COMMANDS.GetUserByIdCommand, { pathParts: [] }),
      /takes one parameter but 0 were supplied/,
    );
    assert.deepStrictEqual(calls, []);
  });
});

describe('a body we built wrong never reaches the panel', () => {
  it('refuses the { uuid } update key that 3.x has no field for', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: {} });
    const executor = new PanelCommandExecutor(transport);

    const outcome = await executor.call(PANEL_COMMANDS.UpdateUserCommand, {
      body: { uuid: '11111111-1111-4111-8111-111111111111' },
    });

    assert.equal(outcome.kind, 'invalid-request');
    // The panel's own message, restated by the table and checked against every
    // era by the conformance spec.
    assert.match(
      outcome.kind === 'invalid-request' ? outcome.detail : '',
      /At least one of username, id must be provided/,
    );
    assert.equal(
      outcome.kind === 'invalid-request' ? outcome.command : '',
      'PATCH /api/users/ (Update a user)',
    );
    // And the whole point: nothing was sent. A 400 here would have been filed
    // as terminal and the subscription would have stopped converging.
    assert.deepStrictEqual(calls, []);
  });

  it('accepts the identities the table does declare', async () => {
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    for (const body of [{ id: 4471 }, { username: 'rz_sub_1' }]) {
      const outcome = await executor.call(PANEL_COMMANDS.UpdateUserCommand, { body });
      assert.equal(outcome.kind, 'ok', JSON.stringify(body));
    }
    assert.equal(calls.length, 2);
  });

  it('does not repeat the rejected payload into the refusal', async () => {
    const { transport } = stubTransport({ kind: 'ok', data: {} });
    const executor = new PanelCommandExecutor(transport);

    const outcome = await executor.call(PANEL_COMMANDS.UpdateUserCommand, {
      body: { uuid: 'x', email: 'customer@example.test', telegramId: 813364774 },
    });

    // A zod issue can carry `received`, and on this integration that is
    // customer data. The detail names the field and the rule, never the value.
    const detail = outcome.kind === 'invalid-request' ? outcome.detail : '';
    assert.notEqual(detail, '');
    assert.equal(detail.includes('customer@example.test'), false);
    assert.equal(detail.includes('813364774'), false);
  });
});

describe('what the table accepted is what goes on the wire', () => {
  it('applies the create defaults the caller did not spell out', async () => {
    // The caller omits `status` and `trafficLimitStrategy`; the table carries
    // the vendor's defaults for both, and the executor sends the PARSED body.
    // `panel-wire-bytes.spec.ts` pins the resulting bytes at every call site.
    const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
    const executor = new PanelCommandExecutor(transport);

    await executor.call(PANEL_COMMANDS.CreateUserCommand, {
      body: { expireAt: '2099-01-02T03:04:05.006Z', username: 'rz_sub_1', hwidDeviceLimit: 3 },
    });

    const sent = calls[0]?.body as Record<string, unknown>;
    assert.equal(sent['status'], 'ACTIVE');
    assert.equal(sent['trafficLimitStrategy'], 'NO_RESET');
    // The schema's key order, not the caller's.
    assert.deepStrictEqual(Object.keys(sent), [
      'username',
      'status',
      'trafficLimitStrategy',
      'expireAt',
      'hwidDeviceLimit',
    ]);
    // …and the schema's transform: axios renders this `Date` back through
    // `toJSON`, which is how `expireAt` has always reached the panel.
    assert.ok(sent['expireAt'] instanceof Date);
    assert.equal((sent['expireAt'] as Date).toISOString(), '2099-01-02T03:04:05.006Z');
  });

  it('drops a field the table does not declare rather than sending it, and says so', async () => {
    const warnings: string[] = [];
    const originalWarn = Logger.prototype.warn;
    Logger.prototype.warn = function patched(message: unknown): void {
      warnings.push(String(message));
    } as typeof Logger.prototype.warn;
    try {
      const { transport, calls } = stubTransport({ kind: 'ok', data: { response: {} } });
      const executor = new PanelCommandExecutor(transport);

      await executor.call(PANEL_COMMANDS.UpdateUserCommand, {
        body: { id: 4471, description: 'ok', bogusField: 'x' },
      });

      assert.deepStrictEqual(calls[0]?.body, { id: 4471, description: 'ok' });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /does not declare bogusField/);
    } finally {
      Logger.prototype.warn = originalWarn;
    }
  });
});

describe('a response is handed back exactly as the panel sent it', () => {
  it('runs no schema over a real captured 3.3.2 answer', async () => {
    // The executor used to parse this with a pinned vendor contract, turning
    // `expireAt` into a `Date` and stripping undeclared keys. Now the bytes the
    // panel sent are the bytes the caller reads.
    const realAnswer = JSON.parse(readFileSync('test/fixtures/remnawave/3.3.2/user.json', 'utf8')) as {
      response: Record<string, unknown>;
    };
    const withExtra: { response: Record<string, unknown> } = {
      response: { ...realAnswer.response, fieldFromALaterRelease: { any: 1 } },
    };
    const { transport } = stubTransport({ kind: 'ok', data: withExtra });
    const executor = new PanelCommandExecutor(transport);

    const outcome = await executor.call(PANEL_COMMANDS.GetUserByIdCommand, { pathParts: ['7'] });

    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.kind === 'ok' ? outcome.data : null, withExtra);
    assert.equal(typeof withExtra.response['expireAt'], 'string');
  });

  it('hands back a body no release describes without failing the call', async () => {
    const { transport } = stubTransport({ kind: 'ok', data: { unexpected: 'shape' } });
    const executor = new PanelCommandExecutor(transport);

    const outcome = await executor.call(PANEL_COMMANDS.GetUserByIdCommand, { pathParts: ['4471'] });

    // Judging it is the reader's job — see the envelope guards in the clients.
    assert.deepStrictEqual(outcome, { kind: 'ok', data: { unexpected: 'shape' } });
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

    const outcome = await executor.call(PANEL_COMMANDS.GetUserByIdCommand, { pathParts: ['4471'] });

    // Not turned into an empty ok. The caller decides what a 404 means for its
    // own operation.
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' ? outcome.code : null, 'A025');
  });
});
