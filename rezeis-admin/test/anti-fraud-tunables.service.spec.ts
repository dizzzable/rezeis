import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

import {
  AntiFraudTunablesService,
  AntiFraudTunablesUnavailableError,
} from '../src/modules/anti-fraud/services/anti-fraud-tunables.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import { resolveAntiFraudTunables } from '../src/modules/settings/utils/anti-fraud-settings.util';

function serviceReading(read: () => Promise<unknown>): AntiFraudTunablesService {
  return new AntiFraudTunablesService({
    getAntiFraudTunablesRuntime: read,
  } as unknown as SettingsService);
}

/** Captures `Logger.prototype.error` for the duration of `run`. */
async function withCapturedErrors(run: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const original = Logger.prototype.error;
  Logger.prototype.error = function patched(message: unknown): void {
    captured.push(String(message));
  } as typeof Logger.prototype.error;
  try {
    await run();
  } finally {
    Logger.prototype.error = original;
  }
  return captured;
}

describe('AntiFraudTunablesService', () => {
  it('hands back exactly what the settings service resolved', async () => {
    const expected = resolveAntiFraudTunables(
      { sharing: { ipWindowMinutes: 45 } },
      { ANTIFRAUD_NODE_TRAFFIC_MIN_GB: '500' },
    );
    const actual = await serviceReading(async () => expected).resolve();
    assert.deepEqual(actual, expected);
    assert.equal(actual.sharing.ipWindowMinutes, 45);
    assert.equal(actual.trafficAbuse.minGb, 500);
  });

  it('does not cache: a second call sees a value changed between runs', async () => {
    // The 5-second bounded-staleness cache lives in SettingsService, deliberately
    // not here — a second cache would be a second staleness budget and the thing
    // most likely to let the API container and the worker disagree.
    let minGb = 200;
    const service = serviceReading(async () => resolveAntiFraudTunables({ trafficAbuse: { minGb } }, {}));
    assert.equal((await service.resolve()).trafficAbuse.minGb, 200);
    minGb = 900;
    assert.equal((await service.resolve()).trafficAbuse.minGb, 900);
  });

  it('throws a named error when the settings row cannot be read', async () => {
    const service = serviceReading(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await assert.rejects(
      () => service.resolve(),
      (error: unknown) => {
        assert.ok(
          error instanceof AntiFraudTunablesUnavailableError,
          'a read failure must be distinguishable from a panel-API failure',
        );
        assert.match((error as Error).message, /connection terminated unexpectedly/);
        return true;
      },
    );
  });

  it('never answers a failed read with values — least of all range floors', async () => {
    const service = serviceReading(async () => {
      throw new Error('database is down');
    });
    const outcome = await service.resolve().then(
      (value) => ({ kind: 'returned' as const, value }),
      () => ({ kind: 'threw' as const, value: undefined }),
    );
    assert.equal(
      outcome.kind,
      'threw',
      'a failed read that returns anything at all is the bug this guards: the ' +
        `caller would run the detectors on a fabricated config (${JSON.stringify(outcome.value)})`,
    );
  });

  it('says out loud why it refuses to fall back', async () => {
    const errors = await withCapturedErrors(async () => {
      await serviceReading(async () => {
        throw new Error('boom');
      })
        .resolve()
        .catch(() => undefined);
    });
    assert.equal(errors.length, 1, 'exactly one line, naming the cause');
    assert.match(errors[0], /unreadable/);
    assert.match(errors[0], /turned off/, 'the log has to explain WHY env is not a safe fallback');
  });
});
