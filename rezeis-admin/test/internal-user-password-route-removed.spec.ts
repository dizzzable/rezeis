import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { DeviceIntelligenceService } from '../src/modules/device-intelligence/services/device-intelligence.service';
import { InternalUserController } from '../src/modules/internal-user/controllers/internal-user.controller';
import { InternalUserEdgeService } from '../src/modules/internal-user/services/internal-user-edge.service';
import { InternalUserService } from '../src/modules/internal-user/services/internal-user.service';
import { SubscriptionMutationsService } from '../src/modules/subscriptions/services/subscription-mutations.service';

/**
 * The cabinet's old «change password» route is gone
 * ══════════════════════════════════════════════════
 * `PATCH /api/internal/user/session/web-account-password` set a login and a
 * password for the customer the cabinet named — with no current password, no
 * reset link, and no sign-out of the other sessions. The one caller, the
 * cabinet's `PATCH /api/v1/me/password`, never sent the login the route
 * required, so every call ended in a 400 and nothing ever used it. A route
 * that sets a password without any proof is a risk the day somebody "fixes"
 * the caller, so it is deleted rather than left: an old cabinet that still
 * calls it now gets a 404 instead of that 400.
 */

describe('the password route with no proof is gone', () => {
  let app: INestApplication;

  before(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalUserController],
      providers: [
        // No route under test reaches a service: empty, so a call would throw.
        { provide: InternalUserService, useValue: {} },
        { provide: InternalUserEdgeService, useValue: {} },
        { provide: SubscriptionMutationsService, useValue: {} },
        { provide: DeviceIntelligenceService, useValue: {} },
      ],
    })
      .overrideGuard(InternalAdminAuthGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('/api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalFilters(new AdminSafeExceptionFilter());
    await app.init();
  });

  after(async () => {
    await app.close();
  });

  it('answers 404 to what an old cabinet sends — and to the body it never sent too', async () => {
    const userId = 'cmphfcr6i007v01jg0lcu653h';
    for (const body of [
      { userId, password: 'a'.repeat(64) },
      { userId, login: 'someone', password: 'a'.repeat(64) },
    ]) {
      const response = await request(app.getHttpServer())
        .patch('/api/internal/user/session/web-account-password')
        .send(body);
      assert.equal(response.status, 404, `${JSON.stringify(body)} → ${response.status} ${response.text}`);
      assert.equal((response.body as { errorCode?: string }).errorCode, 'NOT_FOUND');
    }
  });

  it('is named nowhere in src/ any more — no service method, no DTO, no route', () => {
    const SRC = join(__dirname, '..', 'src');
    const files = (function walk(directory: string): string[] {
      return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
      });
    })(SRC);
    const naming = files
      .filter((file) => /setWebAccountPassword|SetWebAccountPasswordDto|web-account-password/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split(sep).join('/'));
    assert.deepEqual(naming, []);
  });
});
