/**
 * The three seams a new branding field has to cross, none of which the field's
 * own reader can vouch for.
 *
 * A review of the brand-logo change found `brandLogo` and `cardLogoStyle`
 * missing from `extractUpdatedBrandingFields`. That array is not merely the
 * audit record — `updateBrandingSettings` returns early when it comes back
 * empty, and it is the ONLY writer of the `brandingSettings` column. So a PATCH
 * carrying nothing but the new field wrote nothing, invalidated no cache, and
 * answered `200 OK` with the old settings. The operator moved a slider, saw a
 * green "Saved", and watched the control snap back. Forever.
 *
 * Every existing test passed throughout: the reader clamped correctly, the DTO
 * validated correctly, the merge merged correctly, the cabinet rendered
 * correctly. The field simply never reached any of them. That is this project's
 * recurring defect in its purest form, and the reason the guards below are
 * three-way and structural rather than one more assertion about one field.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_BRANDING } from '../src/modules/settings/interfaces/branding-settings.interface';
import { SettingsService } from '../src/modules/settings/services/settings.service';

const ROOT = join(__dirname, '..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Property names declared on `UpdateBrandingSettingsDto` itself. */
function dtoProperties(): readonly string[] {
  const source = read('src/modules/settings/dto/update-branding-settings.dto.ts');
  const start = source.indexOf('export class UpdateBrandingSettingsDto');
  assert.notEqual(start, -1, 'UpdateBrandingSettingsDto is gone or was renamed');
  // Two-space indent selects the class's own members and skips the nested
  // `*Dto` classes declared above it, whose members share the same shape.
  return [...source.slice(start).matchAll(/^ {2}public (\w+)\?:/gm)].map((match) => match[1]!);
}

/** The field names `extractUpdatedBrandingFields` filters on. */
function gateFields(): readonly string[] {
  const source = read('src/modules/settings/services/settings.service.ts');
  const start = source.indexOf('function extractUpdatedBrandingFields');
  assert.notEqual(start, -1, 'extractUpdatedBrandingFields is gone or was renamed');
  const body = source.slice(start, source.indexOf('];', start));
  return [...body.matchAll(/^ {4}'(\w+)',$/gm)].map((match) => match[1]!);
}

describe('branding field registration', () => {
  /**
   * Read from source rather than from the module. The array is typed
   * `Array<keyof UpdateBrandingSettingsDto>`, so an INCOMPLETE list is
   * perfectly well-typed and `tsc` has nothing to say about it — which is
   * exactly how two fields went missing. Nothing else in the repo can see the
   * omission either: the function is not exported.
   */
  it('gates on every field the DTO accepts', () => {
    const dto = dtoProperties();
    const gate = gateFields();
    assert.ok(dto.length > 30, `only ${dto.length} DTO properties parsed — the scan is broken`);
    assert.ok(gate.length > 30, `only ${gate.length} gate fields parsed — the scan is broken`);

    const missing = dto.filter((field) => !gate.includes(field));
    assert.deepEqual(
      missing,
      [],
      `these fields are accepted by the DTO but absent from extractUpdatedBrandingFields, so a PATCH carrying only them writes NOTHING and answers 200 OK: ${missing.join(', ')}`,
    );

    const orphaned = gate.filter((field) => !dto.includes(field));
    assert.deepEqual(
      orphaned,
      [],
      `these fields are gated on but no longer exist on the DTO, so the gate names something unreachable: ${orphaned.join(', ')}`,
    );
  });

  it('accepts exactly the fields the stored shape has', () => {
    // The third corner. A DTO field with no home in `DEFAULT_BRANDING` is
    // dropped by `readBrandingSettings`; a stored field with no DTO property
    // can never be changed by an operator.
    const dto = [...dtoProperties()].sort();
    const stored = Object.keys(DEFAULT_BRANDING).sort();
    assert.deepEqual(dto, stored);
  });
});

