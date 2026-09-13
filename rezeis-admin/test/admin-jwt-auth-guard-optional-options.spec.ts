import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OPTIONAL_DEPS_METADATA, PARAMTYPES_METADATA } from '@nestjs/common/constants';
import { AuthModuleOptions } from '@nestjs/passport';
import { Test } from '@nestjs/testing';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';

/**
 * `AdminJwtAuthGuard` declares `AuthModuleOptions` optional on its OWN
 * constructor.
 *
 * WHY THIS SPEC EXISTS. The guard used to be `extends AuthGuard('jwt') {}` and
 * reach passport's `@Optional()` through the prototype chain. `@nestjs/core` 12
 * reads that flag with `Reflect.getOwnMetadata` (nestjs/nest 011bff660), so the
 * constructor-less guard stops resolving in every module that uses it without
 * `AuthModule`'s passport options, and both the API and the worker abort at
 * boot. Typecheck, lint and build stay green through that — and on 11, so does
 * everything that actually runs, because 11 still follows the chain. The
 * constructor that fixes it looks redundant, which is exactly how it gets
 * deleted.
 *
 * So the first test reads the flag the way 12 does, on whatever version is
 * installed: on 11 it is the only check that fails when the constructor or its
 * `@Optional()` goes away. The second resolves the guard through the real
 * injector with no passport options anywhere, which is the situation of every
 * consumer module; on 11 it passes either way, on 12 it IS the boot failure.
 * `npm run smoke:boot` covers the whole graph of a build; this covers the one
 * class, in the suite.
 */
describe('AdminJwtAuthGuard optional passport options', () => {
  it('declares AuthModuleOptions optional on its own constructor, not only through AuthGuard', () => {
    const passportGuard: object = Object.getPrototypeOf(AdminJwtAuthGuard);

    // The premise. If passport's guard stops taking the options as optional
    // parameter 0, the constructor under test needs re-deciding — not these
    // assertions.
    assert.ok(
      ((Reflect.getOwnMetadata(OPTIONAL_DEPS_METADATA, passportGuard) as number[] | undefined) ?? []).includes(0),
      "AuthGuard('jwt') no longer declares constructor parameter 0 @Optional()",
    );
    assert.equal(
      (Reflect.getMetadata(PARAMTYPES_METADATA, AdminJwtAuthGuard) as unknown[] | undefined)?.[0],
      AuthModuleOptions,
    );

    // `includes`, not a whole-array comparison: 11's `@Optional()` also copies
    // the inherited entries into the class's own list, 12's does not.
    const ownOptional = (Reflect.getOwnMetadata(OPTIONAL_DEPS_METADATA, AdminJwtAuthGuard) as number[] | undefined) ?? [];
    assert.ok(
      ownOptional.includes(0),
      'AdminJwtAuthGuard relies on an inherited @Optional(); @nestjs/core 12 ignores it and the boot aborts',
    );
  });

  it('resolves through the Nest injector when no module provides AuthModuleOptions', async () => {
    const moduleRef = await Test.createTestingModule({ providers: [AdminJwtAuthGuard] }).compile();
    try {
      assert.ok(moduleRef.get(AdminJwtAuthGuard) instanceof AdminJwtAuthGuard);
    } finally {
      await moduleRef.close();
    }
  });
});
