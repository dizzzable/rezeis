import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { CurrentAdmin } from '../../auth/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../../auth/guards/admin-jwt-auth.guard';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { extractRequestMetadata } from '../../auth/utils/request-metadata.util';
import {
  TwoFactorDisableDto,
  TwoFactorEnrollDto,
  TwoFactorVerifyDto,
} from '../dto/two-factor.dto';
import { TwoFactorService } from '../services/two-factor.service';

/**
 * Admin self-service surface for managing 2FA on their own account.
 *
 * Notes
 *   - Every endpoint is JWT-protected. The login flow itself uses
 *     dedicated public endpoints (see admin-auth.controller.ts).
 *   - We deliberately do NOT expose endpoints that let an admin manage
 *     2FA for a *different* admin — security factors are personal.
 *
 * Rate limits, and why they are not one number
 *
 *   Four of the five routes below check a credential — a TOTP code, a recovery
 *   code, or the account password — and every one of them carried no
 *   `@Throttle` at all, which left them on the global 600/60 s default
 *   (`common/throttle/throttle.module.ts:39-44`). Measured against a real
 *   `ThrottlerModule`, `POST /admin/2fa/disable` accepted 600 wrong codes from
 *   a single IP inside one minute, the first 429 arrived at attempt 601, and
 *   nothing was written anywhere: `LoginGuardService` does not watch these
 *   routes, so none of those 600 guesses spent a budget. Against a 10^6 code
 *   space with ~3 codes live at any moment that is a coin-flip inside a
 *   working day from one address.
 *
 *   The limits are per HANDLER, deliberately not on the class: `GET status` is
 *   read by the settings page on every render and must keep the global budget.
 *
 *   The numbers trade brute-force cost against the failure that actually gets
 *   second factors switched off — an operator locked out of their own security
 *   page while squinting at a code on a phone. At 10/60 s a single-IP attack on
 *   a TOTP route moves from ~6 h to ~16 days for the same 50% chance, so the
 *   marginal security of going tighter is small and the marginal annoyance is
 *   not. Where a route is both a likely fumble and a poor target, it is looser
 *   still — see `confirm`.
 *
 *   These are per-IP flood caps and nothing more. They are NOT the
 *   consecutive-failure cap NIST SP 800-63B s5.2.2 asks for: a per-minute
 *   ceiling permits unbounded attempts given unbounded time. That cap is
 *   `LoginGuardService`'s job, and as of the owner decision of 2026-08-23 it
 *   covers these four routes too: every handler below passes the request's
 *   metadata into `TwoFactorService`, which pre-checks the per-(login, ip)
 *   budget before the credential and charges every verdict to it (see
 *   `assertWithinAttemptBudget` there). The policy question that used to be
 *   open — what a locked-out operator does next — is now answered: wait out
 *   the 15-minute window, or `admin-cli`. The `@Throttle` caps stay because
 *   they answer a different question (per-minute flood) than the counter
 *   (consecutive failures over 15 minutes).
 */
@ApiTags('admin/2fa')
@ApiBearerAuth('JWT')
@UseGuards(AdminJwtAuthGuard)
@Controller('admin/2fa')
export class AdminTwoFactorController {
  public constructor(private readonly twoFactorService: TwoFactorService) {}

  @Get('status')
  @ApiOperation({ summary: 'Returns the 2FA status of the current admin' })
  public status(@CurrentAdmin() currentAdmin: CurrentAdminInterface) {
    return this.twoFactorService.getStatus(currentAdmin.id);
  }

  /**
   * 10/60 s. This route now verifies the account PASSWORD
   * (`TwoFactorService.assertPasswordBeforeEnrollment`), which makes it the
   * same class of target as the sign-in form and the most valuable one here: a
   * hijacked session that guesses the password mints itself a second factor.
   *
   * Not 5 — the number the sign-in form uses — because the shapes differ. The
   * SPA's first call carries NO password on purpose, so the server can answer
   * with the `factor`-bearing 401 that tells it which field to render
   * (`web/src/features/two-factor/two-factor-api.ts:56-65`). That probe spends
   * a request. At 5 the operator would get four password attempts to the sign-in
   * form's five, for the same credential, and every cancel-and-reopen of the
   * dialog would spend another. 10 buys two full probe-plus-four-attempts
   * cycles a minute and still cuts the ceiling 60-fold.
   */
  @Post('enroll')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Begins (or restarts) the 2FA enrollment, returning the OTP URI + recovery codes',
  })
  public enroll(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: TwoFactorEnrollDto,
    @Req() request: Request,
  ) {
    return this.twoFactorService.beginEnrollment(
      currentAdmin.id,
      dto.password,
      extractRequestMetadata(request),
    );
  }

  /**
   * 20/60 s — the loosest of the four, and the asymmetry is the point.
   *
   * This is where an operator fumbles. They have just scanned a QR code, the
   * digits roll every 30 s, and a phone whose clock has drifted produces a
   * string of rejections that are nobody's fault. Locking someone out halfway
   * through turning 2FA ON is the failure that ends with 2FA turned off.
   *
   * It is also the weakest target in the file. `confirmEnrollment` only checks
   * against a PENDING secret, and the only way to create one is `enroll`, which
   * now demands the password. An attacker who can mint a pending secret already
   * holds the plaintext it returned and has no reason to guess; an attacker
   * riding someone else's half-finished enrolment would, on success, merely
   * finish activating a factor they cannot use. Cheap to loosen, expensive to
   * tighten — so it is loosened.
   */
  @Post('confirm')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirms a fresh enrollment by verifying the first code' })
  public confirm(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: TwoFactorVerifyDto,
    @Req() request: Request,
  ) {
    return this.twoFactorService.confirmEnrollment(
      currentAdmin.id,
      dto.code,
      extractRequestMetadata(request),
    );
  }

  /**
   * 10/60 s. The measured hole: 600 wrong codes a minute, 2FA still enabled
   * only because none of them happened to be right, and not one row written to
   * show it had been tried. Succeeding here does not borrow the second factor,
   * it DELETES it — `disable()` nulls the secret, the recovery set and the
   * enrolment date — so this is the route a hijacked session wants most.
   *
   * 10 leaves room for the honest retries this prompt attracts: a code that
   * rolled over while being typed, and a 10-character recovery code entered by
   * hand from paper.
   */
  @Post('disable')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turns off 2FA — requires a valid code (TOTP or recovery)' })
  public disable(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: TwoFactorDisableDto,
    @Req() request: Request,
  ) {
    return this.twoFactorService.disable(
      currentAdmin.id,
      dto.code,
      extractRequestMetadata(request),
    );
  }

  /**
   * 10/60 s, same as `disable` and for the same reason. Guessing a code here
   * does not turn the factor off, it REPLACES the recovery set with ten codes
   * the caller is handed in the response — which is the same takeover by a
   * slower route, and it leaves the real operator's printed codes silently
   * dead. Treating it more gently than `disable` would just move the attack
   * one endpoint over.
   */
  @Post('recovery-codes/regenerate')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issues a fresh set of recovery codes' })
  public regenerateRecoveryCodes(
    @CurrentAdmin() currentAdmin: CurrentAdminInterface,
    @Body() dto: TwoFactorVerifyDto,
    @Req() request: Request,
  ) {
    return this.twoFactorService
      .regenerateRecoveryCodes(currentAdmin.id, dto.code, extractRequestMetadata(request))
      .then((codes) => ({ recoveryCodes: codes }));
  }
}
