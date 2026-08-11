import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INTERNAL_SIGNATURE_HEADER, INTERNAL_TIMESTAMP_HEADER, verifyInternalSignature } from '../src/common/http/internal-signature.util';
import { loadOlcrtcAgentConfig } from '../src/olcrtc-agent/config';
import { isExpiredSession, nextAgentLoopDelayMs } from '../src/olcrtc-agent/daemon';
import { buildInternalRequestHeaders } from '../src/olcrtc-agent/internal-client';
import { JsonOlcrtcAgentLogger, sanitizeLogValue } from '../src/olcrtc-agent/logger';
import { renderSessionCommand } from '../src/olcrtc-agent/session-command';
import { parseTrafficCounterSnapshot } from '../src/olcrtc-agent/traffic-counter';

describe('rezeis OLCRTC agent helpers', () => {
  it('builds bearer and HMAC headers for internal requests', () => {
    const body = '{"gatewayName":"agent-a"}';
    const headers = buildInternalRequestHeaders({
      apiToken: 'token-1',
      sharedSecret: 'shared-secret',
      method: 'POST',
      path: '/api/internal/olcrtc/sessions/claim',
      body,
      nowMs: 1_800_000_000_000,
    });

    assert.equal(headers.authorization, 'Bearer token-1');
    assert.equal(headers[INTERNAL_TIMESTAMP_HEADER], '1800000000000');
    assert.equal(
      verifyInternalSignature({
        secret: 'shared-secret',
        method: 'POST',
        path: '/api/internal/olcrtc/sessions/claim',
        body,
        timestamp: headers[INTERNAL_TIMESTAMP_HEADER],
        signature: headers[INTERNAL_SIGNATURE_HEADER],
        nowMs: 1_800_000_000_000,
      }).valid,
      true,
    );
  });

  it('renders session command placeholders from a claim', () => {
    const command = renderSessionCommand('publish --id {sessionId} --room "{roomUrl}" --transport {transport}', {
      sessionId: 'session-1',
      agentSessionId: 'agent-session-1',
      userId: 'user-1',
      subscriptionId: 'sub-1',
      profileId: 'profile-1',
      provider: 'jitsi',
      transport: 'vp8channel',
      cryptoKey: 'secret',
      subscriptionUri: 'olcrtc://jitsi?...',
      room: { id: 'room-1', externalRoomId: 'jitsi-room', externalUrl: 'https://meet.jit.si/jitsi-room' },
      expiresAt: null,
    });

    assert.equal(command, 'publish --id session-1 --room "https://meet.jit.si/jitsi-room" --transport vp8channel');
  });

  it('loads config from deployment environment aliases', () => {
    const config = loadOlcrtcAgentConfig({
      OLCRTC_REZEIS_BASE_URL: 'http://rezeis-admin:8000',
      OLCRTC_AGENT_API_TOKEN: 'agent-token',
      OLCRTC_AGENT_NAME: 'agent-a',
      OLCRTC_AGENT_CAPACITY: '7',
      OLCRTC_AGENT_SESSION_KILL_TIMEOUT_MS: '3000',
      OLCRTC_AGENT_TRAFFIC_COUNTER_FILE_TEMPLATE: '/run/olcrtc/{sessionId}.json',
    });

    assert.equal(config.baseUrl, 'http://rezeis-admin:8000');
    assert.equal(config.apiToken, 'agent-token');
    assert.equal(config.gatewayName, 'agent-a');
    assert.equal(config.capacity, 7);
    assert.equal(config.sessionKillTimeoutMs, 3000);
    assert.equal(config.trafficCounterFileTemplate, '/run/olcrtc/{sessionId}.json');
  });

  it('detects expired claimed sessions from control-plane leases', () => {
    assert.equal(isExpiredSession({ expiresAt: null }, 1_800_000_000_000), false);
    assert.equal(isExpiredSession({ expiresAt: '2027-01-15T08:00:01.000Z' }, Date.parse('2027-01-15T08:00:00.000Z')), false);
    assert.equal(isExpiredSession({ expiresAt: '2027-01-15T08:00:00.000Z' }, Date.parse('2027-01-15T08:00:00.000Z')), true);
  });

  it('applies bounded backoff and jitter to agent loops', () => {
    assert.equal(nextAgentLoopDelayMs(1_000, 0, 0.5), 1_000);
    assert.equal(nextAgentLoopDelayMs(1_000, 2, 0.5), 4_000);
    assert.equal(nextAgentLoopDelayMs(1_000, 6, 0), 51_200);
    assert.equal(nextAgentLoopDelayMs(30_000, 6, 1), 60_000);
  });

  it('writes structured JSON logs with stable agent fields', () => {
    const lines: string[] = [];
    const logger = new JsonOlcrtcAgentLogger({ write: (line) => lines.push(line) }, () => new Date('2027-01-15T08:00:00.000Z'));

    logger.info('session active', { sessionId: 'session-1', provider: 'JITSI' });

    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] ?? '{}'), {
      ts: '2027-01-15T08:00:00.000Z',
      component: 'rezeis-olc-agent',
      level: 'info',
      message: 'session active',
      sessionId: 'session-1',
      provider: 'JITSI',
    });
  });

  it('redacts sensitive fields from structured logs', () => {
    assert.deepEqual(sanitizeLogValue({
      apiToken: 'secret-token',
      nested: { cryptoKey: 'secret-key', safe: 'visible' },
      items: [{ password: 'secret-password' }],
    }), {
      apiToken: '[redacted]',
      nested: { cryptoKey: '[redacted]', safe: 'visible' },
      items: [{ password: '[redacted]' }],
    });
  });

  it('parses per-session traffic counter snapshots', () => {
    assert.deepEqual(parseTrafficCounterSnapshot('{"rxBytes":"123","txBytes":456}'), {
      rxBytes: 123n,
      txBytes: 456n,
    });
    assert.throws(() => parseTrafficCounterSnapshot('{"rxBytes":"-1","txBytes":0}'), /rxBytes must be a non-negative integer/u);
    assert.throws(() => parseTrafficCounterSnapshot('{"rxBytes":0}'), /txBytes must be a string or number/u);
  });
});
