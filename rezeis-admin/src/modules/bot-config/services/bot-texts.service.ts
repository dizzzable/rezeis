import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BotText, Prisma } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';

interface CreateTextInput {
  readonly key: string;
  readonly value: string;
  readonly visible?: boolean;
  /**
   * Optional English translation for this text. Persisted as a sibling
   * `<key>@en` row (no migration). `null` / empty → no EN override.
   */
  readonly valueEn?: string | null;
}

interface UpdateTextInput {
  readonly id: string;
  readonly key?: string;
  readonly value?: string;
  readonly visible?: boolean;
  /**
   * When provided, upserts (non-empty) or deletes (empty/null) the
   * `<key>@en` sibling row. `undefined` leaves the EN sibling untouched.
   */
  readonly valueEn?: string | null;
}

/** A base bot text with its English sibling value attached (`null` when absent). */
export type BotTextWithEn = BotText & { readonly valueEn: string | null };

const TEXT_KEY_REGEX = /^[a-z0-9._-]+$/i;

/**
 * Reserved suffix for the per-text English sibling row. `@` is not a
 * valid operator key character (see {@link TEXT_KEY_REGEX}), so operators
 * can never create a base key ending in `@en` — the namespace stays clean
 * and EN siblings are always managed through their base row's editor.
 */
const EN_KEY_SUFFIX = '@en';

/**
 * Texts Telegram takes only up to a length of its own, below the DTO's 8000.
 * «Меню обновилось» (`menu.updated`) is the toast reiwa answers an old button
 * with (`answerCallbackQuery`: 0-200 characters). A longer one used to make the
 * answer fail and the old button got no menu; reiwa now cuts it, and the panel
 * refuses to save it (review R2a-08). Counted as Telegram counts: code points.
 * The SPA says the same under the field (`web/.../bot-text-limits.ts`).
 */
const TELEGRAM_MAX_CHARS_BY_KEY: ReadonlyMap<string, number> = new Map([['menu.updated', 200]]);

function codePointCount(text: string): number {
  let count = 0;
  for (const _codePoint of text) count += 1;
  return count;
}

/** Refuse a value of `key` longer than Telegram takes it; the operator reads the reason. */
function assertTelegramLength(key: string, value: string | null | undefined): void {
  const max = TELEGRAM_MAX_CHARS_BY_KEY.get(key.trim().toLowerCase());
  if (max === undefined || typeof value !== 'string') return;
  const count = codePointCount(value);
  if (count > max) {
    throw new BadRequestException(
      `Текст «${key}» Telegram показывает всплывающим сообщением и берёт не больше ${max} символов, а здесь ${count}. Сократите текст.`,
    );
  }
}

/** Trim an EN value; empty string → `null` (means "no EN override"). */
function normalizeEnValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

