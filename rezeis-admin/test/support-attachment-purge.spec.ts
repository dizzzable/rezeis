import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import { describe, it } from 'node:test';

import { SupportAttachmentService } from '../src/modules/support-tickets/services/support-attachment.service';

/**
 * Reclaiming the disk a ticket's files sit on
 * ═══════════════════════════════════════════
 * An operator asked for this by the storage: conversations accumulate
 * screenshots and receipts, and a closed ticket's files are dead weight.
 *
 * ── Why the ROWS survive ─────────────────────────────────────────────────
 *
 * Deleting the rows too would be simpler and worse. A chip that disappears
 * from a conversation reads as a bug, and the facts worth keeping — what was
 * sent, by whom, when, how large — cost nothing to keep. `purgedAt` is what
 * lets both surfaces say «файл удалён» rather than render a link that answers
 * 404. The disk, which is the entire point, is freed either way.
 *
 * ── The two things that must not go wrong ────────────────────────────────
 *
 *  1. a row is stamped ONLY when its file actually went. Stamping first and
 *     unlinking after would leave the thread claiming a file is gone while
 *     the bytes stay on disk — the opposite of the feature;
 *  2. a purged attachment never streams again. The row keeps its stored name,
 *     and a stream that fell through to the path would answer with whatever
 *     happens to be written there next.
 */

interface Recorded {
  readonly unlinked: string[];
  readonly stamped: Array<readonly string[]>;
  readonly rmdir: string[];
  /** Every `where` the purge and the stream were asked with. */
  readonly queries: Array<Record<string, unknown>>;
}

/** One row on ticket `t-1`, purged already — the stream must never find it. */
const PURGED_ROW = { id: 'a-9', storedName: 'cccc.png', sizeBytes: 10, purgedAt: new Date() };

function buildService(opts: {
  readonly attachments: Array<{ id: string; storedName: string; sizeBytes: number }>;
  /** Stored names whose unlink throws. */
  readonly failing?: readonly string[];
}) {
  const calls: Recorded = { unlinked: [], stamped: [], rmdir: [], queries: [] };
  const prisma = {
    supportAttachment: {
      // The double HONOURS the `where`. Answering the same rows whatever it is
      // asked makes the scoping unobservable, and the scoping is the whole
      // safety of this operation: widen `where` to `{}` and the purge stamps
      // EVERY unpurged attachment in the database — `fs.rm({force:true})` does
      // not throw on a path that is not there, so every one of them is counted
      // as freed — while the bytes of other tickets stay on disk and their
      // threads start claiming the files were deleted.
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.queries.push(args.where);
        const scope = args.where['message'] as { ticketId?: string } | undefined;
        if (scope?.ticketId !== 't-1') return [];
        if (args.where['purgedAt'] !== null) return [...opts.attachments, PURGED_ROW];
        return opts.attachments;
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        calls.queries.push(args.where);
        return null;
      },
      updateMany: async (args: { where: { id: { in: string[] } } }) => {
        calls.stamped.push(args.where.id.in);
        return { count: args.where.id.in.length };
      },
    },
  };
  const service = new SupportAttachmentService(prisma as never, {} as never, {} as never);
  // The disk is the part under test, and the service reaches it through this
  // very object — `promises` is a live namespace, so replacing a method here
  // is what the service will call.
  const fsModule = fsPromises as unknown as { rm: unknown; rmdir: unknown };
  const realRm = fsModule.rm;
  const realRmdir = fsModule.rmdir;
  fsModule.rm = async (target: string) => {
    const name = target.split(/[\\/]/).pop() ?? '';
    if ((opts.failing ?? []).includes(name)) throw new Error('EACCES');
    calls.unlinked.push(name);
  };
  fsModule.rmdir = async (target: string) => {
    calls.rmdir.push(target);
  };
  const restore = (): void => {
    fsModule.rm = realRm;
    fsModule.rmdir = realRmdir;
  };
  return { service, calls, restore };
}

