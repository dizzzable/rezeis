import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TRIAL_SETTINGS,
  evaluateTrialClaim,
  readTrialSettings,
  serializeTrialSettings,
} from '../src/modules/plans/utils/trial-settings.util';

describe('trial-settings: requireTelegramLink', () => {
  it('defaults requireTelegramLink to false (backward compatible)', () => {
    assert.equal(DEFAULT_TRIAL_SETTINGS.requireTelegramLink, false);
    assert.equal(readTrialSettings({ maxClaims: 1, free: true }).requireTelegramLink, false);
    assert.equal(readTrialSettings(null).requireTelegramLink, false);
  });

  it('reads + serializes requireTelegramLink round-trip', () => {
    const read = readTrialSettings({ maxClaims: 2, free: false, availabilityScope: 'ALL', requireTelegramLink: true });
    assert.equal(read.requireTelegramLink, true);
    const serialized = serializeTrialSettings(read) as Record<string, unknown>;
    assert.equal(serialized.requireTelegramLink, true);
  });

  it('denies a user without Telegram when requireTelegramLink is on', () => {
    const settings = { maxClaims: 1, free: true, availabilityScope: 'ALL' as const, requireTelegramLink: true };
    const denied = evaluateTrialClaim(settings, { priorTrialClaims: 0, isInvited: true, hasTelegram: false });
    assert.deepEqual(denied, { allowed: false, reason: 'TRIAL_REQUIRES_TELEGRAM' });

    const allowed = evaluateTrialClaim(settings, { priorTrialClaims: 0, isInvited: true, hasTelegram: true });
    assert.deepEqual(allowed, { allowed: true, reason: null });
  });

  it('does not require Telegram when the toggle is off', () => {
    const settings = { maxClaims: 1, free: true, availabilityScope: 'ALL' as const, requireTelegramLink: false };
    const result = evaluateTrialClaim(settings, { priorTrialClaims: 0, isInvited: true, hasTelegram: false });
    assert.deepEqual(result, { allowed: true, reason: null });
  });

  it('already-used takes precedence over the telegram gate', () => {
    const settings = { maxClaims: 1, free: true, availabilityScope: 'ALL' as const, requireTelegramLink: true };
    const result = evaluateTrialClaim(settings, { priorTrialClaims: 1, isInvited: true, hasTelegram: false });
    assert.deepEqual(result, { allowed: false, reason: 'TRIAL_ALREADY_USED' });
  });
});
