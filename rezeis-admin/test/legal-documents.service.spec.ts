import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { LegalDocumentKey } from '@prisma/client';

import { LegalDocumentsService } from '../src/modules/legal-documents/services/legal-documents.service';

/**
 * Legal documents: the operator-facing rules.
 *
 * Two of these are load-bearing beyond "the CRUD works":
 *
 *  - **activation requires a Russian body.** Without it an operator can switch
 *    the gate on before writing anything, and every sign-up is then refused
 *    for want of consent to an empty document. The failure surfaces on the
 *    registration screen, nowhere near the settings page that caused it.
 *  - **an English reader falls back to the Russian text.** The alternative is
 *    handing them a blank document to agree to, which is worse than an
 *    untranslated one.
 */

interface DocumentRow {
  key: LegalDocumentKey;
  isActive: boolean;
  titleRu: string;
  titleEn: string;
  bodyRu: string;
  bodyEn: string;
  updatedAt: Date;
}

function row(key: LegalDocumentKey, overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    key,
    isActive: false,
    titleRu: '',
    titleEn: '',
    bodyRu: '',
    bodyEn: '',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createService(rows: DocumentRow[]): {
  readonly service: LegalDocumentsService;
  readonly invalidations: string[];
} {
  const invalidations: string[] = [];
  const prisma = {
    legalDocument: {
      findMany: async (args?: { readonly where?: { readonly isActive?: boolean } }) =>
        args?.where?.isActive === true ? rows.filter((r) => r.isActive) : rows,
      findUnique: async (args: { readonly where: { readonly key: LegalDocumentKey } }) =>
        rows.find((r) => r.key === args.where.key) ?? null,
      upsert: async (args: {
        readonly where: { readonly key: LegalDocumentKey };
        readonly create: Partial<DocumentRow>;
        readonly update: Partial<DocumentRow>;
      }) => {
        const existing = rows.find((r) => r.key === args.where.key);
        if (existing === undefined) {
          const created = row(args.where.key, args.create);
          rows.push(created);
          return created;
        }
        Object.assign(existing, args.update);
        return existing;
      },
    },
  };
  const invalidator = {
    invalidatePolicy: async (reason: string) => {
      invalidations.push(reason);
      return true;
    },
  };
  return {
    service: new LegalDocumentsService(prisma as never, invalidator as never),
    invalidations,
  };
}

describe('LegalDocumentsService', () => {
  it('refuses to activate a document whose Russian text is empty', async () => {
    const { service } = createService([row('USER_AGREEMENT')]);

    await assert.rejects(
      () => service.update('USER_AGREEMENT', { isActive: true }),
      (error: unknown) =>
        error instanceof BadRequestException &&
        (error.getResponse() as { code?: string }).code === 'LEGAL_DOCUMENT_EMPTY',
    );
  });

  it('refuses to activate on whitespace alone', async () => {
    const { service } = createService([row('USER_AGREEMENT')]);

    await assert.rejects(
      () => service.update('USER_AGREEMENT', { isActive: true, bodyRu: '   \n  ' }),
      BadRequestException,
    );
  });

  it('activates once a Russian body is supplied in the same patch', async () => {
    const { service, invalidations } = createService([row('USER_AGREEMENT')]);

    const saved = await service.update('USER_AGREEMENT', {
      isActive: true,
      titleRu: 'Пользовательское соглашение',
      bodyRu: 'Условия использования сервиса.',
    });

    assert.equal(saved.isActive, true);
    assert.deepStrictEqual(invalidations, ['legal.USER_AGREEMENT']);
  });

  it('keeps an already-stored body when the patch only flips the switch', async () => {
    const { service } = createService([
      row('OFFER', { titleRu: 'Оферта', bodyRu: 'Публичная оферта.' }),
    ]);

    const saved = await service.update('OFFER', { isActive: true });

    assert.equal(saved.isActive, true);
    assert.equal(saved.bodyRu, 'Публичная оферта.');
  });

  /**
   * The title is the checkbox label at sign-up and the heading of the reader
   * dialog. Activating without one asks the visitor to accept something with
   * no name, and opens a dialog with a blank header — so a body alone is not
   * enough to publish.
   */
  it('refuses to activate a document that has text but no title', async () => {
    const { service } = createService([row('OFFER', { bodyRu: 'Публичная оферта.' })]);

    await assert.rejects(
      () => service.update('OFFER', { isActive: true }),
      (error: unknown) =>
        error instanceof BadRequestException &&
        (error.getResponse() as { code?: string }).code === 'LEGAL_DOCUMENT_UNTITLED',
    );
  });

  it('lists only active documents as required by the sign-up gate', async () => {
    const { service } = createService([
      row('USER_AGREEMENT', { isActive: true, titleRu: 'Соглашение', bodyRu: 'соглашение' }),
      row('OFFER'),
    ]);

    assert.deepStrictEqual(await service.listRequiredKeys(), ['USER_AGREEMENT']);
  });

  it('serves the Russian text to an English reader when the translation is empty', async () => {
    const { service } = createService([
      row('USER_AGREEMENT', {
        isActive: true,
        titleRu: 'Соглашение',
        bodyRu: 'Русский текст',
        titleEn: '',
        bodyEn: '',
      }),
    ]);

    const [document] = await service.listPublic('en');

    assert.equal(document?.title, 'Соглашение');
    assert.equal(document?.body, 'Русский текст');
  });

  it('serves the English text when it exists', async () => {
    const { service } = createService([
      row('USER_AGREEMENT', {
        isActive: true,
        titleRu: 'Соглашение',
        bodyRu: 'Русский текст',
        titleEn: 'Agreement',
        bodyEn: 'English text',
      }),
    ]);

    const [document] = await service.listPublic('en');

    assert.equal(document?.title, 'Agreement');
    assert.equal(document?.body, 'English text');
  });

  it('never leaks an inactive document to a reader', async () => {
    const { service } = createService([
      row('USER_AGREEMENT', { isActive: false, bodyRu: 'черновик, ещё не опубликован' }),
    ]);

    assert.deepStrictEqual(await service.listPublic('ru'), []);
  });

  it('shows the admin an empty document when the seeded row is missing', async () => {
    const { service } = createService([]);

    const documents = await service.listForAdmin();

    // Every declared key, in declaration order, each an empty placeholder. The
    // editor renders one card per entry, so a key missing here is a document
    // with nowhere to write its body — and activation refuses an empty body,
    // which makes it a document that can never be switched on.
    assert.deepStrictEqual(
      documents.map((d) => [d.key, d.isActive]),
      [
        ['USER_AGREEMENT', false],
        ['PRIVACY_POLICY', false],
        ['OFFER', false],
      ],
    );
  });
});
