import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FaqMediaUploadService } from '../src/modules/faq/services/faq-media-upload.service';
import { FaqService } from '../src/modules/faq/services/faq.service';

describe('FaqService media lifecycle', () => {
  it('removes detached local media only after the last FAQ reference is gone', async () => {
    const orphanUrl = '/uploads/faq/orphan.mp4';
    const sharedUrl = '/uploads/faq/shared.mp4';
    const externalUrl = 'https://cdn.example/guide.mp4';
    const existing = faqRecord([orphanUrl, sharedUrl, externalUrl]);
    const updated = faqRecord([]);
    const countedUrls: string[] = [];
    const removedUrls: string[] = [];
    const prisma = {
      faqItem: {
        findUnique: async () => existing,
        update: async () => updated,
        count: async (args: {
          readonly where: { readonly mediaUrls: { readonly has: string } };
        }) => {
          const url = args.where.mediaUrls.has;
          countedUrls.push(url);
          return url === sharedUrl ? 1 : 0;
        },
      },
    };
    const service = createService(prisma, {
      isManagedUrl: (url: string) => url.startsWith('/uploads/faq/'),
      remove: async (url: string) => {
        removedUrls.push(url);
      },
    });

    await service.update(existing.id, { mediaUrls: [] });

    assert.deepStrictEqual(new Set(countedUrls), new Set([orphanUrl, sharedUrl]));
    assert.deepStrictEqual(removedUrls, [orphanUrl]);
  });

  it('reaps unreferenced local media after deleting its FAQ item', async () => {
    const deletedUrl = '/uploads/faq/deleted.png';
    const removedUrls: string[] = [];
    let deleteCalled = false;
    const prisma = {
      faqItem: {
        findUnique: async () => faqRecord([deletedUrl]),
        delete: async () => {
          deleteCalled = true;
        },
        count: async () => {
          assert.equal(deleteCalled, true, 'reference check must happen after the row is deleted');
          return 0;
        },
      },
    };
    const service = createService(prisma, {
      isManagedUrl: () => true,
      remove: async (url: string) => {
        removedUrls.push(url);
      },
    });

    await service.delete('faq-1');

    assert.equal(deleteCalled, true);
    assert.deepStrictEqual(removedUrls, [deletedUrl]);
  });

  it('keeps successful FAQ writes successful when best-effort cleanup fails', async () => {
    const countFailureUrl = '/uploads/faq/count-failure.png';
    const unlinkFailureUrl = '/uploads/faq/unlink-failure.png';
    const existing = faqRecord([countFailureUrl, unlinkFailureUrl]);
    const prisma = {
      faqItem: {
        findUnique: async () => existing,
        update: async () => faqRecord([]),
        count: async (args: {
          readonly where: { readonly mediaUrls: { readonly has: string } };
        }) => {
          if (args.where.mediaUrls.has === countFailureUrl) throw new Error('database unavailable');
          return 0;
        },
      },
    };
    const service = createService(prisma, {
      isManagedUrl: () => true,
      remove: async () => {
        throw new Error('filesystem unavailable');
      },
    });

    const result = await service.update(existing.id, { mediaUrls: [] });

    assert.deepStrictEqual(result.mediaUrls, []);
  });
});

function createService(
  prisma: unknown,
  uploadService: Pick<FaqMediaUploadService, 'isManagedUrl' | 'remove'>,
): FaqService {
  return new FaqService(prisma as never, uploadService as FaqMediaUploadService);
}

function faqRecord(mediaUrls: readonly string[]): {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly mediaUrls: string[];
  readonly orderIndex: number;
  readonly isActive: boolean;
  readonly locale: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
} {
  return {
    id: 'faq-1',
    question: 'Question',
    answer: 'Answer',
    mediaUrls: [...mediaUrls],
    orderIndex: 0,
    isActive: true,
    locale: 'ru',
    createdAt: new Date('2026-07-29T12:00:00.000Z'),
    updatedAt: new Date('2026-07-29T12:00:00.000Z'),
  };
}
