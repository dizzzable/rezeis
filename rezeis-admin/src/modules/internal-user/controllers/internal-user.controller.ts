import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { AcceptInternalUserRulesDto } from '../dto/accept-internal-user-rules.dto';
import { CompleteWebAccountEmailVerificationDto } from '../dto/complete-web-account-email-verification.dto';
import { IssueWebAccountEmailVerificationChallengeDto } from '../dto/issue-web-account-email-verification-challenge.dto';
import { InternalUserSessionQueryDto } from '../dto/internal-user-session-query.dto';
import { SetWebAccountPasswordDto } from '../dto/set-web-account-password.dto';
import { SnoozeWebAccountLinkPromptDto } from '../dto/snooze-web-account-link-prompt.dto';
import { InternalWebAccountEmailVerificationChallengeInterface } from '../interfaces/internal-web-account-email-verification-challenge.interface';
import { InternalUserPlanInterface } from '../interfaces/internal-user-plan.interface';
import { InternalUserSessionInterface } from '../interfaces/internal-user-session.interface';
import { InternalUserSubscriptionInterface } from '../interfaces/internal-user-subscription.interface';
import { InternalUserService } from '../services/internal-user.service';

/**
 * Exposes internal user session and lookup endpoints for internal admin clients.
 */
@Controller('internal/user')
@UseGuards(InternalAdminAuthGuard)
export class InternalUserController {
  public constructor(private readonly internalUserService: InternalUserService) {}

  /**
   * Returns the resolved user session payload.
   */
  @Get('session')
  public async getSession(
    @Query() query: InternalUserSessionQueryDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.getSession(query);
  }

  /**
   * Marks the resolved user's rules as accepted.
   */
  @Patch('session/rules-acceptance')
  public async acceptRules(
    @Query() query: AcceptInternalUserRulesDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.acceptRules(query);
  }

  /**
   * Snoozes the resolved user's linked web-account prompt.
   */
  @Patch('session/web-account-link-prompt-snooze')
  public async snoozeWebAccountLinkPrompt(
    @Query() query: SnoozeWebAccountLinkPromptDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.snoozeWebAccountLinkPrompt(query);
  }

  /**
   * Sets the resolved user's linked web-account password through the internal handoff path.
   */
  @Patch('session/web-account-password')
  public async setWebAccountPassword(
    @Body() input: SetWebAccountPasswordDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.setWebAccountPassword(input);
  }

  /**
   * Creates or rotates the linked web-account email verification challenge.
   */
  @Patch('session/web-account-email-verification-challenge')
  public async issueWebAccountEmailVerificationChallenge(
    @Body() input: IssueWebAccountEmailVerificationChallengeDto,
  ): Promise<InternalWebAccountEmailVerificationChallengeInterface> {
    return this.internalUserService.issueWebAccountEmailVerificationChallenge(input);
  }

  /**
   * Consumes the latest actionable linked web-account email verification challenge.
   */
  @Patch('session/web-account-email-verification-completion')
  public async completeWebAccountEmailVerification(
    @Body() input: CompleteWebAccountEmailVerificationDto,
  ): Promise<InternalUserSessionInterface> {
    return this.internalUserService.completeWebAccountEmailVerification(input);
  }

  /**
   * Returns the public plans list.
   */
  @Get('plans')
  public async getPlans(): Promise<readonly InternalUserPlanInterface[]> {
    return this.internalUserService.getPlans();
  }

  /**
   * Returns the latest known subscription payload for the resolved user.
   */
  @Get('subscription')
  public async getSubscription(
    @Query() query: InternalUserSessionQueryDto,
  ): Promise<InternalUserSubscriptionInterface | null> {
    return this.internalUserService.getSubscription(query);
  }
}
