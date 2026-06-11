import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AccessMode } from '@prisma/client';
import fc from 'fast-check';

import {
  AccessModeGate,
  AccessModeGuard,
} from '../src/modules/settings/services/access-mode-guard.service';

const ALL_MODES: readonly AccessMode[] = [
  AccessMode.PUBLIC,
  AccessMode.INVITED,
  AccessMode.PURCHASE_BLOCKED,
  AccessMode.REG_BLOCKED,
  AccessMode.RESTRICTED,
];

const ALL_GATES: readonly AccessModeGate[] = [
  'register',
  'login',
  'purchase.new',
  'purchase.upgrade',
  'purchase.addon',
  'purchase.renewal',
  'subscription.mutate',
];

describe('AccessModeGuard.evaluate', () => {
  const guard = new AccessModeGuard();

  it('PUBLIC passes every gate', () => {
    for (const gate of ALL_GATES) {
      const result = guard.evaluate({ gate, mode: AccessMode.PUBLIC, hasInvite: false });
      assert.equal(result, null, `gate=${gate} should pass under PUBLIC`);
    }
  });

  it('RESTRICTED rejects every gate with SERVICE_RESTRICTED (503)', () => {
    for (const gate of ALL_GATES) {
      for (const hasInvite of [true, false]) {
        const result = guard.evaluate({ gate, mode: AccessMode.RESTRICTED, hasInvite });
        assert.deepEqual(
          { code: result?.code, status: result?.status },
          { code: 'SERVICE_RESTRICTED', status: 503 },
          `gate=${gate} hasInvite=${hasInvite} should be SERVICE_RESTRICTED under RESTRICTED`,
        );
      }
    }
  });

  // ── INVITED ────────────────────────────────────────────────────────────────

  it('INVITED with hasInvite=true passes register; without rejects with INVITE_REQUIRED', () => {
    const withInvite = guard.evaluate({ gate: 'register', mode: AccessMode.INVITED, hasInvite: true });
    assert.equal(withInvite, null);

    const withoutInvite = guard.evaluate({ gate: 'register', mode: AccessMode.INVITED, hasInvite: false });
    assert.deepEqual(
      { code: withoutInvite?.code, status: withoutInvite?.status },
      { code: 'INVITE_REQUIRED', status: 403 },
    );
  });

  it('INVITED passes every non-register gate', () => {
    for (const gate of ALL_GATES.filter((g) => g !== 'register')) {
      const result = guard.evaluate({ gate, mode: AccessMode.INVITED, hasInvite: false });
      assert.equal(result, null, `gate=${gate} should pass under INVITED`);
    }
  });

  // ── PURCHASE_BLOCKED ───────────────────────────────────────────────────────

  it('PURCHASE_BLOCKED rejects new/upgrade/addon, allows renewal + register + login + mutate', () => {
    const blocked: readonly AccessModeGate[] = ['purchase.new', 'purchase.upgrade', 'purchase.addon'];
    for (const gate of blocked) {
      const result = guard.evaluate({ gate, mode: AccessMode.PURCHASE_BLOCKED });
      assert.deepEqual(
        { code: result?.code, status: result?.status },
        { code: 'PURCHASES_DISABLED', status: 403 },
        `gate=${gate} should be PURCHASES_DISABLED under PURCHASE_BLOCKED`,
      );
    }

    const allowed: readonly AccessModeGate[] = ['register', 'login', 'purchase.renewal', 'subscription.mutate'];
    for (const gate of allowed) {
      const result = guard.evaluate({ gate, mode: AccessMode.PURCHASE_BLOCKED, hasInvite: false });
      assert.equal(result, null, `gate=${gate} should pass under PURCHASE_BLOCKED`);
    }
  });

  // ── REG_BLOCKED ────────────────────────────────────────────────────────────

  it('REG_BLOCKED rejects register with REGISTRATION_DISABLED regardless of hasInvite', () => {
    for (const hasInvite of [true, false]) {
      const result = guard.evaluate({ gate: 'register', mode: AccessMode.REG_BLOCKED, hasInvite });
      assert.deepEqual(
        { code: result?.code, status: result?.status },
        { code: 'REGISTRATION_DISABLED', status: 403 },
        `hasInvite=${hasInvite} should still be REGISTRATION_DISABLED`,
      );
    }
  });

  it('REG_BLOCKED passes every non-register gate', () => {
    for (const gate of ALL_GATES.filter((g) => g !== 'register')) {
      const result = guard.evaluate({ gate, mode: AccessMode.REG_BLOCKED });
      assert.equal(result, null, `gate=${gate} should pass under REG_BLOCKED`);
    }
  });

  // ── Properties ─────────────────────────────────────────────────────────────

  it('Property 3: renewal gate passes under every non-RESTRICTED mode', () => {
    for (const mode of ALL_MODES) {
      const result = guard.evaluate({ gate: 'purchase.renewal', mode });
      if (mode === AccessMode.RESTRICTED) {
        assert.equal(result?.code, 'SERVICE_RESTRICTED');
      } else {
        assert.equal(result, null, `renewal under ${mode} should pass`);
      }
    }
  });

  it('Property 4: REG_BLOCKED is bypass-proof — register always rejected', () => {
    fc.assert(
      fc.property(fc.boolean(), (hasInvite) => {
        const result = guard.evaluate({
          gate: 'register',
          mode: AccessMode.REG_BLOCKED,
          hasInvite,
        });
        assert.equal(result?.code, 'REGISTRATION_DISABLED');
        assert.equal(result?.status, 403);
      }),
      { numRuns: 50 },
    );
  });

  it('Property: every (mode, gate) combination is total — never throws, returns rejection or null', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<AccessMode>(...ALL_MODES),
        fc.constantFrom<AccessModeGate>(...ALL_GATES),
        fc.boolean(),
        (mode, gate, hasInvite) => {
          const result = guard.evaluate({ gate, mode, hasInvite });
          // null or a valid rejection.
          if (result !== null) {
            assert.match(result.code, /^[A-Z_]+$/);
            assert.ok(result.status === 403 || result.status === 503);
            assert.ok(typeof result.message === 'string' && result.message.length > 0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('PUBLIC + RESTRICTED are extremes: PUBLIC never rejects, RESTRICTED always rejects', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<AccessModeGate>(...ALL_GATES),
        fc.boolean(),
        (gate, hasInvite) => {
          const pub = guard.evaluate({ gate, mode: AccessMode.PUBLIC, hasInvite });
          assert.equal(pub, null);
          const restricted = guard.evaluate({
            gate,
            mode: AccessMode.RESTRICTED,
            hasInvite,
          });
          assert.equal(restricted?.code, 'SERVICE_RESTRICTED');
          assert.equal(restricted?.status, 503);
        },
      ),
      { numRuns: 100 },
    );
  });
});
