import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminSupportTicketsController } from '../src/modules/support-tickets/controllers/admin-support-tickets.controller';

/**
 * The operator's decision to silence one device
 * ═════════════════════════════════════════════
 *
 * A device match on a guest conversation MARKS it and never refuses it: guest
 * support is where a ban is appealed, and refusing on a match would make a
 * wrong ban unappealable.
 *
 * The refusal exists anyway, because one determined pest can fill the queue
 * everybody else's real problems arrive in. It costs an operator reading one
 * conversation and deciding — this endpoint is that decision, and everything
 * below is about the ways it could go wrong.
 */

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, socket: {} } as never;

function build(options: {
  readonly guest?: Record<string, unknown> | null;
  readonly addResult?: { added: unknown[]; duplicates: string[]; rejected: unknown[] };
} = {}) {
  const added: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const supportTicketsService = {
    getById: async () => ({
      id: 't-1',
      status: 'OPEN',
      channel: 'WEB',
      guest:
        options.guest === undefined
          ? { id: 'g-1', installId: 'a1b2c3d4e5f6a7b8', deviceHash: 'ffffffffffffffff' }
          : options.guest,
    }),
  };

  const blockedIdentityService = {
    addMany: async (input: Record<string, unknown>) => {
      added.push(input);
      return options.addResult ?? { added: [{ id: 'b-1' }, { id: 'b-2' }], duplicates: [], rejected: [] };
    },
  };

  const prismaService = {
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return args.data;
      },
    },
  };

  // Order matters and is easy to get wrong: prisma is the FIFTH parameter, not
  // the third. A misplaced stub here fails with "cannot read 'create' of
  // undefined" from inside the audit write, which reads like a bug in the
  // controller rather than in the harness.
  const controller = new AdminSupportTicketsController(
    supportTicketsService as never,
    blockedIdentityService as never,
    {} as never,
    {} as never,
    prismaService as never,
    {} as never,
    {} as never,
  );
  return { controller, added, audits };
}

describe('silencing a guest device', () => {
  it('lists BOTH signals as a manual entry', async () => {
    // `manual` is the whole point. Cascade rows — the ones every block writes
    // automatically — only mark; if this wrote one of those, the entry would
    // refuse nothing and the operator's decision would evaporate.
    const { controller, added } = build();

    await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(added.length, 1);
    assert.equal(added[0].source, 'manual');
    assert.equal(added[0].kind, 'DEVICE_FP');
    assert.deepStrictEqual(added[0].values, ['a1b2c3d4e5f6a7b8', 'ffffffffffffffff']);
  });

  it('names the ticket in the reason, so the entry can be traced back', async () => {
    const { controller, added } = build();

    await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.match(String(added[0].reason), /t-1/);
  });

  it('records who did it, without copying the fingerprint into the log', async () => {
    // An audit row is read far more often than it is written, and a device
    // identifier sitting in one is a copy nobody asked for.
    const { controller, audits } = build();

    await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'support_ticket.device_silenced');
    const metadata = JSON.stringify(audits[0].metadata);
    assert.equal(metadata.includes('a1b2c3d4e5f6a7b8'), false);
    assert.match(metadata, /signalCount/);
  });

  it('counts an already-listed device as silenced', async () => {
    // A duplicate is the state the operator wanted. Reporting zero would read
    // as a failure and invite them to try again.
    const { controller } = build({
      addResult: { added: [], duplicates: ['a1b2c3d4e5f6a7b8'], rejected: [] },
    });

    const result = await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(result.silenced, 1);
  });
});

describe('when there is nothing to silence', () => {
  it('refuses a ticket with no guest conversation', async () => {
    const { controller, added } = build({ guest: null });

    await assert.rejects(() => controller.silenceDevice('t-1', ADMIN, REQ));
    assert.deepStrictEqual(added, []);
  });

  it('refuses when the visitor reported no device signal', async () => {
    // Ordinary and reachable: they blocked the signals, or the conversation
    // predates their collection. Saying so beats a success that silences
    // nothing and leaves the operator believing the pest is handled.
    const { controller, added } = build({
      guest: { id: 'g-1', installId: null, deviceHash: null },
    });

    await assert.rejects(() => controller.silenceDevice('t-1', ADMIN, REQ));
    assert.deepStrictEqual(added, []);
  });

  it('writes no audit row when it refused', async () => {
    const { controller, audits } = build({ guest: null });

    await assert.rejects(() => controller.silenceDevice('t-1', ADMIN, REQ));
    assert.deepStrictEqual(audits, []);
  });
});
