import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { LegalDocument, LegalDocumentKey, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ReiwaCacheInvalidatorService } from '../../bot-config/services/reiwa-cache-invalidator.service';

/** The two documents, in the order the operator and the sign-up form show them. */
export const LEGAL_DOCUMENT_KEYS: readonly LegalDocumentKey[] = ['USER_AGREEMENT', 'OFFER'];

/** Locale of the cabinet the reader is using. `ru` is the primary locale. */
export type LegalDocumentLocale = 'ru' | 'en';

/** Admin view: everything, both locales, active or not. */
export interface LegalDocumentAdminInterface {
  readonly key: LegalDocumentKey;
  readonly isActive: boolean;
  readonly titleRu: string;
  readonly titleEn: string;
  readonly bodyRu: string;
  readonly bodyEn: string;
  readonly updatedAt: string;
}

/** Reader view: one locale, already resolved. */
export interface LegalDocumentPublicInterface {
  readonly key: LegalDocumentKey;
  readonly title: string;
  readonly body: string;
}

export interface UpdateLegalDocumentInput {
  readonly isActive?: boolean;
  readonly titleRu?: string;
  readonly titleEn?: string;
  readonly bodyRu?: string;
  readonly bodyEn?: string;
}

/**
 * Upper bound on a document body.
 *
 * The neighbouring operator-edited texts (bot texts, notification bodies, FAQ
 * answers) cap at 8000, which is a message-sized limit. A terms-of-service is
 * not a message; 8000 characters is roughly two pages and a real agreement
 * overruns it. 40000 is deliberately generous and still small enough that the
 * whole document fits one response without pagination.
 */
export const LEGAL_DOCUMENT_BODY_MAX = 40_000;
export const LEGAL_DOCUMENT_TITLE_MAX = 200;

@Injectable()
export class LegalDocumentsService {
  private readonly logger = new Logger(LegalDocumentsService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    // Optional so the module can be imported by tests and by the worker role
    // without dragging the webhook dispatcher in. A missing invalidator means
    // the edit still saves and reiwa picks it up when its cache expires.
    @Optional() private readonly reiwaCacheInvalidator?: ReiwaCacheInvalidatorService,
  ) {}

  /** Both documents for the admin editor. Rows are seeded by the migration. */
  public async listForAdmin(): Promise<readonly LegalDocumentAdminInterface[]> {
    const rows = await this.prismaService.legalDocument.findMany();
    return LEGAL_DOCUMENT_KEYS.map((key) => {
      const row = rows.find((candidate) => candidate.key === key);
      return row === undefined ? emptyAdminDocument(key) : mapAdminDocument(row);
    });
  }

  /**
   * The documents a reader may open, in the locale they are reading in.
   *
   * Falls back to the `ru` text when the requested locale is empty. That is a
   * deliberate asymmetry rather than an omission: the operator writes `ru`
   * first (activation requires it), and showing the Russian wording to an
   * English reader is strictly better than showing them a document that is
   * blank — a blank legal document is worse than an untranslated one.
   */
  public async listPublic(
    locale: LegalDocumentLocale,
  ): Promise<readonly LegalDocumentPublicInterface[]> {
    const rows = await this.prismaService.legalDocument.findMany({ where: { isActive: true } });
    return LEGAL_DOCUMENT_KEYS.filter((key) =>
      rows.some((candidate) => candidate.key === key),
    ).map((key) => {
      const row = rows.find((candidate) => candidate.key === key) as LegalDocument;
      return {
        key,
        title: resolveLocalized(locale, row.titleRu, row.titleEn),
        body: resolveLocalized(locale, row.bodyRu, row.bodyEn),
      };
    });
  }

  /**
   * Keys the sign-up gate requires right now.
   *
   * An active document always has a non-empty `ru` body — `update` refuses to
   * activate without one — so this never demands consent to text the reader
   * cannot see.
   */
  public async listRequiredKeys(): Promise<readonly LegalDocumentKey[]> {
    const rows = await this.prismaService.legalDocument.findMany({
      where: { isActive: true },
      select: { key: true },
    });
    return LEGAL_DOCUMENT_KEYS.filter((key) => rows.some((row) => row.key === key));
  }

