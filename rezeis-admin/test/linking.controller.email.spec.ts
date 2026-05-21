import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalApiGuard } from '../src/common/guards/internal-api.guard';
import { LinkingController } from '../src/modules/linking/linking.controller';

describe('LinkingController — Email Endpoints', () => {
  it('is mounted at internal/link path', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, LinkingController) as string | undefined;
    assert.equal(controllerPath, 'internal/link');
  });

  it('is protected by InternalApiGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, LinkingController) as any[] | undefined;
    assert.ok(guards);
    assert.ok(guards.includes(InternalApiGuard));
  });

  it('email/initiate endpoint is POST', () => {
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      LinkingController.prototype.initiateEmail,
    ) as RequestMethod | undefined;
    const path = Reflect.getMetadata(
      PATH_METADATA,
      LinkingController.prototype.initiateEmail,
    ) as string | undefined;
    assert.equal(method, RequestMethod.POST);
    assert.equal(path, 'email/initiate');
  });

  it('email/verify endpoint is POST', () => {
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      LinkingController.prototype.verifyEmail,
    ) as RequestMethod | undefined;
    const path = Reflect.getMetadata(
      PATH_METADATA,
      LinkingController.prototype.verifyEmail,
    ) as string | undefined;
    assert.equal(method, RequestMethod.POST);
    assert.equal(path, 'email/verify');
  });

  it('telegram/generate endpoint still exists', () => {
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      LinkingController.prototype.generateCode,
    ) as RequestMethod | undefined;
    const path = Reflect.getMetadata(
      PATH_METADATA,
      LinkingController.prototype.generateCode,
    ) as string | undefined;
    assert.equal(method, RequestMethod.POST);
    assert.equal(path, 'telegram/generate');
  });

  it('telegram/verify endpoint still exists', () => {
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      LinkingController.prototype.verifyTelegram,
    ) as RequestMethod | undefined;
    const path = Reflect.getMetadata(
      PATH_METADATA,
      LinkingController.prototype.verifyTelegram,
    ) as string | undefined;
    assert.equal(method, RequestMethod.POST);
    assert.equal(path, 'telegram/verify');
  });
});