describe('the panel form mirrors the stored defaults', () => {
  /**
   * `branding-form-schema.ts` carries its own copy of both defaults and of
   * every bound, because the SPA cannot import from the backend's module graph.
   * Two diverged copies of one constant is a defect this project has shipped
   * before, so the copies are compared here — by parsing the SPA source, which
   * is the only direction available.
   */
  const schema = read('web/src/features/branding/branding-form-schema.ts');

  function literal(name: string): Record<string, unknown> {
    const start = schema.indexOf(`export const ${name}`);
    assert.notEqual(start, -1, `${name} is gone or was renamed`);
    const open = schema.indexOf('{', start);
    const close = schema.indexOf('}', open);
    const body = schema.slice(open + 1, close);
    const parsed: Record<string, unknown> = {};
    for (const [, key, value] of body.matchAll(/(\w+):\s*([^,\n]+),/g)) {
      const raw = value!.trim().replace(/^['"]|['"]$/g, '');
      // `null` is a value in this shape, not a string: it is how `radius` says
      // "follow the theme", and reading it as the word "null" would compare
      // equal to nothing on the backend and pass by accident tomorrow.
      parsed[key!] = raw === 'null' ? null : Number.isNaN(Number(raw)) ? raw : Number(raw);
    }
    assert.ok(Object.keys(parsed).length > 0, `${name} parsed as empty — the scan is broken`);
    return parsed;
  }

  it('uses the same brand-logo defaults the backend stores', () => {
    assert.deepEqual(literal('DEFAULT_BRAND_LOGO_DRAFT'), { ...DEFAULT_BRANDING.brandLogo });
  });

  it('uses the same card-watermark defaults the backend stores', () => {
    assert.deepEqual(literal('DEFAULT_CARD_LOGO_STYLE_DRAFT'), {
      ...DEFAULT_BRANDING.cardLogoStyle,
    });
  });

  it('makes the DTO refuse a frame the vocabulary does not contain', () => {
    // The two lists agreeing is not the same as the DTO enforcing them.
    // Deleting `@IsIn(BRAND_LOGO_FRAMES)` leaves every other guard in this file
    // green while the backend starts accepting any string as a plate name — and
    // the cabinet then silently draws `glass` for a choice the operator made.
    const dto = read('src/modules/settings/dto/update-branding-settings.dto.ts');
    const body = dto.slice(
      dto.indexOf('export class BrandLogoDto'),
      dto.indexOf('export class CardLogoStyleDto'),
    );
    assert.ok(body.length > 0, 'BrandLogoDto is gone or was renamed');
    assert.match(
      body.replace(/\r?\n\s*/g, ' '),
      /@IsIn\(BRAND_LOGO_FRAMES as readonly string\[\]\) public frame\?:/,
      'BrandLogoDto.frame no longer validates against BRAND_LOGO_FRAMES',
    );
  });

  it('offers exactly the frames the backend accepts', () => {
    const frames = /export const BRAND_LOGO_FRAMES = \[([^\]]+)\]/.exec(schema)?.[1];
    assert.ok(frames, 'BRAND_LOGO_FRAMES is gone from the form schema');
    const parsed = [...frames.matchAll(/'(\w+)'/g)].map((match) => match[1]!);
    const backend = /export const BRAND_LOGO_FRAMES = \[([^\]]+)\]/.exec(
      read('src/modules/settings/interfaces/branding-settings.interface.ts'),
    )?.[1];
    assert.ok(backend, 'BRAND_LOGO_FRAMES is gone from the interface');
    assert.deepEqual(parsed, [...backend.matchAll(/'(\w+)'/g)].map((match) => match[1]!));
  });

  it('bounds every slider exactly where the reader clamps and the DTO refuses', () => {
    // Three copies of one range: `@Min`/`@Max` on the DTO, the reader's
    // `readClampedNumber` arguments, and the slider's own min/max. A value one
    // side clamps and another rejects is a 400 the operator cannot act on.
    const bounds = /export const BRAND_LOGO_BOUNDS = \{([\s\S]*?)\n\} as const/.exec(schema)?.[1];
    assert.ok(bounds, 'BRAND_LOGO_BOUNDS is gone from the form schema');
    const util = read('src/modules/settings/utils/branding-settings.util.ts');
    const dto = read('src/modules/settings/dto/update-branding-settings.dto.ts');

    for (const [, key, min, max] of bounds.matchAll(
      /(\w+):\s*\{\s*min:\s*([\d.]+),\s*max:\s*([\d.]+)\s*\}/g,
    )) {
      // `radius` is the one bound the reader does not express as a
      // `readClampedNumber` call, because its default is `null` — "follow the
      // theme" — rather than a number. It still clamps to the same range, so
      // the range is asserted against the literals the reader really uses.
      const clamps =
        key === 'radius'
          ? new RegExp(
              `Math\\.min\\(${escapeRegExp(max!)}, Math\\.max\\(${escapeRegExp(min!)},`,
            ).test(util.replace(/\r?\n\s*/g, ' '))
          : util.includes(`readClampedNumber(value, '${key}', ${min}, ${max},`);
      assert.ok(
        clamps,
        `the reader does not clamp \`${key}\` to ${min}..${max} — the panel offers a range the backend does not honour`,
      );
      // `min`/`max` come from the source and carry decimal points, which are
      // ANY-CHARACTER in a regex: an unescaped `1.75` also matches `1075`, so
      // the guard would pass a bound whose digits had moved. Same class as a
      // literal control character standing in for a word boundary — a rule
      // that reads correct and cannot fire.
      const property = new RegExp(
        `@Min\\(${escapeRegExp(min!)}\\)\\s*@Max\\(${escapeRegExp(max!)}\\)\\s*public ${key}\\?:`,
      );
      assert.ok(
        property.test(dto.replace(/\r?\n\s*/g, ' ').replace(/ +/g, ' ')),
        `the DTO does not bound \`${key}\` to ${min}..${max} — a value the slider can produce is rejected, or one it cannot is accepted`,
      );
    }
  });
});

