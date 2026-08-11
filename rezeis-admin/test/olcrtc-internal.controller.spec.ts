import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalAdminAuthGuard } from '../src/modules/auth/guards/internal-admin-auth.guard';
import { OlcrtcInternalController } from '../src/modules/olcrtc/olcrtc.internal.controller';

describe('OlcrtcInternalController', () => {
  it('is guarded by internal API-token auth', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, OlcrtcInternalController),
      [InternalAdminAuthGuard],
    );
  });

  it('maps Reiwa and agent routes under the internal OLCRTC boundary', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, OlcrtcInternalController), 'internal/olcrtc');
    assertRoute(OlcrtcInternalController.prototype.getSubscription, 'subscription', RequestMethod.GET);
    assertRoute(OlcrtcInternalController.prototype.provisionSubscription, 'subscription/provision', RequestMethod.POST);
    assertRoute(OlcrtcInternalController.prototype.recordGatewayHeartbeat, 'gateways/heartbeat', RequestMethod.POST);
    assertRoute(OlcrtcInternalController.prototype.claimSession, 'sessions/claim', RequestMethod.POST);
    assertRoute(OlcrtcInternalController.prototype.reportSession, 'sessions/:sessionId/report', RequestMethod.POST);
    assertRoute(OlcrtcInternalController.prototype.recordTraffic, 'sessions/:sessionId/traffic', RequestMethod.POST);
  });

  it('delegates Reiwa-facing and agent-facing payloads without rewriting them', async () => {
    const calls: unknown[] = [];
    const controller = new OlcrtcInternalController({
      getSubscription: async (query: unknown) => {
        calls.push(['getSubscription', query]);
        return { status: 'disabled', subscription: null, refreshAfterSeconds: 60 };
      },
      provisionSubscription: async (query: unknown) => {
        calls.push(['provisionSubscription', query]);
        return { status: 'pending', subscription: null, refreshAfterSeconds: 10 };
      },
      recordGatewayHeartbeat: async (body: unknown) => {
        calls.push(['recordGatewayHeartbeat', body]);
        return { id: 'gateway-1' };
      },
      claimAgentSession: async (body: unknown) => {
        calls.push(['claimAgentSession', body]);
        return { sessionId: 'session-1' };
      },
      reportAgentSession: async (sessionId: string, body: unknown) => {
        calls.push(['reportAgentSession', sessionId, body]);
        return { id: sessionId };
      },
      recordTraffic: async (sessionId: string, body: unknown) => {
        calls.push(['recordTraffic', sessionId, body]);
        return { id: 'ledger-1' };
      },
    } as never);

    assert.deepStrictEqual(await controller.getSubscription({ userId: 'user-1' }), { status: 'disabled', subscription: null, refreshAfterSeconds: 60 });
    assert.deepStrictEqual(await controller.provisionSubscription({ userId: 'user-1' }), { status: 'pending', subscription: null, refreshAfterSeconds: 10 });
    assert.deepStrictEqual(await controller.recordGatewayHeartbeat({ name: 'gateway-a' } as never), { id: 'gateway-1' });
    assert.deepStrictEqual(await controller.claimSession({ gatewayName: 'gateway-a' } as never), { sessionId: 'session-1' });
    assert.deepStrictEqual(await controller.reportSession('session-1', { status: 'ACTIVE' } as never), { id: 'session-1' });
    assert.deepStrictEqual(await controller.recordTraffic('session-1', { rxBytes: '1', txBytes: '2' } as never), { id: 'ledger-1' });

    assert.deepStrictEqual(calls, [
      ['getSubscription', { userId: 'user-1' }],
      ['provisionSubscription', { userId: 'user-1' }],
      ['recordGatewayHeartbeat', { name: 'gateway-a' }],
      ['claimAgentSession', { gatewayName: 'gateway-a' }],
      ['reportAgentSession', 'session-1', { status: 'ACTIVE' }],
      ['recordTraffic', 'session-1', { rxBytes: '1', txBytes: '2' }],
    ]);
  });
});

function assertRoute(method: unknown, path: string, requestMethod: RequestMethod): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
}
