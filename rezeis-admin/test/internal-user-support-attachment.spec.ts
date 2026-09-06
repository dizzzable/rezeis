import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InternalUserSupportController } from '../src/modules/support-tickets/controllers/internal-user-support.controller';
import { AttachmentValidationError } from '../src/modules/support-tickets/utils/support-attachment.util';

/**
 * A signed-in customer attaching a file to their own ticket
 * ═════════════════════════════════════════════════════════
 * Every part of this existed except the route. The panel validates, sniffs
 * and stores the bytes; the ANONYMOUS guest conversation has had an upload
 * since attachments shipped; the cabinet already renders and streams them.
 * So a customer who had signed in could open an operator's files and send
 * none of their own.
 *
 * The visible cost was the document-request feature. An operator asks for a
 * receipt, the customer opens the ticket, and there is nothing to press — so
 * the ask went out and, in the operator's words, nobody ever managed to send
 * anything back.
 *
 * Two refusals matter more than the happy path:
 *
 *  - a write onto somebody ELSE'S thread must be impossible, not unlikely;
 *  - a CLOSED thread hides its composer in the cabinet, and a rule that lives
 *    only in a component is a suggestion.
 */

interface Recorded {
  readonly stored: Array<Record<string, unknown>>;
  readonly events: Array<{ type: string; metadata: Record<string, unknown> }>;
  /** Every `where` the ownership read was asked with. */
  readonly ticketQueries: Array<Record<string, unknown>>;
}

const TICKET = {
  id: 't-1',
  subject: 'Оплата',
  status: 'OPEN',
  createdAt: new Date('2026-09-06T10:00:00.000Z'),
  updatedAt: new Date('2026-09-06T10:00:00.000Z'),
  messages: [],
};

function build(opts: {
  /** The row `supportTicket.findFirst` returns; `null` = not the user's. */
  readonly owned?: { id: string; status: string } | null;
  /** Thrown by the store, to exercise the error mapping. */
  readonly storeThrows?: unknown;
} = {}) {
  const calls: Recorded = { stored: [], events: [], ticketQueries: [] };
  const prismaService = {
    user: { findFirst: async () => ({ id: 'u-1' }), findUnique: async () => ({ id: 'u-1' }) },
    supportTicket: {
      // The double HONOURS the `where`, and that is the whole point of it.
      // Answering the same row whatever it is asked makes the ownership clause
      // unobservable: delete `userId` from the query and every assertion here
      // still passes, while in production any signed-in customer can upload
      // into any ticket whose id they can guess. A `where` nobody asserts is a
      // `where` nobody is guarding.
      findFirst: async (args: { where: { id: string; userId?: string } }) => {
        calls.ticketQueries.push(args.where);
        const row = opts.owned === undefined ? { id: 't-1', status: 'OPEN' } : opts.owned;
        if (row === null) return null;
        if (args.where.id !== row.id) return null;
        // The ticket belongs to `u-1`. A query that does not ask whose it is
        // gets nothing, because that query is the defect.
        if (args.where.userId !== 'u-1') return null;
        return row;
      },
    },
  };
  const supportTicketsService = {
    getById: async () => TICKET,
  };
  const supportAttachments = {
    storeForMessage: async (input: Record<string, unknown>) => {
      if (opts.storeThrows !== undefined) throw opts.storeThrows;
      calls.stored.push(input);
      return { id: 'a-1', messageId: 'm-1', filename: 'x.png', mimeType: 'image/png', sizeBytes: 4 };
    },
  };
  const systemEvents = {
    info: (type: string, _c: string, _m: string, metadata: Record<string, unknown>) => {
      calls.events.push({ type, metadata });
    },
  };
  const controller = new InternalUserSupportController(
    prismaService as never,
    supportTicketsService as never,
    supportAttachments as never,
    systemEvents as never,
  );
  return { controller, calls };
}

const BODY = { filename: 'receipt.png', mimeType: 'image/png', dataBase64: 'AAAA' } as never;

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.constructor.name === 'NotFoundException';
}
function statusOf(err: unknown): number | null {
  const status = (err as { getStatus?: () => number })?.getStatus;
  return typeof status === 'function' ? status.call(err) : null;
}

describe('InternalUserSupportController.uploadAttachment', () => {
  it('stores the file as a message from the user', async () => {
    const { controller, calls } = build();
    await controller.uploadAttachment('42', 't-1', BODY);
    assert.equal(calls.stored.length, 1);
    assert.equal(calls.stored[0].authorType, 'USER');
    assert.equal(calls.stored[0].authorId, 'u-1');
    assert.equal(calls.stored[0].ticketId, 't-1');
  });

  it('passes the declared type through as advisory, not as truth', async () => {
    // The store re-sniffs the decoded bytes; this field only ever helps a
    // diagnosis. Naming that here so nobody later starts trusting it.
    const { controller, calls } = build();
    await controller.uploadAttachment('42', 't-1', BODY);
    assert.equal(calls.stored[0].declaredMime, 'image/png');
    assert.equal(calls.stored[0].dataBase64, 'AAAA');
  });

  it('refuses a ticket that is not this user’s', async () => {
    // THE case. The ownership read is what makes a write onto somebody else's
    // conversation impossible rather than merely unlikely.
    const { controller, calls } = build({ owned: null });
    await assert.rejects(() => controller.uploadAttachment('42', 't-1', BODY), isNotFound);
    assert.equal(calls.stored.length, 0);
  });

  it('asks whose ticket it is, not merely whether it exists', async () => {
    // The refusal above proves `null` becomes a 404. It does NOT prove the
    // query narrows by owner — a lookup by id alone returns the row just the
    // same, and the 404 never fires. So assert the clause itself.
    const { controller, calls } = build();
    await controller.uploadAttachment('42', 't-1', BODY);
    assert.equal(calls.ticketQueries.length, 1);
    assert.equal(calls.ticketQueries[0].userId, 'u-1');
    assert.equal(calls.ticketQueries[0].id, 't-1');
  });

  it('refuses a closed ticket', async () => {
    // The cabinet hides the composer on a closed thread; this is what makes
    // that a rule rather than a component's opinion.
    const { controller, calls } = build({ owned: { id: 't-1', status: 'CLOSED' } });
    await assert.rejects(() => controller.uploadAttachment('42', 't-1', BODY));
    assert.equal(calls.stored.length, 0);
  });

  it('answers 413 for a file over the limit', async () => {
    // The two refusals a person can act on. Collapsed into 500 they become
    // "something went wrong", which is how somebody gives up on sending it.
    const { controller } = build({
      storeThrows: new AttachmentValidationError('too-large'),
    });
    await assert.rejects(
      () => controller.uploadAttachment('42', 't-1', BODY),
      (err: unknown) => statusOf(err) === 413,
    );
  });

  it('answers 415 for a type that is not accepted', async () => {
    const { controller } = build({
      storeThrows: new AttachmentValidationError('type-not-allowed'),
    });
    await assert.rejects(
      () => controller.uploadAttachment('42', 't-1', BODY),
      (err: unknown) => statusOf(err) === 415,
    );
  });

  it('tells the operators a file arrived', async () => {
    // Without this the file lands in a thread nobody is looking at: the
    // operator's own notification for a user reply is what brings them back.
    const { controller, calls } = build();
    await controller.uploadAttachment('42', 't-1', BODY);
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].metadata.ticketId, 't-1');
  });
});
