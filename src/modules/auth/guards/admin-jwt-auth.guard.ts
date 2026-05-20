import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Protects routes with the admin JWT strategy.
 */
@Injectable()
export class AdminJwtAuthGuard extends AuthGuard('jwt') {}
