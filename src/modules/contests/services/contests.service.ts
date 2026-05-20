import { Injectable, Logger } from '@nestjs/common';

/**
 * Contests service — manages giveaway/contest lifecycle.
 *
 * Phase 1 (current): Stub service with the contract interface. The actual
 * contest persistence will be added once the Prisma schema is extended with
 * a `Contest` model (planned for a future slice).
 *
 * Planned capabilities:
 *  - Create contest (title, description, prize type, start/end dates)
 *  - List active/past contests
 *  - Record user participation
 *  - Draw winners (random selection from participants)
 *  - Distribute prizes (gift codes, subscription days, traffic)
 */
@Injectable()
export class ContestsService {
  private readonly logger = new Logger(ContestsService.name);

  /**
   * Placeholder: returns empty list until Contest model is added.
   */
  public async listContests(): Promise<readonly unknown[]> {
    return [];
  }

  /**
   * Placeholder: contest creation will be implemented with the Contest model.
   */
  public async createContest(_input: Record<string, unknown>): Promise<{ readonly id: string }> {
    this.logger.warn('Contest creation is not yet implemented');
    return { id: 'placeholder' };
  }
}
