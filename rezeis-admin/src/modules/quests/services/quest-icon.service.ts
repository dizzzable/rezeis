import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { QuestIconAssetInterface } from '../interfaces/quest-icon.interface';
import { assertSafeSvg } from '../../settings/services/icon-upload.service';

/**
 * Transport ceiling for a quest icon.
 *
 * The controller caps the multipart body at the same 100 KB
 * (`FileInterceptor('file', { limits: { fileSize: 100 * 1024 } })`), so the
 * validator is told the same number rather than defaulting to the larger
 * ceiling the icon/branding slots use. Two limits that disagree are how the
 * previous version rejected files at a size nobody had been shown.
 */
const MAX_SVG_BYTES = 100 * 1024;

/**
 * Manages operator-uploaded SVG icon assets for quests: validates on upload
 * (`assertSafeSvg`, shared with the icon/branding slots), stores the validated
 * markup, and serves it back for the admin picker + cabinet behind the
 * enforced `default-src 'none'` CSP the two controllers set. That header is
 * what kept the namespace-prefix bypass from being exploitable on THIS path;
 * the same payload on `/uploads` had no enforced CSP at all.
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
   * Validate a raw SVG upload and return it (trimmed) when safe; throw
   * `BadRequestException` otherwise.
   *
   * This used to be a byte-for-byte COPY of `assertSafeSvg`'s reject-list,
   * carrying a comment that the two were "kept identical so the two paths
   * cannot drift into different verdicts on the same file". They never drifted
   * apart; they drifted into the SAME hole. Both matched the literal string
   * `<script`, and in XML the namespace prefix is not part of the element name,
   * so `<ns0:script>` bound to the SVG namespace was accepted by both and had
   * to be fixed in both. Two copies of one policy is two places to fix and one
   * place to forget, so there is now one implementation.
   *
   * Kept as a static method because it is the published entry point for this
   * module and for `test/quest-icon-sanitizer.spec.ts`.
   */
  public static sanitizeSvg(raw: unknown): string {
    return assertSafeSvg(raw, MAX_SVG_BYTES);
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
