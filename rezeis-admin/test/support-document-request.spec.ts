import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SupportTicketsService } from '../src/modules/support-tickets/services/support-tickets.service';

/**
 * Document requests (Phase 3). Verifies the lifecycle from the design:
 *  - creating a request inserts a SYSTEM message with doc-request metadata,
 *  - a USER reply fulfills the oldest PENDING request (PENDING→FULFILLED),
 *  - SYSTEM/ADMIN messages never fulfill.
 */

interface DocRow {
  id: string;
  ticketId: string;
  status: string;
  fulfilledMessageId: string | null;
  createdAt: number;
}

interface MsgRow {
  id: string;
  ticketId: string;
  authorType: string;
  content: string;
  metadata: unknown;
}

function build() {
  const docs: DocRow[] = [];
  const messages: MsgRow[] = [];
  let docSeq = 0;
  let msgSeq = 0;

  const prisma = {
    supportTicket: {
      findUnique: async () => ({ id: 'tkt1', status: 'OPEN' }),
      update: async () => ({}),
    },
    supportTicketMessage: {
      create: async ({ data }: { data: Omit<MsgRow, 'id'> }) => {
        const row: MsgRow = { id: `m-${++msgSeq}`, ...data };
        messages.push(row);
        return row;
      },
    },
    supportDocumentRequest: {
      create: async ({ data }: { data: { ticketId: string } }) => {
        const row: DocRow = {
          id: `doc-${++docSeq}`,
          ticketId: data.ticketId,
          status: 'PENDING',
          fulfilledMessageId: null,
          createdAt: docSeq,
        };
        docs.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: { ticketId: string; status: string } }) => {
        const found = docs
          .filter((d) => d.ticketId === where.ticketId && d.status === where.status)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        return found ? { id: found.id } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: string; fulfilledMessageId: string };
      }) => {
        const row = docs.find((d) => d.id === where.id);
        if (row) {
          row.status = data.status;
          row.fulfilledMessageId = data.fulfilledMessageId;
        }
        return row ?? {};
      },
    },
  };

  const service = new SupportTicketsService(prisma as never);
  return { service, docs, messages };
}

describe('SupportTicketsService document requests', () => {
  it('creates a PENDING request and inserts a SYSTEM message carrying its metadata', async () => {
    const { service, docs, messages } = build();
    const request = await service.createDocumentRequest({
      ticketId: 'tkt1',
      requestedBy: 'admin-1',
      kind: 'PAYMENT_PROOF',
      label: 'Please upload your payment receipt',
    });
    assert.equal(docs.length, 1);
    assert.equal(docs[0].status, 'PENDING');
    const sys = messages.find((m) => m.authorType === 'SYSTEM');
    assert.ok(sys);
    assert.equal(sys?.content, 'Please upload your payment receipt');
    const meta = sys?.metadata as { type: string; docRequestId: string; kind: string };
    assert.equal(meta.type, 'document_request');
    assert.equal(meta.docRequestId, request.id);
    assert.equal(meta.kind, 'PAYMENT_PROOF');
  });

  it('fulfills the oldest pending request on a USER reply', async () => {
    const { service, docs } = build();
    await service.createDocumentRequest({
      ticketId: 'tkt1',
      requestedBy: 'admin-1',
      kind: 'DOCUMENT',
      label: 'Send your ID',
    });
    const msg = await service.addMessage({
      ticketId: 'tkt1',
      authorType: 'USER',
      authorId: null,
      content: 'here it is',
    });
    assert.equal(docs[0].status, 'FULFILLED');
    assert.equal(docs[0].fulfilledMessageId, msg.id);
  });

  it('does not fulfill on a SYSTEM or ADMIN message', async () => {
    const { service, docs } = build();
    await service.createDocumentRequest({
      ticketId: 'tkt1',
      requestedBy: 'admin-1',
      kind: 'LOGIN',
      label: 'Provide your login',
    });
    // The SYSTEM message inserted above must not have fulfilled the request.
    assert.equal(docs[0].status, 'PENDING');
    await service.addMessage({
      ticketId: 'tkt1',
      authorType: 'ADMIN',
      authorId: 'admin-1',
      content: 'any update?',
    });
    assert.equal(docs[0].status, 'PENDING');
  });
});