describe('a logo-only save reaches the database', () => {
  /**
   * The seam the field's own spec cannot see. `branding-logo-presentation.spec.ts`
   * drives merge → JSON → read, which is three of the FOUR steps
   * `SettingsService.updateBrandingSettings` performs; the fourth is the gate,
   * and the gate was the broken one. This drives the real service.
   */
  function harness(): {
    readonly service: SettingsService;
    readonly updateCalls: Array<Record<string, unknown>>;
    readonly auditEntries: Array<Record<string, unknown>>;
  } {
    const auditEntries: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    const existing = {
      id: 'settings-1',
      brandingSettings: null,
      updatedAt: new Date('2026-08-19T12:00:00.000Z'),
    };
    const transactionClient = {
      settings: {
        findFirst: async () => existing,
        create: async () => {
          throw new Error('settings row already exists');
        },
        update: async (args: Record<string, unknown>) => {
          updateCalls.push(args);
          const data = args['data'] as Record<string, unknown>;
          return { ...existing, brandingSettings: data['brandingSettings'] };
        },
      },
      adminAuditLog: {
        create: async (args: { readonly data: Record<string, unknown> }) => {
          auditEntries.push(args.data);
        },
      },
    };
    const prismaService = {
      settings: transactionClient.settings,
      $transaction: async <T>(
        callback: (client: typeof transactionClient) => Promise<T>,
      ): Promise<T> => callback(transactionClient),
    };
    return {
      service: new SettingsService(
        prismaService as never,
        {} as never,
        { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
      ),
      updateCalls,
      auditEntries,
    };
  }

  async function save(
    dto: Record<string, unknown>,
  ): Promise<{
    readonly writes: number;
    readonly audited: readonly string[];
    readonly result: Awaited<ReturnType<SettingsService['updateBrandingSettings']>>;
  }> {
    const { service, updateCalls, auditEntries } = harness();
    const result = await service.updateBrandingSettings({
      currentAdmin: { id: 'admin-1' } as never,
      requestMetadata: {
        requestId: 'request-logo-1',
        remoteAddress: '203.0.113.8',
        userAgent: 'branding-logo-contract-spec',
      },
      updateBrandingSettingsDto: dto as never,
    });
    return {
      writes: updateCalls.length,
      audited: ((auditEntries[0]?.['metadata'] as Record<string, unknown>)?.[
        'updatedFields'
      ] ?? []) as readonly string[],
      result,
    };
  }

  it('writes a brandLogo-only patch and names it in the audit trail', async () => {
    const saved = await save({
      brandLogo: { size: 1.6, fill: 0.95, frame: 'none', radius: 4, glow: 0 },
    });
    assert.equal(saved.writes, 1, 'the save never reached the database');
    assert.deepEqual(saved.audited, ['brandLogo']);
    assert.deepEqual(saved.result.brandLogo, {
      size: 1.6,
      fill: 0.95,
      frame: 'none',
      radius: 4,
      glow: 0,
    });
  });

  it('writes a cardLogoStyle-only patch and names it in the audit trail', async () => {
    const saved = await save({ cardLogoStyle: { scale: 1.75, opacity: 0.28 } });
    assert.equal(saved.writes, 1, 'the save never reached the database');
    assert.deepEqual(saved.audited, ['cardLogoStyle']);
    assert.deepEqual(saved.result.cardLogoStyle, { scale: 1.75, opacity: 0.28 });
  });

  it('still refuses a patch that carries no branding field at all', async () => {
    // The gate has a job; widening it must not disable it. An empty body is
    // still a no-op rather than a write and an audit row.
    const saved = await save({});
    assert.equal(saved.writes, 0);
    assert.deepEqual(saved.audited, []);
  });
});
