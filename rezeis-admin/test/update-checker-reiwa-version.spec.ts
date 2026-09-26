import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReiwaPeerRegistry } from '../src/modules/reiwa-peers/reiwa-peer-registry.service';
import { UpdateCheckerService } from '../src/modules/update-checker/services/update-checker.service';

/**
 * Reiwa's version in the updates menu after a panel restart (review R1, "could
 * not confirm"). The check at boot can run while the panel's cache is still
 * connecting; it then knows no version, and with `REIWA_URL` unreachable it
 * cached «0.0.0» for the hour. The version the panel has on record is read on
 * every status call instead, so the first call that can read it shows it.
 */

/** The registry as the checker sees it; `state` is what the panel's cache holds right now. */
function registryAnswering() {
  const state = { recorded: null as string | null, behind: [] as string[] };
  const peers = {
    runningVersion: async () => state.recorded,
    behindSurfaces: async () => state.behind,
    observeHealth: async () => undefined,
  } as unknown as ReiwaPeerRegistry;
  return { state, peers };
}

describe('UpdateCheckerService: Reiwa’s running version', () => {
  it('shows the recorded version on the next call, though the check at boot could read none', async () => {
    // No HTTP client: no GitHub and no /health — the unreachable REIWA_URL case.
    const { state, peers } = registryAnswering();
    const checker = new UpdateCheckerService(undefined, peers);

    const atBoot = await checker.getStatus();
    assert.equal(atBoot.components.reiwa.current, '0.0.0', 'fixture: the cache was not readable at boot');

    state.recorded = '0.9.7.53';
    const next = await checker.getStatus();
    assert.equal(next.components.reiwa.current, '0.9.7.53', 'within the hour the check is cached for');
    assert.equal(next.components.reiwa.hasUpdate, false);
  });

  it('keeps the checked result when nothing is on record', async () => {
    const { peers } = registryAnswering();
    const checker = new UpdateCheckerService(undefined, peers);
    await checker.getStatus();
    assert.equal((await checker.getStatus()).components.reiwa.current, '0.0.0');
  });

  it('says the cabinet is behind when the registry does, and not otherwise', async () => {
    const { state, peers } = registryAnswering();
    const checker = new UpdateCheckerService(undefined, peers);
    assert.equal((await checker.getStatus()).components.reiwa.behindPanel, false);
    state.behind = ['api'];
    assert.equal((await checker.getStatus()).components.reiwa.behindPanel, true);
  });
});
