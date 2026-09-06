import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';

import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import { extractUpdatedBrandingFields } from '../src/modules/settings/services/settings.service';
import { DEFAULT_BRANDING } from '../src/modules/settings/interfaces/branding-settings.interface';

/**
 * Every branding field the API accepts can actually cause a write.
 *
 * `updateBrandingSettings` asks `extractUpdatedBrandingFields` what changed and
 * RETURNS EARLY when the answer is empty. That list is hand-written, so a field
 * added to the DTO and forgotten there validates, arrives, merges into nothing
 * and is answered `200 OK` — the operator is told the save succeeded, the
 * setting reverts on the next read, and there is no error anywhere to look at.
 * It is the same shape of silence as a reader that drops a value, one stage
 * earlier.
 *
 * The check is derived from the branding defaults rather than from a second
 * hand-written list, so a new field fails here until somebody adds it to the
 * gate. A list of expected names would be the very thing this is guarding
 * against.
 */

/**
 * Branding fields that are READ-ONLY on the API and correctly absent from the
 * update gate. Each one is derived or owned elsewhere, never patched directly.
 */
const NOT_PATCHABLE = new Set<string>([]);

/** A value the DTO will accept for each field, so the property is really set. */
function sampleFor(field: string): unknown {
  const shipped = (DEFAULT_BRANDING as unknown as Record<string, unknown>)[field];
  return shipped;
}

describe('branding update gate', () => {
  const fields = Object.keys(DEFAULT_BRANDING).filter((f) => !NOT_PATCHABLE.has(f));

  it('has fields to check', () => {
    // Anchors everything below: a `DEFAULT_BRANDING` that stopped being written
    // would leave this file iterating nothing and passing.
    assert.ok(fields.length > 20, `expected the branding defaults to be populated, got ${fields.length}`);
  });

  it('counts every settable field as a change', () => {
    const ungated: string[] = [];
    for (const field of fields) {
      const dto = plainToInstance(UpdateBrandingSettingsDto, { [field]: sampleFor(field) });
      // Only ask about fields the DTO itself keeps. One it drops is not part of
      // the update contract and is not this gate's problem.
      if (!Object.prototype.hasOwnProperty.call(dto, field)) continue;
      if (!extractUpdatedBrandingFields(dto).includes(field)) ungated.push(field);
    }
    assert.deepEqual(
      ungated,
      [],
      `these fields are accepted by the DTO but not counted as a change, so a save that touches only them writes nothing and still reports success: ${ungated.join(', ')}`,
    );
  });

  it('counts the servers globe, which is what this file was added for', () => {
    const dto = plainToInstance(UpdateBrandingSettingsDto, {
      serversGlobe: { enabled: true, variant: 'dither-globe', props: { pixel: 8 } },
    });
    assert.deepEqual(extractUpdatedBrandingFields(dto), ['serversGlobe']);
  });

  it('counts nothing when nothing was sent', () => {
    // The early return this gate feeds is correct behaviour for an empty patch;
    // it is only wrong when a real change reads as empty.
    assert.deepEqual(extractUpdatedBrandingFields(plainToInstance(UpdateBrandingSettingsDto, {})), []);
  });
});