  /**
   * Apply an operator edit.
   *
   * Activation requires a `ru` body. Without that check an operator could turn
   * the gate on before writing anything, and every sign-up would then be
   * refused for want of consent to an empty document — a self-inflicted
   * outage that looks like a bug in registration, far from its cause.
   */
  public async update(
    key: LegalDocumentKey,
    input: UpdateLegalDocumentInput,
  ): Promise<LegalDocumentAdminInterface> {
    const current = await this.prismaService.legalDocument.findUnique({ where: { key } });
    const merged = {
      isActive: input.isActive ?? current?.isActive ?? false,
      titleRu: input.titleRu ?? current?.titleRu ?? '',
      titleEn: input.titleEn ?? current?.titleEn ?? '',
      bodyRu: input.bodyRu ?? current?.bodyRu ?? '',
      bodyEn: input.bodyEn ?? current?.bodyEn ?? '',
    };
    // Both the title and the body, not just the body. The title is the label
    // beside the sign-up checkbox and the heading of the reader dialog — with
    // it empty the visitor is asked to accept something with no name, and the
    // dialog opens with a blank header. An unnamed consent is not a consent.
    if (merged.isActive && merged.bodyRu.trim().length === 0) {
      throw new BadRequestException({
        code: 'LEGAL_DOCUMENT_EMPTY',
        message: 'Заполните русский текст документа, прежде чем включать его',
      });
    }
    if (merged.isActive && merged.titleRu.trim().length === 0) {
      throw new BadRequestException({
        code: 'LEGAL_DOCUMENT_UNTITLED',
        message: 'Заполните русский заголовок документа, прежде чем включать его',
      });
    }

    const saved = await this.prismaService.legalDocument.upsert({
      where: { key },
      create: { key, ...merged },
      update: merged,
    });

    // The registration gate and the cabinet both read this through reiwa's
    // cache. Without the nudge an operator's edit is invisible until the TTL
    // expires, and "I turned it on and nothing happened" is indistinguishable
    // from a broken save. Best-effort by design — never blocks the save.
    if (this.reiwaCacheInvalidator !== undefined) {
      void this.reiwaCacheInvalidator.invalidatePolicy(`legal.${key}`);
    }
    this.logger.log(`Legal document ${key} updated (active=${merged.isActive})`);
    return mapAdminDocument(saved);
  }

  /**
   * Record acceptance of the given documents.
   *
   * Takes a transaction client because the only caller runs inside the
   * transaction that creates the account: a consent that outlives a rolled-back
   * registration would claim someone agreed to something before they existed.
   *
   * `skipDuplicates` rather than a unique-violation catch. Today the only
   * caller is `register`, where a duplicate cannot occur; the flag is there so
   * a second caller — a re-consent flow, or the Telegram-first `claim` path if
   * consent is ever extended to it — cannot turn a harmless repeat acceptance
   * into a 500.
   */
  public async recordConsents(
    tx: Prisma.TransactionClient,
    userId: string,
    keys: readonly LegalDocumentKey[],
  ): Promise<void> {
    if (keys.length === 0) return;
    await tx.userLegalConsent.createMany({
      data: keys.map((documentKey) => ({ userId, documentKey })),
      skipDuplicates: true,
    });
  }

  /** Documents this user has already accepted. */
  public async listAcceptedKeys(userId: string): Promise<readonly LegalDocumentKey[]> {
    const rows = await this.prismaService.userLegalConsent.findMany({
      where: { userId },
      select: { documentKey: true },
    });
    return rows.map((row) => row.documentKey);
  }
}

function resolveLocalized(locale: LegalDocumentLocale, ru: string, en: string): string {
  if (locale === 'en') {
    return en.trim().length > 0 ? en : ru;
  }
  return ru;
}

function mapAdminDocument(row: LegalDocument): LegalDocumentAdminInterface {
  return {
    key: row.key,
    isActive: row.isActive,
    titleRu: row.titleRu,
    titleEn: row.titleEn,
    bodyRu: row.bodyRu,
    bodyEn: row.bodyEn,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Shown when the seeded row is somehow absent (a database restored from before
 * the migration, say). The editor renders an empty, inactive document rather
 * than a missing one, and the first save upserts it back into existence.
 */
function emptyAdminDocument(key: LegalDocumentKey): LegalDocumentAdminInterface {
  return {
    key,
    isActive: false,
    titleRu: '',
    titleEn: '',
    bodyRu: '',
    bodyEn: '',
    updatedAt: new Date(0).toISOString(),
  };
}
