import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { authConfig } from '../src/common/config/auth.config';
import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { RedeemDeviceProvisioningChallengeDto } from '../src/modules/users/dto/redeem-device-provisioning-challenge.dto';
import { InternalDeviceProvisioningController } from '../src/modules/users/controllers/internal-device-provisioning.controller';
import { AdminUsersService } from '../src/modules/users/services/admin-users.service';

describe('InternalDeviceProvisioningController', () => {
  let app: INestApplication;
  const redeemCalls: Array<{ challengeId: string; dto: RedeemDeviceProvisioningChallengeDto }> = [];

  before(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [InternalDeviceProvisioningController],
      providers: [
        InternalAdminAuthGuard,
        {
          provide: authConfig.KEY,
          useValue: {
            internalApiKey: 'secret',
          },
        },
        {
          provide: AdminUsersService,
          useValue: {
            redeemDeviceProvisioningChallenge: async (input: {
              readonly challengeId: string;
              readonly dto: RedeemDeviceProvisioningChallengeDto;
            }) => {
              redeemCalls.push(input);
              return {
                challengeId: input.challengeId,
                status: 'CONSUMED',
                consumedAt: '2026-04-24T12:05:00.000Z',
                deviceCount: 2,
              };
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  after(async () => {
    await app.close();
  });

  it('exposes internal redeem route behind InternalAdminAuthGuard', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, InternalDeviceProvisioningController), 'internal/users/device-provisioning-challenges');
    assert.deepStrictEqual(Reflect.getMetadata(GUARDS_METADATA, InternalDeviceProvisioningController), [InternalAdminAuthGuard]);
  });

  it('delegates challenge redemption to admin users service without exposing provider payloads', async () => {
    const calls: Array<{ challengeId: string; dto: RedeemDeviceProvisioningChallengeDto }> = [];
    const controller = new InternalDeviceProvisioningController({
      redeemDeviceProvisioningChallenge: async (input: {
        readonly challengeId: string;
        readonly dto: RedeemDeviceProvisioningChallengeDto;
      }) => {
        calls.push(input);
        return {
          challengeId: input.challengeId,
          status: 'CONSUMED' as const,
          consumedAt: '2026-04-24T12:05:00.000Z',
          deviceCount: 2,
        };
      },
    } as unknown as AdminUsersService);

    const dto = {
      hwid: 'raw-hwid-1',
      platform: 'ios',
      osVersion: '17.0',
      deviceModel: 'iPhone',
      userAgent: 'RezeisApp/1.0',
    } as RedeemDeviceProvisioningChallengeDto;
    const actualResult = await controller.redeemDeviceProvisioningChallenge('challenge-1', dto);

    assert.deepStrictEqual(calls, [{ challengeId: 'challenge-1', dto }]);
    assert.deepStrictEqual(actualResult, {
      challengeId: 'challenge-1',
      status: 'CONSUMED',
      consumedAt: '2026-04-24T12:05:00.000Z',
      deviceCount: 2,
    });
    assert.equal(JSON.stringify(actualResult).includes('hwid'), false);
  });

  it('blocks redeem HTTP calls without internal api key', async () => {
    await request(app.getHttpServer())
      .post('/internal/users/device-provisioning-challenges/challenge-1/redeem')
      .send({ hwid: 'raw-hwid-1' })
      .expect(401);
  });

  it('accepts raw HWID only on guarded internal redeem HTTP route and returns minimal response', async () => {
    redeemCalls.length = 0;
    const response = await request(app.getHttpServer())
      .post('/internal/users/device-provisioning-challenges/challenge-1/redeem')
      .set('x-internal-api-key', 'secret')
      .send({
        hwid: 'raw-hwid-1',
        platform: 'ios',
        osVersion: '17.0',
        deviceModel: 'iPhone',
        userAgent: 'RezeisApp/1.0',
      })
      .expect(201);

    assert.deepStrictEqual(response.body, {
      challengeId: 'challenge-1',
      status: 'CONSUMED',
      consumedAt: '2026-04-24T12:05:00.000Z',
      deviceCount: 2,
    });
    assert.equal(JSON.stringify(response.body).includes('raw-hwid-1'), false);
    assert.equal(JSON.stringify(response.body).includes('userUuid'), false);
    assert.equal(JSON.stringify(response.body).includes('challengeHash'), false);
    assert.deepStrictEqual(redeemCalls, [
      {
        challengeId: 'challenge-1',
        dto: {
          hwid: 'raw-hwid-1',
          platform: 'ios',
          osVersion: '17.0',
          deviceModel: 'iPhone',
          userAgent: 'RezeisApp/1.0',
        },
      },
    ]);
  });
});
