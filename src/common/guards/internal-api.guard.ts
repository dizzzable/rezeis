import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InternalApiGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-internal-api-key'];
    const expected = this.config.get('REZEIS_ADMIN_INTERNAL_API_KEY');
    if (!apiKey || apiKey !== expected) {
      throw new UnauthorizedException('Invalid internal API key');
    }
    return true;
  }
}