@Injectable()
export class BotTextsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public listAll(): Promise<BotText[]> {
    return this.prismaService.botText.findMany({ orderBy: { key: 'asc' } });
  }

  /**
   * List for the admin table: excludes the `<key>@en` sibling rows
   * (Req 3.3 — they are never standalone editable rows) and attaches
   * each base row's English value as `valueEn` (`null` when absent).
   */
  public async listForAdmin(): Promise<BotTextWithEn[]> {
    const rows = await this.prismaService.botText.findMany({ orderBy: { key: 'asc' } });
    const enByBaseKey = new Map<string, string>();
    for (const row of rows) {
      if (row.key.endsWith(EN_KEY_SUFFIX)) {
        enByBaseKey.set(row.key.slice(0, -EN_KEY_SUFFIX.length), row.value);
      }
    }
    return rows
      .filter((row) => !row.key.endsWith(EN_KEY_SUFFIX))
      .map((row) => ({ ...row, valueEn: enByBaseKey.get(row.key) ?? null }));
  }

  public async create(input: CreateTextInput): Promise<BotText> {
    if (!TEXT_KEY_REGEX.test(input.key)) {
      throw new BadRequestException('key must be alphanumeric (._- allowed)');
    }
    assertTelegramLength(input.key, input.value);
    assertTelegramLength(input.key, input.valueEn);
    const existing = await this.prismaService.botText.findUnique({ where: { key: input.key } });
    if (existing !== null) {
      throw new BadRequestException(`Text with key "${input.key}" already exists`);
    }
    const enValue = normalizeEnValue(input.valueEn);
    return this.prismaService.$transaction(async (tx) => {
      const base = await tx.botText.create({
        data: {
          key: input.key,
          value: input.value,
          visible: input.visible ?? true,
        },
      });
      if (enValue !== null) {
        await tx.botText.create({
          data: { key: `${input.key}${EN_KEY_SUFFIX}`, value: enValue, visible: base.visible },
        });
      }
      return base;
    });
  }

  public async update(input: UpdateTextInput): Promise<BotText> {
    const existing = await this.prismaService.botText.findUnique({ where: { id: input.id } });
    if (existing === null) {
      throw new NotFoundException('Bot text not found');
    }
    if (input.key !== undefined && !TEXT_KEY_REGEX.test(input.key)) {
      throw new BadRequestException('key must be alphanumeric (._- allowed)');
    }
    const baseKey = input.key ?? existing.key;
    // A renamed row brings its value to a key with a limit of its own.
    assertTelegramLength(baseKey, input.value ?? existing.value);
    assertTelegramLength(baseKey, input.valueEn);
    const data: Prisma.BotTextUpdateInput = {};
    if (input.key !== undefined) data.key = input.key;
    if (input.value !== undefined) data.value = input.value;
    if (input.visible !== undefined) data.visible = input.visible;

    return this.prismaService.$transaction(async (tx) => {
      const base = await tx.botText.update({ where: { id: input.id }, data });
      // The EN sibling is touched only when `valueEn` is part of the payload
      // (Req 1.3/1.4). The pair stays consistent because both writes share
      // this transaction.
      if (input.valueEn !== undefined) {
        const oldEnKey = `${existing.key}${EN_KEY_SUFFIX}`;
        const enKey = `${baseKey}${EN_KEY_SUFFIX}`;
        if (oldEnKey !== enKey) {
          await tx.botText.deleteMany({ where: { key: oldEnKey } });
        }
        const enValue = normalizeEnValue(input.valueEn);
        if (enValue !== null) {
          await tx.botText.upsert({
            where: { key: enKey },
            create: { key: enKey, value: enValue, visible: base.visible },
            update: { value: enValue },
          });
        } else {
          await tx.botText.deleteMany({ where: { key: enKey } });
        }
      }
      return base;
    });
  }

  /**
   * Idempotent upsert by `key`. Used when an internal feature owns a
   * specific key (e.g. `bot.banner_url` written by the banner upload
   * endpoint) and shouldn't have to special-case the create / update
   * branches in the controller.
   */
  public async upsert(input: CreateTextInput): Promise<BotText> {
    if (!TEXT_KEY_REGEX.test(input.key)) {
      throw new BadRequestException('key must be alphanumeric (._- allowed)');
    }
    assertTelegramLength(input.key, input.value);
    return this.prismaService.botText.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        value: input.value,
        visible: input.visible ?? false,
      },
      update: {
        value: input.value,
        ...(input.visible !== undefined ? { visible: input.visible } : {}),
      },
    });
  }

  public async delete(id: string): Promise<void> {
    const existing = await this.prismaService.botText.findUnique({ where: { id } });
    if (existing === null) {
      throw new NotFoundException('Bot text not found');
    }
    await this.prismaService.$transaction(async (tx) => {
      await tx.botText.delete({ where: { id } });
      // Drop the EN sibling alongside its base so deletes don't orphan it.
      await tx.botText.deleteMany({ where: { key: `${existing.key}${EN_KEY_SUFFIX}` } });
    });
  }
}
