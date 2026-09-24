import { after, before } from 'node:test';

import {
  ADD_ON_ROLLOUT_FLAG_DEFAULTS,
  type AddOnRolloutFlagName,
} from '../../src/modules/add-on-entitlements/add-on-rollout.config';

/** Every `ADDON_*` rollout variable the resolver reads. */
export const ADD_ON_ROLLOUT_FLAG_NAMES = Object.keys(ADD_ON_ROLLOUT_FLAG_DEFAULTS) as AddOnRolloutFlagName[];

/**
 * Pins EVERY `ADDON_*` rollout flag OFF, explicitly, for the whole spec file
 * that calls it (at its top level) — and puts the environment back afterwards.
 *
 * For a spec written against the legacy path: payments that raise the columns,
 * no term, no projection, no ledger. Until 24.09.2026 that was simply what an
 * unset environment meant; since the flip stages 1, 2 and 6 are ON by default,
 * so such a spec has to SAY it runs with them off, or its hand-built fakes meet
 * the model's code paths (`$queryRaw` row locks, terms, projections) they were
 * never shaped for. The model's own behaviour is pinned by its own specs, most
 * of them against PostgreSQL.
 *
 * A case inside the file may still switch a single stage on around its own run;
 * it then restores this pinned value, not an unset one.
 */
export function pinAddOnStagesOffForThisFile(): void {
  const previous = new Map<string, string | undefined>();
  before(() => {
    for (const name of ADD_ON_ROLLOUT_FLAG_NAMES) {
      previous.set(name, process.env[name]);
      process.env[name] = 'false';
    }
  });
  after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