const FILES = [
  { id: 'a-1', storedName: 'aaaa.png', sizeBytes: 1_000 },
  { id: 'a-2', storedName: 'bbbb.pdf', sizeBytes: 2_500 },
];

describe('SupportAttachmentService.purgeForTicket', () => {
  it('removes the bytes and reports what was freed', async () => {
    const { service, calls, restore } = buildService({ attachments: FILES });
    try {
      const result = await service.purgeForTicket('t-1');
      assert.equal(result.purged, 2);
      assert.equal(result.freedBytes, 3_500);
      assert.deepEqual(calls.unlinked.sort(), ['aaaa.png', 'bbbb.pdf']);
    } finally {
      restore();
    }
  });

  it('stamps exactly the rows whose file went', async () => {
    const { service, calls, restore } = buildService({ attachments: FILES });
    try {
      await service.purgeForTicket('t-1');
      assert.equal(calls.stamped.length, 1);
      assert.deepEqual([...calls.stamped[0]].sort(), ['a-1', 'a-2']);
    } finally {
      restore();
    }
  });

  it('leaves a row alone when its file could not be removed', async () => {
    // THE case. A stamped row says "gone" to both surfaces; saying that over
    // bytes still on disk turns a storage feature into a lie about storage.
    const { service, calls, restore } = buildService({
      attachments: FILES,
      failing: ['bbbb.pdf'],
    });
    try {
      const result = await service.purgeForTicket('t-1');
      assert.equal(result.purged, 1);
      assert.equal(result.freedBytes, 1_000);
      assert.deepEqual(calls.stamped[0], ['a-1']);
    } finally {
      restore();
    }
  });

  it('carries on past a failure instead of abandoning the rest', async () => {
    const { service, calls, restore } = buildService({
      attachments: FILES,
      failing: ['aaaa.png'],
    });
    try {
      await service.purgeForTicket('t-1');
      assert.deepEqual(calls.unlinked, ['bbbb.pdf']);
    } finally {
      restore();
    }
  });

  it('does nothing at all when there is nothing left to purge', async () => {
    // Idempotent: the query already excludes stamped rows, so a second press
    // unlinks nothing and stamps nothing.
    const { service, calls, restore } = buildService({ attachments: [] });
    try {
      const result = await service.purgeForTicket('t-1');
      assert.deepEqual(result, { purged: 0, freedBytes: 0 });
      assert.deepEqual(calls.unlinked, []);
      assert.deepEqual(calls.stamped, []);
      assert.deepEqual(calls.rmdir, [], 'an empty purge must not touch the directory either');
    } finally {
      restore();
    }
  });

  it('does not drop the ticket directory wholesale', async () => {
    // `rmdir` refuses a non-empty directory, and that refusal is the point:
    // anything still there belongs to a row this purge did not touch.
    const { service, calls, restore } = buildService({ attachments: FILES });
    try {
      await service.purgeForTicket('t-1');
      assert.equal(calls.rmdir.length, 1);
      assert.ok(calls.rmdir[0].includes('t-1'), calls.rmdir[0]);
    } finally {
      restore();
    }
  });
});

describe('a purged attachment never streams again', () => {
  it('asks for it by ticket AND by not-yet-purged', () => {
    // Named as must-not-go-wrong #2 at the top of this file and guarded by
    // nothing until now. `purgedAt: null` belongs INSIDE the lookup: a purged
    // row keeps its stored name, so a stream that fell through to the path
    // would serve whatever happens to be written there next — and a lookup
    // scoped only by id would hand a customer another ticket's file.
    const { service, calls, restore } = buildService({ attachments: [] });
    try {
      void service.streamForTicket('t-1', 'a-9');
      const where = calls.queries[calls.queries.length - 1] ?? {};
      assert.equal(where['purgedAt'], null, 'a purged row must not be findable by the stream');
      assert.equal(where['id'], 'a-9');
      assert.deepEqual(where['message'], { ticketId: 't-1' });
    } finally {
      restore();
    }
  });
});
