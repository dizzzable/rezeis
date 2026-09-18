import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { InternalAdminAuthGuard } from '../../auth/guards/internal-admin-auth.guard';
import { WebAuthFirstPasswordDto } from '../dto/web-auth-first-password.dto';
import { WebAuthUserDto } from '../dto/web-auth-user.dto';
import type {
  WebFirstPasswordResultInterface,
  WebPasswordStateResultInterface,
  WebSessionsRevokeResultInterface,
  WebSessionsStateResultInterface,
} from '../interfaces/web-auth.interface';
import { WebFirstPasswordService } from '../services/web-first-password.service';
import { WebSessionRevocationService } from '../services/web-session-revocation.service';

/**
 * The signed-in customer's sessions and first password, for the cabinet.
 *
 * Every `userId` here is the one of the cabinet's own server session. A
 * cabinet older than these routes never calls them, and a panel older than
 * them answers 404, which the cabinet reads as "nothing to do": no session is
 * signed out, and the password page keeps its ordinary form.
 */
@ApiTags('internal/web-auth')
@UseGuards(InternalAdminAuthGuard)
@Controller('internal/web-auth')
// NOT THROTTLED PER ADDRESS, like every route behind `InternalAdminAuthGuard`:
// every call comes from the cabinet's backend, one address for all customers.
// The argument in full is on
// `src/modules/user-hints/controllers/internal-user-hints.controller.ts`.
@SkipThrottle()
export class InternalWebAuthCredentialsController {
  public constructor(
    private readonly revocation: WebSessionRevocationService,
    private readonly firstPassword: WebFirstPasswordService,
  ) {}

  @Post('sessions/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The moment before which every cabinet session of the customer is signed out',
    description:
      'Asked by the cabinet at most once a minute per session; a session that started before `sessionsRevokedAt` is ended. `null`: nothing revoked.',
  })
  public sessionsState(@Body() body: WebAuthUserDto): Promise<WebSessionsStateResultInterface> {
    return this.revocation.state(body.userId);
  }

  @Post('sessions/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '«Выйти на всех устройствах»: sign every existing cabinet session of the customer out',
    description: 'The cabinet gives the browser that asked a fresh session starting after `sessionsRevokedAt`. 404 without a web account.',
  })
  public revokeSessions(@Body() body: WebAuthUserDto): Promise<WebSessionsRevokeResultInterface> {
    return this.revocation.revokeAll(body.userId);
  }

  @Post('password/state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether the signed-in customer has a password yet (404 without a web account)' })
  public passwordState(@Body() body: WebAuthUserDto): Promise<WebPasswordStateResultInterface> {
    return this.firstPassword.state(body.userId);
  }

  @Post('password/first')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a first password for an account that has none, from a session the customer holds',
    description:
      'Never overwrites a password: `has_password` when one exists, including one set a moment earlier by a concurrent request. Clears the bootstrap and change-password flags and signs older sessions out.',
  })
  public setFirstPassword(@Body() body: WebAuthFirstPasswordDto): Promise<WebFirstPasswordResultInterface> {
    return this.firstPassword.set(body.userId, body.newPassword);
  }
}
