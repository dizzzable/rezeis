import { Injectable, Optional } from '@nestjs/common';
import { AuthGuard, AuthModuleOptions } from '@nestjs/passport';

/**
 * Protects routes with the admin JWT strategy.
 */
@Injectable()
export class AdminJwtAuthGuard extends AuthGuard('jwt') {
  /**
   * Looks redundant and is not. Without it this guard still works on NestJS 11
   * and aborts the boot of both the API and the worker on NestJS 12.
   *
   * `AuthGuard('jwt')` has one constructor parameter, `AuthModuleOptions`,
   * marked `@Optional()`. Those options are provided only inside `AuthModule`
   * (`PassportModule.register()`, which it does not export), so in every other
   * module whose controllers name this guard in `@UseGuards` they are absent
   * and the guard runs on `@nestjs/passport`'s defaults.
   *
   * A subclass with no constructor of its own reached that `@Optional()` through
   * the prototype chain. `@nestjs/core` 12 reads the flag with
   * `Reflect.getOwnMetadata` (nestjs/nest 011bff660, "dont inherit the optional
   * decorator metadata"), so the parameter turns required and the first module
   * without the options fails dependency resolution — while typecheck, lint and
   * build all stay green. Declaring the parameter here puts the flag on this
   * class, where both versions read it.
   *
   * On 11 the inherited flag still works, so deleting this constructor changes
   * nothing a running app can notice there;
   * `test/admin-jwt-auth-guard-optional-options.spec.ts` reads the flag the way
   * 12 does.
   */
  constructor(@Optional() options?: AuthModuleOptions) {
    super(options);
  }
}
