import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminSupportTicketsController } from '../src/modules/support-tickets/controllers/admin-support-tickets.controller';

/**
 * The joint between the switch and the erasure
 * ════════════════════════════════════════════
 * Two halves of this feature were each tested and the SEAM between them was
 * not: `support-settings-merge` proves the operator's choice survives into
 * `toSupportLimits`, `support-attachment-purge` proves the erasure does what
 * it says. Nothing constructed this controller and closed a ticket — so
 * deleting the `if (limits.purgeAttachmentsOnClose)` branch left every test in
 * the suite green with the feature entirely gone.
 *
 * That is not hypothetical here. This same patch shipped, at one point, a
 * merge that silently dropped the switch and a Prisma `select` that silently
 * dropped `purgedAt` — both invisible for exactly this reason: every piece was
 * covered and no test walked the path a person walks.
 *
 * So this is the path: press Close, and assert what happens to the files.
 */

interface Recorded {
  readonly closed: string[];
  readonly purged: string[];
  readonly audits: Array<{ action: string; metadata: Record<string, unknown> }>;
}

function build(opts: {
  readonly purgeOnClose: boolean;
  /** Make the settings read throw, as a database hiccup would. */
  readonly settingsThrows?: boolean;
  /** Make the purge itself throw. */
  readonly purgeThrows?: boolean;
  readonly purgedCount?: number;
}) {
  const calls: Recorded = { closed: [], purged: [], audits: [] };

  const supportTicketsService = {
    close: async (input: { ticketId: string }) => {
      calls.closed.push(input.ticketId);
    },
    getById: async (ticketId: string) => ({
      id: ticketId,
      subject: 's',
      status: 'CLOSED',
      channel: 'WEB',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      docRequests: [],
      guest: null,
      user: null,
    }),
  };

  const supportAttachments = {
    purgeForTicket: async (ticketId: string) => {
      if (opts.purgeThrows === true) throw new Error('disk is on fire');
      calls.purged.push(ticketId);
      return { purged: opts.purgedCount ?? 2, freedBytes: 4096 };
    },
  };

  const settingsService = {
    getSupportLimits: async () => {
      if (opts.settingsThrows === true) throw new Error('settings unreachable');
      return {
        enabled: true,
        guestTokenTtlHours: 48,
        attachmentMaxBytes: 1024,
        attachmentMaxPerMsg: 3,
        purgeAttachmentsOnClose: opts.purgeOnClose,
      };
    },
  };

  const prismaService = {
    adminAuditLog: {
      create: async (args: { data: { action: string; metadata: Record<string, unknown> } }) => {
        calls.audits.push({ action: args.data.action, metadata: args.data.metadata });
        return {};
      },
    },
  };

  const controller = new AdminSupportTicketsController(
    supportTicketsService as never,
    {} as never,
    { notifyTicketOwner: () => undefined } as never,
    supportAttachments as never,
    prismaService as never,
    {} as never,
    settingsService as never,
  );
  return { controller, calls };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', rbacRoleId: null } as never;
const REQ = { headers: {}, socket: {} } as never;

describe('closing a ticket, and what happens to its files', () => {
  it('erases them when the operator asked for that', async () => {
    const { controller, calls } = build({ purgeOnClose: true });
    await controller.close('t-1', ADMIN, REQ);
    assert.deepEqual(calls.closed, ['t-1']);
    assert.deepEqual(calls.purged, ['t-1'], 'the switch is on and nothing was reclaimed');
  });

  it('leaves them alone when it is off', async () => {
    // THE default, and the one that must not drift: an install that upgrades
    // into this version never agreed to have its customers' files deleted.
    const { controller, calls } = build({ purgeOnClose: false });
    await controller.close('t-1', ADMIN, REQ);
    assert.deepEqual(calls.closed, ['t-1']);
    assert.deepEqual(calls.purged, [], 'files were erased without anyone asking');
  });

  it('writes down what it destroyed', async () => {
    // Bytes that are gone leave no other trace. The audit row is the only
    // record that they existed and who ended them.
    const { controller, calls } = build({ purgeOnClose: true });
    await controller.close('t-1', ADMIN, REQ);
    const purgeAudit = calls.audits.find((a) => a.action === 'support_ticket.attachments_purged');
    assert.ok(purgeAudit, 'a purge with no audit row');
    assert.equal(purgeAudit.metadata.purged, 2);
    assert.equal(purgeAudit.metadata.reason, 'on-close');
  });

  it('says nothing when there was nothing to erase', async () => {
    const { controller, calls } = build({ purgeOnClose: true, purgedCount: 0 });
    await controller.close('t-1', ADMIN, REQ);
    assert.equal(
      calls.audits.filter((a) => a.action === 'support_ticket.attachments_purged').length,
      0,
      'an empty purge must not write an audit row claiming one happened',
    );
  });

  it('still closes the ticket when the purge fails', async () => {
    // The close is already committed. Answering 500 for it would leave the
    // operator pressing Close again on a thread that is already closed.
    const { controller, calls } = build({ purgeOnClose: true, purgeThrows: true });
    await controller.close('t-1', ADMIN, REQ);
    assert.deepEqual(calls.closed, ['t-1']);
  });

  it('still closes the ticket when the settings read fails', async () => {
    // The read reaches the database too, and it sat outside the guard once.
    const { controller, calls } = build({ purgeOnClose: true, settingsThrows: true });
    await controller.close('t-1', ADMIN, REQ);
    assert.deepEqual(calls.closed, ['t-1']);
    assert.deepEqual(calls.purged, []);
  });
});
