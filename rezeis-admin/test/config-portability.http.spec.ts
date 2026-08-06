import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import { AdminConfigPortabilityController } from '../src/modules/config-portability/controllers/admin-config-portability.controller';
import {
  ConfigExportPayloadInterface,
  ConfigExportService,
} from '../src/modules/config-portability/services/config-export.service';
import {
  ConfigImportInput,
  ConfigImportService,
} from '../src/modules/config-portability/services/config-import.service';

/**
 * Does the manifest survive the wire?
 * ───────────────────────────────────
 * Every unit test around the manifest hands it straight to the service. The
 * app's global pipe runs with `whitelist: true, forbidNonWhitelisted: true`,
 * and `ConfigImportDto.payload` is a bare `@IsObject()` — so if the pipe
 * recursed into it, `manifest` would be stripped somewhere between the
 * operator's file and `ConfigImportService`, every manifest test would stay
 * green, and production would never once run the check they describe.
 *
 * This drives a real HTTP request through the real pipe and asserts on what
 * the service was actually handed.
 */
describe('Config portability HTTP contract', () => {
  let application: INestApplication;
  const importCalls: ConfigImportInput[] = [];
  let exportResult: () => Promise<ConfigExportPayloadInterface>;

  before(async () => {
    const testingModule: TestingModule = await Test.createTestingModule({
      controllers: [AdminConfigPortabilityController],
      providers: [
        {
          provide: ConfigExportService,
          useValue: {
            exportConfig: async () => exportResult(),
          },
        },
        {
          provide: ConfigImportService,
          useValue: {
            importConfig: async (input: ConfigImportInput) => {
              importCalls.push(input);
              return {
                version: 1,
                strategy: input.strategy,
                dryRun: input.dryRun,
                integrity: 'verified',
                summaries: [],
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
              };
            },
          },
        },
        {
          provide: RbacService,
          useValue: {
            getEffectivePermissions: async () => [
              { resource: 'config_portability', action: 'import' },
            ],
          },
        },
      ],
    })
      .overrideGuard(AdminJwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }): boolean => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: 'admin-1', role: 'DEV', rbacRoleId: null };
          return true;
        },
      })
      .overrideGuard(RbacGuard)
      .useValue({ canActivate: (): boolean => true })
      .compile();

    application = testingModule.createNestApplication();
    application.setGlobalPrefix('api');
    application.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
  });

  after(async () => {
    await application.close();
  });

  it('hands the import service the manifest the operator uploaded', async () => {
    importCalls.length = 0;

    await request(application.getHttpServer())
      .post('/api/admin/config/import')
      .send({
        payload: {
          version: 1,
          exportedAt: '2026-01-01T00:00:00.000Z',
          source: 'rezeis-admin',
          manifest: { roles: 2, webhooks: 0 },
          sections: { roles: [{ id: 'r-1' }, { id: 'r-2' }], webhooks: [] },
        },
        strategy: 'overwrite',
        dryRun: true,
      })
      .expect(200);

    assert.equal(importCalls.length, 1);
    const received = importCalls[0]!.payload;
    assert.deepEqual(
      received.manifest,
      { roles: 2, webhooks: 0 },
      'the whitelisting pipe must not strip the manifest out of the payload',
    );
    // The sections have to arrive intact too, or the count check would be
    // comparing the manifest against something the pipe rewrote.
    assert.equal(received.sections.roles?.length, 2);
    assert.deepEqual(received.sections.webhooks, []);
  });

  it('serves the manifest the export service produced', async () => {
    exportResult = async () => ({
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      source: 'rezeis-admin',
      manifest: { roles: 1 },
      sections: { roles: [{ id: 'r-1' }] },
    });

    const response = await request(application.getHttpServer())
      .get('/api/admin/config/export')
      .expect(200);

    assert.deepEqual(response.body.manifest, { roles: 1 });
  });

  it('answers a failed export with a 5xx that names the section, not a 200', async () => {
    // The whole point of throwing rather than swallowing is that the
    // operator's browser never receives a downloadable file. If the filter
    // or the controller turned this back into a 200 the fix would be
    // undone at the edge.
    const { ServiceUnavailableException } = await import('@nestjs/common');
    exportResult = async () => {
      throw new ServiceUnavailableException(
        'Config export failed for section(s): roles. No file was produced.',
      );
    };

    const response = await request(application.getHttpServer())
      .get('/api/admin/config/export')
      .expect(503);

    assert.match(JSON.stringify(response.body), /roles/);
  });
});
