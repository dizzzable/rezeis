import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type ArgumentsHost, BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { AdminSafeExceptionFilter } from '../src/common/filters/admin-safe-exception.filter';
import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import { readProfileNamingConfig } from '../src/modules/profile-sync/remnawave-profile-naming.service';

/**
 * «Настройки панели → Кастомизация → Именование профилей Remnawave».
 *
 * The three parts are glued into a Remnawave username, and Remnawave accepts
 * `^[A-Za-z0-9_-]+$` and nothing else on every version. The DTO used to check
 * LENGTH only, so `prefix: "my shop"` was stored — and from then on every
 * profile CREATE was refused by the panel.
 */

async function namingErrors(profileNaming: Record<string, unknown>): Promise<readonly ValidationError[]> {
  const dto = plainToInstance(UpdateBrandingSettingsDto, { profileNaming });
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

/** `profileNaming.<field>` for every failing field. */
function failedFields(errors: readonly ValidationError[]): readonly string[] {
  return errors.flatMap((error) =>
    (error.children ?? [])
      .filter((child) => child.constraints !== undefined)
      .map((child) => `${error.property}.${child.property}`),
  );
}

function messages(errors: readonly ValidationError[]): readonly string[] {
  return errors.flatMap((error) =>
    (error.children ?? []).flatMap((child) => Object.values(child.constraints ?? {})),
  );
}

const ACCEPTED: ReadonlyArray<Record<string, string>> = [
  { prefix: 'rz', separator: '_', suffixBase: 'sub' },
  { prefix: 'my-shop_2', separator: '--', suffixBase: 'VPN' },
  { prefix: 'P'.repeat(16), separator: '__', suffixBase: 'S'.repeat(32) },
  { prefix: 'a', separator: '-', suffixBase: 'b' },
  { prefix: 'shop' },
];

describe('ProfileNamingDto — only what Remnawave accepts in a username', () => {
  for (const profileNaming of ACCEPTED) {
    it(`accepts ${JSON.stringify(profileNaming)}`, async () => {
      assert.deepEqual(failedFields(await namingErrors(profileNaming)), []);
    });
  }

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['prefix', 'my shop'],
    ['prefix', 'my.shop'],
    ['prefix', 'магазин'],
    ['prefix', '@rz'],
    ['prefix', ''],
    ['prefix', 'x'.repeat(17)],
    ['separator', '.'],
    ['separator', ' '],
    ['separator', ''],
    ['separator', '___'],
    ['suffixBase', 'sub!'],
    ['suffixBase', 'под'],
    ['suffixBase', ''],
    ['suffixBase', 's'.repeat(33)],
  ];
  for (const [field, value] of refused) {
    it(`refuses ${field} ${JSON.stringify(value.length > 20 ? `${value.slice(0, 5)}…(${value.length})` : value)}`, async () => {
      const errors = await namingErrors({ [field]: value });
      assert.deepEqual(failedFields(errors), [`profileNaming.${field}`]);
    });
  }

  it('says what is allowed, in words an operator can act on', async () => {
    const [text] = messages(await namingErrors({ prefix: 'my shop' }));
    assert.match(text ?? '', /Latin letters, digits, "_" and "-"/);
    assert.match(text ?? '', /1-16/);
  });

  it('answers a bad part with a 400 that NAMES the field and the rule — through the real pipe and the real filter', async () => {
    // The pipe as `main.ts` configures it, then the global filter as the wire
    // sees it. The filter scrubs any message containing a word it considers
    // sensitive and says "Request failed" instead — a refusal that names
    // nothing is the silent gate the settings form must never meet.
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    for (const [field, value] of [
      ['prefix', 'my shop'],
      ['separator', '.'],
      ['suffixBase', 'sub!'],
    ] as const) {
      let refusal: unknown = null;
      try {
        await pipe.transform({ profileNaming: { [field]: value } }, {
          type: 'body',
          metatype: UpdateBrandingSettingsDto,
          data: '',
        });
      } catch (error) {
        refusal = error;
      }
      assert.ok(refusal instanceof BadRequestException, `${field}: refused with a 400`);

      let status: number | undefined;
      let body: { message?: unknown } | undefined;
      const response = {
        status(code: number) {
          status = code;
          return response;
        },
        json(payload: { message?: unknown }) {
          body = payload;
          return response;
        },
      };
      new AdminSafeExceptionFilter().catch(refusal, {
        switchToHttp: () => ({
          getRequest: () => ({ originalUrl: '/api/admin/settings/branding', headers: {} }),
          getResponse: () => response,
        }),
      } as unknown as ArgumentsHost);

      assert.equal(status, 400);
      const lines = Array.isArray(body?.message) ? (body?.message as unknown[]) : [body?.message];
      const named = lines.find(
        (line) => typeof line === 'string' && line.startsWith(`profileNaming.${field} must be`),
      );
      assert.ok(named !== undefined, `${field}: the wire message names the field, got ${JSON.stringify(lines)}`);
      assert.match(named as string, /Latin letters, digits/);
    }
  });

  it('everything it accepts is used exactly as typed when the next profile is named', () => {
    // The generation-time repair exists for values stored BEFORE this check (or
    // arriving through a config import). A value the form can save today must
    // never be repaired: the operator would see one prefix and get another.
    for (const profileNaming of ACCEPTED) {
      const config = readProfileNamingConfig({ profileNaming });
      for (const [key, value] of Object.entries(profileNaming)) {
        assert.equal(config[key as keyof typeof config], value, `${key} ${value}`);
      }
    }
  });
});
