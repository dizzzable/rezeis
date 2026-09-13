import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as contractPanel27 from '@remnawave/contract-panel-2.7';
import * as contractPanel28 from '@remnawave/contract-panel-2.8';
import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';

import { SUBSCRIPTION_UA_TUNABLE_RANGES } from '../src/modules/anti-fraud/subscription-ua-detection.config';

/**
 * The subscription-UA page size can be set only to values every supported
 * panel release accepts.
 *
 * WHY THIS SPEC EXISTS.
 *
 * The detector sends the tunable as `size` on
 * `GET /api/subscription-request-history`, and the panel validates that query
 * itself. The tunable's ceiling was 2000 while every release, 2.7 through 3.4,
 * caps `size` at 1000. An operator could save 1500, the form and the PATCH
 * validator agreed it was fine, and from then on the panel refused the detector
 * on every run. The only trace was a WARN saying the request log "is not
 * readable"; the detector saw nothing and said so nowhere an operator looks.
 *
 * Nothing else compares the two numbers. Our command table deliberately does
 * not validate this query (`UNVALIDATED_QUERIES` in
 * `panel-command-conformance.spec.ts`), and the range lives in the anti-fraud
 * config, far from the panel client.
 *
 * The oracles are the contracts the releases ship, per the vendor's own table
 * (see `panel-command-conformance.spec.ts`), including the 2.x lines still in
 * the field.
 */

interface VendorQuerySchema {
  safeParse(input: unknown): { readonly success: boolean };
}

interface RequestHistoryContract {
  readonly GetSubscriptionRequestHistoryCommand: {
    readonly RequestQuerySchema: VendorQuerySchema;
  };
}

const ORACLES: ReadonlyArray<readonly [release: string, contract: RequestHistoryContract]> = [
  ['2.7.3–2.7.4', contractPanel27],
  ['2.8.x', contractPanel28],
  ['3.2.0–3.2.1', contractPanel321],
  ['3.2.3', contractPanel323],
  ['3.3.x', contractPanel33],
  ['3.4.0–3.4.3', contractPanel343],
  ['3.4.4', contractPanel344],
];

const RANGE = SUBSCRIPTION_UA_TUNABLE_RANGES.uaRequestPageSize;

function accepts(contract: RequestHistoryContract, size: number): boolean {
  return contract.GetSubscriptionRequestHistoryCommand.RequestQuerySchema.safeParse({ start: 0, size })
    .success;
}

describe('uaRequestPageSize against the panel request log size cap', () => {
  for (const [release, contract] of ORACLES) {
    it(`panel ${release} accepts the tunable's floor, default and ceiling`, () => {
      for (const size of [RANGE.min, RANGE.default, RANGE.max]) {
        assert.equal(
          accepts(contract, size),
          true,
          `panel ${release} refuses size=${size}, which uaRequestPageSize allows: a saved value ` +
            'would be refused on every detector run',
        );
      }
    });
  }

  it('sits at the panel ceiling rather than below it', () => {
    // Not a safety requirement: a lower ceiling would be safe. But this knob is
    // the operator's only lever over how much of the evidence window one run
    // covers, so its ceiling should be the panel's, not an arbitrary lower one.
    // If every supported release raises the cap, raise the tunable with it.
    const refusing = ORACLES.filter(([, contract]) => !accepts(contract, RANGE.max + 1));
    assert.ok(
      refusing.length > 0,
      `every supported panel accepts size=${RANGE.max + 1}; uaRequestPageSize can come up`,
    );
  });
});
