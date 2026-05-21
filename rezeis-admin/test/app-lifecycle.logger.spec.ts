import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Logger } from '@nestjs/common';

import {
  AppLifecycleLogger,
  normalizeShutdownSignal,
} from '../src/common/lifecycle/app-lifecycle.logger';

const originalLog = Logger.prototype.log;

afterEach(() => {
  Logger.prototype.log = originalLog;
});

describe('app lifecycle logger', () => {
  it('normalizes shutdown signals to a bounded set', () => {
    assert.equal(normalizeShutdownSignal('SIGINT'), 'SIGINT');
    assert.equal(normalizeShutdownSignal('SIGTERM'), 'SIGTERM');
    assert.equal(normalizeShutdownSignal('SIGBREAK'), 'SIGBREAK');
    assert.equal(normalizeShutdownSignal(undefined), 'UNKNOWN');
    assert.equal(normalizeShutdownSignal('token-secret-signal'), 'UNKNOWN');
    assert.equal(normalizeShutdownSignal('SIGTERM;token=raw-secret'), 'UNKNOWN');
  });

  it('logs shutdown lifecycle phases without raw unknown signal values', () => {
    const logs: string[] = [];
    Logger.prototype.log = function log(message: unknown): void {
      logs.push(String(message));
    };
    const lifecycleLogger = new AppLifecycleLogger();

    lifecycleLogger.beforeApplicationShutdown('token-secret-signal');
    lifecycleLogger.onApplicationShutdown('SIGTERM');

    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /Application shutdown started; signal=UNKNOWN/);
    assert.match(logs[1]!, /Application shutdown completed; signal=SIGTERM/);
    assert.doesNotMatch(logs.join('\n'), /token-secret-signal/);
    assert.doesNotMatch(logs.join('\n'), /raw-secret/);
  });
});
