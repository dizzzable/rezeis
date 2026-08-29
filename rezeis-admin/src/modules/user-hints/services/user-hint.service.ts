import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserHint, UserHintCtaKind } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { HINT_ROUTE_TARGETS, UpsertUserHintDto } from '../dto/user-hint.dto';

/**
 * The hint LIBRARY — authoring, not delivery.
 *
 * Deliveries point at these rows and read the copy when they are SHOWN, which
 * is what makes a typo fixable for everyone still holding the hint unseen. It
 * is also what makes `isActive` mean something simple: a disabled hint stops
 * being shown, its queued rows stay put and lapse on their own clock, and
 * enabling it again resumes whatever has not expired. There is no second rule
 * to remember because there is no second copy of the text.
 */
@Injectable()
export class UserHintService {
  private readonly logger = new Logger(UserHintService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public listAll(): Promise<UserHint[]> {
    return this.prismaService.userHint.findMany({
      orderBy: [{ isActive: 'desc' }, { key: 'asc' }],
    });
  }

  public async getById(id: string): Promise<UserHint> {
    const hint = await this.prismaService.userHint.findUnique({ where: { id } });
    if (hint === null) throw new NotFoundException('Hint not found');
    return hint;
  }

  public async create(input: UpsertUserHintDto): Promise<UserHint> {
    const data = this.buildWriteData(input);
    try {
      return await this.prismaService.userHint.create({
        data: { key: input.key, ...data },
      });
    } catch (err: unknown) {
      throw this.translateWriteError(err, input.key);
    }
  }

  public async update(id: string, input: UpsertUserHintDto): Promise<UserHint> {
    await this.getById(id);
    try {
      return await this.prismaService.userHint.update({
        where: { id },
        data: { key: input.key, ...this.buildWriteData(input) },
      });
    } catch (err: unknown) {
      throw this.translateWriteError(err, input.key);
    }
  }

  /**
   * Removes a hint and, by the FK cascade, every delivery of it.
   *
   * DELETING IS NOT HOW YOU STOP A HINT — `isActive = false` is, and it keeps
   * the record of who was shown what. Deleting is for a hint authored by
   * mistake, and it takes the evidence with it, which is why the two are
   * separate verbs rather than one flag.
   */
  public async remove(id: string): Promise<{ deletedDeliveries: number }> {
    await this.getById(id);
    const deletedDeliveries = await this.prismaService.userHintDelivery.count({
      where: { hintId: id },
    });
    await this.prismaService.userHint.delete({ where: { id } });
    return { deletedDeliveries };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The fields both create and update write.
   *
   * Typed as the CREATE input, not the update one: update accepts field
   * operations (`{ set: … }`) as well as bare values, so a shared builder typed
   * against it would compile happily and then hand `create` a shape it cannot
   * take. The narrower type is the one that keeps both callers honest.
   */
  private buildWriteData(
    input: UpsertUserHintDto,
  ): Omit<Prisma.UserHintCreateInput, 'key'> {
    const ctaKind = input.ctaKind ?? UserHintCtaKind.NONE;
    const ctaTarget = this.validateCtaTarget(ctaKind, input.ctaTarget ?? null);
    // A button with no words on it is a button nobody presses. Checked here
    // rather than in the DTO because it depends on `ctaKind`.
    if (ctaKind !== UserHintCtaKind.NONE && (input.ctaLabelRu ?? '').length === 0) {
      throw new BadRequestException('ctaLabelRu is required when the hint has a button');
    }
    return {
      titleRu: input.titleRu,
      bodyRu: input.bodyRu,
      titleEn: this.emptyToNull(input.titleEn),
      bodyEn: this.emptyToNull(input.bodyEn),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ctaKind,
      ctaLabelRu: ctaKind === UserHintCtaKind.NONE ? null : this.emptyToNull(input.ctaLabelRu),
      ctaLabelEn: ctaKind === UserHintCtaKind.NONE ? null : this.emptyToNull(input.ctaLabelEn),
      ctaTarget,
      surfaces: input.surfaces ?? [],
      formFactors: input.formFactors ?? [],
      groupKey: this.emptyToNull(input.groupKey),
      ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
      ...(input.isRepeatable !== undefined ? { isRepeatable: input.isRepeatable } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    };
  }

  /**
   * The destination, checked against what the KIND permits.
   *
   * ROUTE is checked against the curated list, so a renamed cabinet route is a
   * validation error while the operator is still looking at the form rather
   * than a dead button discovered by a customer.
   *
   * EXTERNAL demands `https://`. Not decoration: the cabinet is served over TLS
   * and a plain-http destination is both a mixed-content warning and a link
   * that can be rewritten in flight. `javascript:` and `data:` are refused by
   * the same check, which is the one that actually matters — an operator
   * account is not a place to accept arbitrary script.
   */
  private validateCtaTarget(kind: UserHintCtaKind, raw: string | null): string | null {
    if (kind === UserHintCtaKind.NONE) return null;
    const value = (raw ?? '').trim();
    if (value.length === 0) {
      throw new BadRequestException('ctaTarget is required when the hint has a button');
    }
    if (kind === UserHintCtaKind.ROUTE) {
      if (!(HINT_ROUTE_TARGETS as readonly string[]).includes(value)) {
        throw new BadRequestException(
          `ctaTarget must be one of the known cabinet routes: ${HINT_ROUTE_TARGETS.join(', ')}`,
        );
      }
      return value;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new BadRequestException('ctaTarget must be an absolute URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('ctaTarget must use https');
    }
    return parsed.toString();
  }

  private emptyToNull(value: string | undefined): string | null {
    const trimmed = (value ?? '').trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  private translateWriteError(err: unknown, key: string): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(`A hint with key "${key}" already exists`);
    }
    return err;
  }
}
