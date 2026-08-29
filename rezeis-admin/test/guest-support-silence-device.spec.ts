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
  readonly addResult?: {
    added: unknown[];
    promoted?: unknown[];
    duplicates: string[];
    rejected: unknown[];
  };
  /** The ticket is archived, so the archive permission decides. */
  readonly archived?: boolean;
  /** Whether this operator holds `support_tickets:archive`. */
  readonly mayReadArchived?: boolean;
} = {}) {
  const added: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const supportTicketsService = {
    isArchived: async () => options.archived === true,
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
      return (
        options.addResult ?? {
          added: [{ id: 'b-1' }, { id: 'b-2' }],
          promoted: [],
          duplicates: [],
          rejected: [],
        }
      );
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
    // RBAC is the SIXTH parameter. `assertArchivePermission` asks it directly,
    // so a `{}` here fails with "hasPermission is not a function" from inside
    // the archive gate — which reads like a controller bug rather than a
    // harness one.
    { hasPermission: async () => options.mayReadArchived !== false } as never,
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

  it('counts a device already silenced BY HAND as silenced', async () => {
    // A duplicate is the state the operator wanted — but only this kind of
    // duplicate. The row is already `manual`, so it already refuses.
    const { controller } = build({
      addResult: {
        added: [],
        promoted: [],
        duplicates: ['a1b2c3d4e5f6a7b8'],
        rejected: [],
      },
    });

    const result = await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(result.silenced, 1);
  });

  it('counts a promoted cascade row, which is the ordinary case', async () => {
    // ── The shape that made this button a guaranteed no-op ─────────────────
    //
    // The operator is usually silencing the device of somebody they already
    // blocked, and the block itself wrote those fingerprints as `cascade`. The
    // gate refuses on `manual` only, so the collision used to be reported as a
    // plain duplicate: the operator read `silenced: 2`, both rows stayed
    // `cascade`, and the device kept opening conversations for ever.
    //
    // A promotion is now its own outcome and counts here, because it is the one
    // that actually changed what the gate does.
    const { controller, audits } = build({
      addResult: {
        added: [],
        promoted: [{ id: 'b-1' }, { id: 'b-2' }],
        duplicates: [],
        rejected: [],
      },
    });

    const result = await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(result.silenced, 2);
    // Recorded apart from `added` in the audit: taking over a row a ban created
    // automatically is a different act from listing somebody new, and it is the
    // one worth being able to find later.
    assert.match(JSON.stringify(audits[0].metadata), /promoted/);
  });

  it('reports nothing silenced when every value was rejected', async () => {
    // The honest zero. A normaliser refusal is the only outcome that leaves no
    // row behind, and saying "silenced" for it would tell the operator the pest
    // is dealt with when nothing was written at all.
    const { controller } = build({
      addResult: {
        added: [],
        promoted: [],
        duplicates: [],
        rejected: [{ value: 'x', reason: 'BAD_CHARSET' }],
      },
    });

    const result = await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(result.silenced, 0);
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

describe('an archived conversation is gated the same way reading one is', () => {
  /**
   * This route calls the same `getById` that refuses an archived thread without
   * `support_tickets:archive`, and then reads the guest's fingerprints off the
   * result. Ungated, an operator denied a plain GET of an archived conversation
   * could still reach into it and write those fingerprints to the blocklist as
   * permanent rows that refuse that device for ever — the strongest thing this
   * controller can do, reachable through the one door nobody was watching.
   */
  it('refuses when the operator cannot read archived threads', async () => {
    const { controller, added } = build({ archived: true, mayReadArchived: false });

    await assert.rejects(
      () => controller.silenceDevice('t-1', ADMIN, REQ),
      /archive/i,
    );
    assert.deepStrictEqual(added, [], 'refused, but the blocklist was written anyway');
  });

  it('allows it when the operator does hold that permission', async () => {
    const { controller, added } = build({ archived: true, mayReadArchived: true });

    const result = await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(result.silenced, 2);
    assert.equal(added.length, 1);
  });

  it('does not consult the archive permission for a live thread', async () => {
    // The gate must not become a second permission on the ordinary path: an
    // operator with `resolve` and no `archive` silences open conversations all
    // day, and that is the case this button exists for.
    const { controller } = build({ archived: false, mayReadArchived: false });

    const result = await controller.silenceDevice('t-1', ADMIN, REQ);

    assert.equal(result.silenced, 2);
  });
});
