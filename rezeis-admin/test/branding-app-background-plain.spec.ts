import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import {
  APP_BACKGROUND_KINDS,
  DEFAULT_BRANDING,
} from '../src/modules/settings/interfaces/branding-settings.interface';
import { readBrandingSettings } from '../src/modules/settings/utils/branding-settings.util';

/**
 * `none` is the cabinet's BUILT-IN background and always was.
 *
 * reiwa's `StealthLayout` renders `<NetworkBg>` — brand glows, a dot grid,
 * diagonals — whenever the kind resolves to `none`. The panel called that mode
 * "None", documented it in three places as "plain `bgPrimary` colour", and drew
 * an empty preview for it. The code was right and the words were wrong, so the
 * words changed: `none` keeps drawing the pattern, and a NEW kind, `plain`,
 * carries the meaning the text used to promise.
 *
 * The whole risk of that decision sits in this file. Every installation in
 * production either stores `kind: 'none'` or stores no `appBackground` at all,
 * and both must keep resolving to `none`. If either one ever resolves to
 * `plain`, every one of those cabinets loses its background overnight — the one
 * outcome the rework exists to avoid.
 */

async function firstErrorPaths(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(UpdateBrandingSettingsDto, payload);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.flatMap((error) =>
    error.children && error.children.length > 0
      ? error.children.map((child) => `${error.property}.${child.property}`)
      : [error.property],
  );
}

describe('app background: the built-in kind keeps its picture', () => {
  it('leaves a stored `none` as `none`', () => {
    const branding = readBrandingSettings({
      appBackground: { kind: 'none', effect: 'NONE', props: {}, opacity: 1 },
    });

    assert.equal(branding.appBackground.kind, 'none');
  });

  it('resolves a payload with no appBackground block to `none`, not `plain`', () => {
    // Every installation older than the field. It has been rendering NetworkBg
    // since the day it was created and must go on doing so.
    assert.equal(readBrandingSettings(null).appBackground.kind, 'none');
    assert.equal(readBrandingSettings({}).appBackground.kind, 'none');
    assert.equal(DEFAULT_BRANDING.appBackground.kind, 'none');
  });

  it('resolves a legacy effect-less payload to `none`, not `plain`', () => {
    // Pre-`kind` payloads carry only effect/props/opacity. `NONE` there means
    // "no animation", which has always been drawn as the built-in pattern.
    const branding = readBrandingSettings({
      appBackground: { effect: 'NONE', props: {}, opacity: 1 },
    });

    assert.equal(branding.appBackground.kind, 'none');
  });

  it('resolves an unreadable appBackground to `none`, not `plain`', () => {
    assert.equal(readBrandingSettings({ appBackground: 'oops' }).appBackground.kind, 'none');
    assert.equal(readBrandingSettings({ appBackground: [] }).appBackground.kind, 'none');
    assert.equal(
      readBrandingSettings({ appBackground: { kind: 'nonsense' } }).appBackground.kind,
      'none',
    );
  });
});

describe('app background: the new plain kind', () => {
  it('is a member of the published vocabulary', () => {
    assert.ok((APP_BACKGROUND_KINDS as readonly string[]).includes('plain'));
    assert.ok((APP_BACKGROUND_KINDS as readonly string[]).includes('none'));
  });

  it('survives a read unchanged', () => {
    const branding = readBrandingSettings({
      appBackground: { kind: 'plain', effect: 'NONE', props: {}, opacity: 1 },
    });

    assert.equal(branding.appBackground.kind, 'plain');
  });

  it('is accepted by the update DTO', async () => {
    const paths = await firstErrorPaths({ appBackground: { kind: 'plain' } });

    assert.deepEqual(paths, []);
  });

  it('does not open the DTO to arbitrary kinds', async () => {
    // The panel refusing a request it wrote itself is the right place for a
    // closed list. The cabinet's guard is deliberately NOT — see
    // `isAppBackgroundKind` in reiwa's public-config port.
    const paths = await firstErrorPaths({ appBackground: { kind: 'plane' } });

    assert.deepEqual(paths, ['appBackground.kind']);
  });
});
