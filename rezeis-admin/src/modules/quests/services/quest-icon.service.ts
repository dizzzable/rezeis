import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { QuestIconAssetInterface } from '../interfaces/quest-icon.interface';

const MAX_SVG_BYTES = 100 * 1024;

/**
 * Forbidden substrings (checked case-insensitively). We deliberately
 * VALIDATE-AND-REJECT rather than surgically strip: an icon SVG only needs
 * shapes/paths/gradients, so anything carrying active content, external
 * references, or a DOCTYPE/ENTITY (XSS / XXE / SSRF surface) is refused outright
 * — far safer than trying to clean partially. Operators simplify the SVG.
 */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  '<script',
  '<foreignobject',
  '<iframe',
  '<embed',
  '<object',
  '<use', // external/same-doc symbol refs — not needed for a flat icon
  '<image', // can load external/data bitmaps
  '<animate',
  '<set',
  '<style',
  '<!doctype',
  '<!entity',
  '<!element',
  'javascript:',
  'expression(',
  '@import',
  '@font-face',
];

/** Regexes that reject dangerous attribute/URL patterns. */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /[\s/"']on[a-z0-9_-]+\s*=/i, // inline event handlers, incl. attr/quote-adjacent (<rect/onload=…>)
  /(?:xlink:)?href\s*=\s*["']?\s*(?!#)/i, // any href not a local #fragment
  /url\(\s*(?!#)/i, // CSS url() not a local #fragment
  /data:/i, // data: URIs anywhere
  /&#x?[0-9a-f]+;?/i, // numeric char-ref entities (obfuscation / XXE vectors)
];

/**
 * Manages operator-uploaded SVG icon assets for quests: sanitizes on upload
 * (see the reject policy above), stores the sanitized markup, and serves it
 * back for the admin picker + cabinet (behind hardened response headers set by
 * the controllers).
 */
@Injectable()
export class QuestIconService {
  public constructor(private readonly prismaService: PrismaService) {}

  /** Validate + store a raw SVG upload. Throws `BadRequestException` if unsafe. */
  public async store(input: {
    readonly raw: string;
    readonly name: string;
    readonly uploadedBy: string | null;
  }): Promise<QuestIconAssetInterface> {
    const svg = QuestIconService.sanitizeSvg(input.raw);
    const sizeBytes = Buffer.byteLength(svg, 'utf8');
    const created = await this.prismaService.questIconAsset.create({
      data: {
        name: input.name.trim().slice(0, 120) || 'icon.svg',
        svg,
        sizeBytes,
        uploadedBy: input.uploadedBy,
      },
      select: { id: true, name: true, sizeBytes: true, createdAt: true },
    });
    return mapIcon(created);
  }

  public async list(): Promise<readonly QuestIconAssetInterface[]> {
    const icons = await this.prismaService.questIconAsset.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, name: true, sizeBytes: true, createdAt: true },
    });
    return icons.map(mapIcon);
  }

  /** Returns the sanitized SVG markup for serving, or `null` when missing. */
  public async getSvg(iconId: string): Promise<string | null> {
    const icon = await this.prismaService.questIconAsset.findUnique({
      where: { id: iconId },
      select: { svg: true },
    });
    return icon?.svg ?? null;
  }

  /**
   * Validate a raw SVG string and return it unchanged when safe; throw
   * `BadRequestException` otherwise. Pure + static so it is unit-testable in
   * isolation.
   */
  public static sanitizeSvg(raw: string): string {
    if (typeof raw !== 'string') {
      throw new BadRequestException('Icon must be an SVG string');
    }
    // Strip a leading XML declaration + surrounding whitespace.
    const trimmed = raw.replace(/^\uFEFF/, '').trim().replace(/^<\?xml[^>]*\?>\s*/i, '').trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('Empty SVG');
    }
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_SVG_BYTES) {
      throw new BadRequestException('SVG too large (max 100 KB)');
    }
    const lower = trimmed.toLowerCase();
    if (!/^<svg[\s>]/.test(lower) || !/<\/svg>\s*$/.test(lower)) {
      throw new BadRequestException('File must be a single <svg> element');
    }
    for (const token of FORBIDDEN_SUBSTRINGS) {
      if (lower.includes(token)) {
        throw new BadRequestException(`SVG contains a disallowed element/attribute: ${token}`);
      }
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new BadRequestException('SVG contains a disallowed attribute or reference');
      }
    }
    return trimmed;
  }
}

function mapIcon(record: {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: Date;
}): QuestIconAssetInterface {
  return {
    id: record.id,
    name: record.name,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt.toISOString(),
  };
}
