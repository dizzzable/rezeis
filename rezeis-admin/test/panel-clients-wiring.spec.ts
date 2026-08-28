import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPanelClientProviders,
  PanelVersionGate,
  PANEL_COMMAND_EXECUTOR,
  PANEL_VERSION_PROBE,
} from '../src/modules/remnawave/services/panel-clients.providers';
import { PanelDevicesClient } from '../src/modules/remnawave/services/panel-devices.client';
import { PanelInfraClient } from '../src/modules/remnawave/services/panel-infra.client';
import { PanelUsersClient } from '../src/modules/remnawave/services/panel-users.client';
import { LegacyPanelRefusal } from '../src/modules/remnawave/services/panel-transport';

/**
 * The wiring, and the one shape of it that hangs the process
 * ══════════════════════════════════════════════════════════
 * There are two transports in this graph and which client gets which is not a
 * preference. The 2.x refusal must ask what version the panel is; the only
 * thing that can answer is the version probe. A probe built behind the refusal
 * therefore waits on itself, and because that lookup now sits in front of
 * EVERY panel call, the first call takes the whole integration down with it.
 *
 * Nothing about that is visible to the type checker: both transports satisfy
 * the same interface, so the wrong wiring compiles perfectly and fails only
 * against a live panel. Hence this spec. It resolves the providers the way
 * Nest would and then asserts the structural fact — the probe's transport is
 * not a refusal — rather than asserting that some call happened to return.
 */

/** Resolves the provider list by hand, in dependency order, as Nest would. */
function resolveProviders() {
  const providers = buildPanelClientProviders();
  const resolved = new Map<unknown, unknown>();
  const httpService = { request: () => undefined } as never;
  const configuration = { host: 'panel.example.test', port: 443, token: 'tok' } as never;

  for (const provider of providers) {
    const entry = provider as {
      provide: unknown;
      inject?: readonly unknown[];
      useFactory: (...args: readonly unknown[]) => unknown;
    };
    const args = (entry.inject ?? []).map((token) => {
      if (token === (httpServiceToken as unknown)) return httpService;
      // The two config/http tokens are opaque here; anything not already
      // resolved is one of them.
      return resolved.has(token) ? resolved.get(token) : pickAmbient(token, httpService, configuration);
    });
    resolved.set(entry.provide, entry.useFactory(...args));
  }
  return resolved;
}

/** Stand-ins for the two ambient tokens the factories ask Nest for. */
const httpServiceToken = Symbol('http');
function pickAmbient(token: unknown, httpService: unknown, configuration: unknown): unknown {
  const name = typeof token === 'function' ? token.name : String(token);
  return name.toLowerCase().includes('http') ? httpService : configuration;
}

describe('the panel client graph resolves the way Nest would', () => {
  it('builds every client without a cycle', () => {
    const resolved = resolveProviders();

    assert.ok(resolved.get(PANEL_VERSION_PROBE) instanceof PanelVersionGate);
    assert.ok(resolved.get(PanelUsersClient) instanceof PanelUsersClient);
    assert.ok(resolved.get(PanelDevicesClient) instanceof PanelDevicesClient);
    assert.ok(resolved.get(PanelInfraClient) instanceof PanelInfraClient);
    assert.ok(resolved.get(PANEL_COMMAND_EXECUTOR) !== undefined);
  });

  it('does NOT put the version probe behind the 2.x refusal', () => {
    const resolved = resolveProviders();
    const gate = resolved.get(PANEL_VERSION_PROBE) as { probe: { executor: { transport: unknown } } };

    // Reaching through two private fields is the point: this asserts the
    // ASSEMBLY, and the assembly is the thing that deadlocks. A test that
    // merely called a method would pass against the broken wiring too, because
    // the hang needs a real panel to manifest.
    const probeTransport = gate.probe.executor.transport;
    assert.equal(
      probeTransport instanceof LegacyPanelRefusal,
      false,
      'the probe must reach the panel directly — the refusal waits on the answer only the probe can give',
    );
  });

  it('DOES put the ordinary clients behind the refusal', () => {
    const resolved = resolveProviders();
    const executor = resolved.get(PANEL_COMMAND_EXECUTOR) as { transport: unknown };

    // The other half of the same invariant. Without it the refusal could be
    // dropped from the graph entirely and the previous test would still pass.
    assert.equal(executor.transport instanceof LegacyPanelRefusal, true);
  });
});

describe('the version gate answers “could not tell” rather than “old”', () => {
  function gateOver(versions: readonly (string | null)[], clock: { now: number }) {
    let index = 0;
    const probe = {
      readPanelVersion: async () => versions[Math.min(index++, versions.length - 1)] ?? null,
      get calls() {
        return index;
      },
    };
    return { gate: new PanelVersionGate(probe as never, () => clock.now), probe };
  }

  it('reads the major out of a version string', async () => {
    const clock = { now: 0 };
    const { gate } = gateOver(['3.3.2'], clock);
    assert.equal(await gate.readMajor(), 3);
  });

  it('returns null for a version it cannot parse, never a guess', async () => {
    const clock = { now: 0 };
    // A guess here is the dangerous outcome: `2` would refuse a healthy panel,
    // `3` would claim knowledge nobody has. Null is a state the refusal
    // already handles by proceeding.
    for (const version of ['dev', '', null]) {
      const { gate } = gateOver([version], { now: 0 });
      assert.equal(await gate.readMajor(), null, JSON.stringify(version));
    }
    void clock;
  });

  it('caches a success for minutes and a failure for seconds', async () => {
    const clock = { now: 0 };
    const { gate, probe } = gateOver([null, '3.3.2'], clock);

    assert.equal(await gate.readMajor(), null);
    clock.now = 10_000;
    // Inside the negative window: still the cached failure, no second probe.
    assert.equal(await gate.readMajor(), null);
    assert.equal(probe.calls, 1);

    clock.now = 20_000;
    // Past it. A failure is a fact about one bad moment, and holding it for
    // five minutes would keep the whole integration in its unknown mode long
    // after the panel came back.
    assert.equal(await gate.readMajor(), 3);
    assert.equal(probe.calls, 2);

    clock.now = 20_000 + 4 * 60_000;
    assert.equal(await gate.readMajor(), 3);
    assert.equal(probe.calls, 2, 'a success must not be re-probed inside its window');
  });
});
