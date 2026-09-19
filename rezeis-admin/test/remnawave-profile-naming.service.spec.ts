import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clampPanelUsername } from '../src/modules/profile-sync/profile-sync.processor';
import {
  readProfileNamingConfig,
  readProfileOwnerMarker,
  RemnawaveProfileNamingService,
} from '../src/modules/profile-sync/remnawave-profile-naming.service';
import { readBrandingSettings } from '../src/modules/settings/utils/branding-settings.util';

/**
 * `generateProfileName` was only ever MOCKED before this file: every processor
 * spec hands the processor a stub that returns a fixed name, so nothing pinned
 * which identity wins, how it is cleaned, or whether the result fits the panel.
 * Everything below runs the real service over a fake Prisma.
 */

const USER_ID = 'cmbuser0000000000000000b1';
/** `USER_ID.slice(0, 8)` — the last-resort identifier. */
const ID_PREFIX = 'cmbuser0';

/** Remnawave's own rule for a username, identical on 2.x and 3.x. */
const PANEL_USERNAME = /^[A-Za-z0-9_-]{3,36}$/;

interface UserSeed {
  /**
   * `WebAccount.login`. Absent means the customer has no web account; `null`
   * is a web account WITHOUT a login — what social sign-up creates.
   */
  readonly login?: string | null;
  /** `User.username`. */
  readonly username?: string | null;
  readonly telegramId?: bigint | null;
  readonly name?: string;
  /**
   * The pair the Telegram bootstrap writes (`telegramUsername`,
   * `telegramUsernameTgId`). Absent: what the bootstrap wrote for `username`
   * on `telegramId`. `null`: no /start or Mini App sign-in has reached this
   * account since the pair exists — whatever `username` holds came from
   * somewhere else.
   */
  readonly verified?: { readonly username: string | null; readonly tgId: bigint | null } | null;
}

interface NamingSeed {
  readonly user: UserSeed;
  /** The customer's subscriptions, oldest first. */
  readonly subscriptions?: ReadonlyArray<{
    readonly id: string;
    readonly remnawavePanelUsername?: string | null;
  }>;
  /** `Settings.brandingSettings`. `undefined` means there is no settings row. */
  readonly branding?: unknown;
}

function namingFor(seed: NamingSeed): RemnawaveProfileNamingService {
  const telegramId = seed.user.telegramId ?? null;
  const username = seed.user.username ?? null;
  const verified =
    seed.user.verified === undefined
      ? telegramId === null
        ? null
        : { username, tgId: telegramId }
      : seed.user.verified;
  const user = {
    id: USER_ID,
    username,
    name: seed.user.name ?? '',
    telegramId,
    telegramUsername: verified?.username ?? null,
    telegramUsernameTgId: verified?.tgId ?? null,
    email: null,
    webAccount: seed.user.login === undefined ? null : { login: seed.user.login },
  };
  const subscriptions = (seed.subscriptions ?? [{ id: 'sub-b-0' }]).map((row) => ({
    id: row.id,
    remnawavePanelUsername: row.remnawavePanelUsername ?? null,
  }));
  return new RemnawaveProfileNamingService({
    user: { findUnique: async () => user },
    subscription: { findMany: async () => subscriptions },
    settings: {
      findFirst: async () =>
        seed.branding === undefined ? null : { brandingSettings: seed.branding },
    },
  } as never);
}

async function nameOf(seed: NamingSeed, subscriptionId = 'sub-b-0') {
  return namingFor(seed).generateProfileName(USER_ID, subscriptionId);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Which identity names a NEW profile (owner's decision of 18.09.2026)
// ═════════════════════════════════════════════════════════════════════════════

describe('generateProfileName — which identity names a new profile', () => {
  it('a web-only customer gets the login', async () => {
    const naming = await nameOf({ user: { login: 'johnny' } });
    assert.equal(naming.username, 'rz_johnny_sub');
  });

  it('a Telegram-only customer with an @username gets the @username', async () => {
    const naming = await nameOf({ user: { telegramId: 555000111n, username: 'johnny_tg' } });
    assert.equal(naming.username, 'rz_johnny_tg_sub');
  });

  it('a Telegram-only customer without an @username gets the numeric Telegram id', async () => {
    const naming = await nameOf({ user: { telegramId: 555000111n, username: null } });
    assert.equal(naming.username, 'rz_555000111_sub');
  });

  it('web plus Telegram WITH an @username: the @username wins over the login', async () => {
    const naming = await nameOf({
      user: { login: 'johnny', telegramId: 555000111n, username: 'TgNick' },
    });
    assert.equal(naming.username, 'rz_TgNick_sub');
  });

  it('web plus Telegram WITHOUT an @username: the login', async () => {
    const naming = await nameOf({
      user: { login: 'johnny', telegramId: 555000111n, username: null },
    });
    assert.equal(naming.username, 'rz_johnny_sub');
  });

  it('nothing at all: the reiwa_id prefix', async () => {
    const naming = await nameOf({ user: {} });
    assert.equal(naming.username, `rz_${ID_PREFIX}_sub`);
  });

  it('a social sign-up (a web account with no login) falls through to Telegram, then the reiwa_id prefix', async () => {
    assert.equal(
      (await nameOf({ user: { login: null, telegramId: 555000111n, username: null } })).username,
      'rz_555000111_sub',
    );
    assert.equal((await nameOf({ user: { login: null } })).username, `rz_${ID_PREFIX}_sub`);
  });
});

describe('generateProfileName — only the @username TELEGRAM reported for the linked account counts', () => {
  it('ignores User.username on an account with no Telegram linked (an admin-typed or imported handle)', async () => {
    // The importers and the admin «create user» form write `User.username` for
    // accounts that may have no Telegram at all. Such a value is not the
    // @username of a linked Telegram account, whatever it looks like.
    const withoutLogin = await nameOf({ user: { username: 'imported_handle' } });
    assert.equal(withoutLogin.username, `rz_${ID_PREFIX}_sub`);

    const withLogin = await nameOf({ user: { login: 'johnny', username: 'imported_handle' } });
    assert.equal(withLogin.username, 'rz_johnny_sub');
  });

  it('ignores the Remnawave importer\'s panel handle in User.username on a Telegram account', async () => {
    // `RemnawaveImporterService.publicHandleFrom` copies a FOREIGN panel
    // profile's username into `User.username` — including on a Telegram account
    // without an @username. It never writes the verified pair.
    const naming = await nameOf({
      user: { telegramId: 555000111n, username: 'vpn_user_42', verified: null },
      subscriptions: [{ id: 'sub-b-0', remnawavePanelUsername: 'vpn_user_42' }],
    });
    assert.equal(naming.username, 'rz_555000111_sub');
  });

  it('a nick in User.username that no /start has verified names nothing: the login does', async () => {
    // A donor import, or the admin form, on an account that has Telegram
    // linked — the value looks like a nick and was never Telegram's word.
    const naming = await nameOf({
      user: { login: 'johnny', telegramId: 555000111n, username: 'TgNick', verified: null },
    });
    assert.equal(naming.username, 'rz_johnny_sub');
  });

  it('a nick verified for a PREVIOUS Telegram account is not used after a rebind', async () => {
    const naming = await nameOf({
      user: {
        login: 'johnny',
        telegramId: 777000222n,
        username: 'TgNick',
        verified: { username: 'TgNick', tgId: 555000111n },
      },
    });
    assert.equal(naming.username, 'rz_johnny_sub');
  });

  it('the verified nick wins over whatever User.username says', async () => {
    const naming = await nameOf({
      user: {
        login: 'johnny',
        telegramId: 555000111n,
        username: 'typed_by_admin',
        verified: { username: 'RealNick', tgId: 555000111n },
      },
    });
    assert.equal(naming.username, 'rz_RealNick_sub');
  });

  it('an account Telegram verified as having NO @username gets the login, whatever User.username still says', async () => {
    const naming = await nameOf({
      user: {
        login: 'johnny',
        telegramId: 555000111n,
        username: 'old_nick',
        verified: { username: null, tgId: 555000111n },
      },
    });
    assert.equal(naming.username, 'rz_johnny_sub');
  });

  it('accepts the shortest (collectible, 4 characters) and the longest (32) @username Telegram issues', async () => {
    assert.equal(
      (await nameOf({ user: { telegramId: 1n, username: 'jack' } })).username,
      'rz_jack_sub',
    );
    const longest = `N${'n'.repeat(31)}`;
    assert.equal(
      (await nameOf({ user: { telegramId: 1n, username: longest } })).username,
      `rz_${longest}_sub`,
    );
  });

  it('a StealthNet import (login = e-mail, no Telegram) keeps today\'s sanitised login', async () => {
    const naming = await nameOf({ user: { login: 'john.doe@gmail.com' } });
    assert.equal(naming.username, 'rz_john_doe_gmail_com_sub');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Names an EXISTING profile may already carry
// ═════════════════════════════════════════════════════════════════════════════

describe('generateProfileName — the name under the previous rule, for lookups only', () => {
  it('reports the login-first name when the new rule gives a different one', async () => {
    const naming = await nameOf({
      user: { login: 'johnny', telegramId: 555000111n, username: 'TgNick' },
    });
    assert.equal(naming.username, 'rz_TgNick_sub');
    assert.deepEqual(naming.legacyUsernames, ['rz_johnny_sub']);
  });

  it('reports the handle-based name the previous rule gave an account without Telegram', async () => {
    const naming = await nameOf({ user: { username: 'imported_handle' } });
    assert.deepEqual(naming.legacyUsernames, ['rz_imported_handle_sub']);
  });

  it('reports nothing when both rules agree', async () => {
    for (const user of [
      { login: 'johnny' },
      { telegramId: 555000111n, username: 'johnny_tg' },
      { login: 'johnny', telegramId: 555000111n, username: null },
    ]) {
      const naming = await nameOf({ user });
      assert.deepEqual(naming.legacyUsernames, [], JSON.stringify(user, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
    }
  });

  it('rebuilds the previous-rule name from the settings as THAT rule read them, not as they are repaired now', async () => {
    // A prefix saved longer than 16 characters: today's reader ignores it (the
    // default `rz`), while the rule before 18.09.2026 used any non-empty value
    // as stored — so that is the name the profiles it made carry.
    const naming = await nameOf({
      user: { login: 'johnny', telegramId: 555000111n, username: 'TgNick' },
      branding: { profileNaming: { prefix: 'shopprefixlong20chr', separator: '_', suffixBase: 'sub' } },
    });
    assert.equal(naming.username, 'rz_TgNick_sub');
    assert.deepEqual(naming.legacyUsernames, ['shopprefixlong20chr_johnny_sub']);
  });

  it('keeps the ordinal in the previous-rule name', async () => {
    const naming = await nameOf(
      {
        user: { login: 'johnny', telegramId: 555000111n, username: 'TgNick' },
        subscriptions: [{ id: 'sub-b-0' }, { id: 'sub-b-1' }],
      },
      'sub-b-1',
    );
    assert.equal(naming.username, 'rz_TgNick_sub_1');
    assert.deepEqual(naming.legacyUsernames, ['rz_johnny_sub_1']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Collisions: distinct, deterministic names for when the name is taken
// ═════════════════════════════════════════════════════════════════════════════

describe('generateProfileName — fallback names for a name another customer holds', () => {
  it('offers two fallbacks: identifier + a tag from the subscription id + suffix (golden vector)', async () => {
    // Pinned byte for byte ON PURPOSE. A CREATE retried across a deploy has to
    // find the profile its first attempt made under a fallback name; a formula
    // that drifted between releases would mint a second one.
    const naming = await nameOf({ user: { telegramId: 555000111n, username: 'johnny' } });
    assert.deepEqual(naming.fallbackUsernames, ['rz_johnny_bd4e76_sub', 'rz_johnny_acd089_sub']);
  });

  it('is deterministic: the same subscription gets the same fallbacks on every call', async () => {
    const seed: NamingSeed = { user: { telegramId: 555000111n, username: 'johnny' } };
    const first = await nameOf(seed);
    const second = await nameOf(seed);
    assert.equal(first.fallbackUsernames?.length, 2, 'two fallbacks, or this comparison proves nothing');
    assert.deepEqual(first.fallbackUsernames, second.fallbackUsernames);
  });

  it('keeps the ordinal and differs per subscription of one customer', async () => {
    const seed: NamingSeed = {
      user: { telegramId: 555000111n, username: 'johnny' },
      subscriptions: [{ id: 'sub-b-0' }, { id: 'sub-b-1' }],
    };
    const first = await nameOf(seed, 'sub-b-0');
    const second = await nameOf(seed, 'sub-b-1');
    assert.deepEqual(second.fallbackUsernames, ['rz_johnny_fa4b05_sub_1', 'rz_johnny_0050b7_sub_1']);
    for (const name of second.fallbackUsernames ?? []) {
      assert.ok(!(first.fallbackUsernames ?? []).includes(name));
    }
  });

  it('never repeats the primary name or the previous-rule name', async () => {
    const naming = await nameOf({
      user: { login: 'johnny', telegramId: 555000111n, username: 'TgNick' },
    });
    const fallbacks = naming.fallbackUsernames ?? [];
    assert.equal(fallbacks.length, 2);
    assert.equal(new Set(fallbacks).size, 2);
    assert.ok(!fallbacks.includes(naming.username));
    for (const legacy of naming.legacyUsernames ?? []) assert.ok(!fallbacks.includes(legacy));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Sanitising: what reaches the panel is always a name it accepts
// ═════════════════════════════════════════════════════════════════════════════

describe('generateProfileName — sanitising', () => {
  it('turns a login with dots and @ into a panel-safe slug', async () => {
    assert.equal((await nameOf({ user: { login: 'john.doe' } })).username, 'rz_john_doe_sub');
  });

  it('repairs a stored prefix with a space instead of sending it (the panel refuses the whole CREATE)', async () => {
    const naming = await nameOf({
      user: { login: 'johnny' },
      branding: { profileNaming: { prefix: 'my shop', separator: '_', suffixBase: 'sub' } },
    });
    assert.equal(naming.username, 'my_shop_johnny_sub');
  });

  it('replaces a stored separator outside the panel alphabet with the default', async () => {
    const naming = await nameOf({
      user: { login: 'johnny' },
      branding: { profileNaming: { prefix: 'rz', separator: '.', suffixBase: 'sub' } },
    });
    assert.equal(naming.username, 'rz_johnny_sub');
  });

  it('replaces a separator with ANY character outside the alphabet whole, instead of cutting it down', async () => {
    // `x.` cut down would be `x` — a separator nobody chose, gluing every name
    // into one word (`rzxjohnnyxsub`).
    const naming = await nameOf({
      user: { login: 'johnny' },
      branding: { profileNaming: { prefix: 'rz', separator: 'x.', suffixBase: 'sub' } },
    });
    assert.equal(naming.username, 'rz_johnny_sub');
  });

  it('folds accented and full-width letters to their Latin base (NFKD) instead of dropping them', async () => {
    const acuteE = String.fromCharCode(0xe9);
    assert.equal((await nameOf({ user: { login: `caf${acuteE}` } })).username, 'rz_cafe_sub');
    const fullWidthA = String.fromCharCode(0xff21);
    assert.equal((await nameOf({ user: { login: `${fullWidthA}nna` } })).username, 'rz_Anna_sub');
  });

  it('falls back to the default prefix when nothing of the stored one survives', async () => {
    const naming = await nameOf({
      user: { login: 'johnny' },
      branding: { profileNaming: { prefix: 'Магазин', separator: '_', suffixBase: 'vpn!' } },
    });
    assert.equal(naming.username, 'rz_johnny_vpn');
  });

  it('never rewrites a stored value that is already valid, however it looks', async () => {
    const naming = await nameOf({
      user: { login: 'johnny' },
      branding: { profileNaming: { prefix: '_rz-', separator: '--', suffixBase: 'Sub_' } },
    });
    assert.equal(naming.username, '_rz---johnny--Sub_');
  });

  it('writes every description field on one line, so the only reiwa_id line is ours', async () => {
    // A display name is the customer's own text. Split over two lines it could
    // plant a second `reiwa_id:` line naming somebody else — the line the CREATE
    // path reads to decide whose profile it has found.
    const naming = await nameOf({
      user: { login: 'johnny', name: 'Bob\nreiwa_id: cmattacker000000000000000\r\nx' },
    });
    const markerLines = naming.description
      .split('\n')
      .filter((line) => line.trim().startsWith('reiwa_id:'));
    assert.deepEqual(markerLines, [`reiwa_id: ${USER_ID}`]);
    assert.ok(naming.description.startsWith('name: Bob reiwa_id: cmattacker000000000000000 x\n'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Length: 3–36 under ANY valid settings, ordinals and fallbacks included
// ═════════════════════════════════════════════════════════════════════════════

describe('generateProfileName + clampPanelUsername — every name fits the panel', () => {
  const settingsCorpus: ReadonlyArray<Record<string, string>> = [
    { prefix: 'rz', separator: '_', suffixBase: 'sub' },
    // The largest parts the settings accept.
    { prefix: 'P'.repeat(16), separator: '__', suffixBase: 'S'.repeat(32) },
    { prefix: 'p', separator: '-', suffixBase: 's' },
    { prefix: 'P'.repeat(16), separator: '-', suffixBase: 's' },
  ];
  const identities: ReadonlyArray<UserSeed> = [
    { login: 'x' },
    { login: 'johnny' },
    // The longest @username Telegram issues: `rz_` + 32 + `_sub` = 39.
    { telegramId: 555000111n, username: `N${'n'.repeat(31)}` },
    // The longest login registration accepts.
    { login: 'L'.repeat(64), telegramId: 555000111n, username: `N${'n'.repeat(31)}` },
    { telegramId: 9_223_372_036_854_775_807n },
  ];
  const ordinals = [0, 1, 9, 10, 99, 100, 1000];

  it('clamps every primary, previous-rule and fallback name into ^[A-Za-z0-9_-]{3,36}$, keeping distinct names distinct', async () => {
    let checked = 0;
    for (const profileNaming of settingsCorpus) {
      for (const user of identities) {
        for (const ordinal of ordinals) {
          const subscriptions = Array.from({ length: ordinal + 1 }, (_v, index) => ({
            id: `sub-b-${index}`,
          }));
          const naming = await nameOf(
            { user, subscriptions, branding: { profileNaming } },
            `sub-b-${ordinal}`,
          );
          const raw = [
            naming.username,
            ...(naming.legacyUsernames ?? []),
            ...(naming.fallbackUsernames ?? []),
          ];
          assert.equal(naming.fallbackUsernames?.length, 2);
          const clamped = raw.map((name) => clampPanelUsername(name));
          for (const name of clamped) {
            assert.match(name, PANEL_USERNAME, `${JSON.stringify(profileNaming)} ordinal ${ordinal}: '${name}'`);
            checked += 1;
          }
          assert.equal(new Set(clamped).size, new Set(raw).size, 'the clamp must not merge two names');
        }
      }
    }
    assert.ok(checked >= settingsCorpus.length * identities.length * ordinals.length * 3);
  });

  it('keeps the ordinal apart from the primary name even when both are clamped', async () => {
    const user = { telegramId: 555000111n, username: `N${'n'.repeat(31)}` };
    const first = await nameOf({ user, subscriptions: [{ id: 'sub-b-0' }, { id: 'sub-b-1' }] }, 'sub-b-0');
    const second = await nameOf({ user, subscriptions: [{ id: 'sub-b-0' }, { id: 'sub-b-1' }] }, 'sub-b-1');
    assert.ok(first.username.length > 36);
    assert.notEqual(clampPanelUsername(first.username), clampPanelUsername(second.username));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The ownership proof the CREATE path adopts on
// ═════════════════════════════════════════════════════════════════════════════

describe('readProfileOwnerMarker', () => {
  it('reads the reiwa_id line this service writes', () => {
    assert.equal(readProfileOwnerMarker(`name: John\nlogin: john\nreiwa_id: ${USER_ID}`), USER_ID);
    assert.equal(readProfileOwnerMarker(`  reiwa_id: ${USER_ID}  \r\nnote`), USER_ID);
  });

  it('ignores a marker that is not at the start of its own line', () => {
    assert.equal(readProfileOwnerMarker('name: reiwa_id: cmbuser0000000000000000b1\nreiwa_id: cmauser0000000000000000a1'), 'cmauser0000000000000000a1');
    assert.equal(readProfileOwnerMarker('name: reiwa_id: cmbuser0000000000000000b1'), null);
  });

  it('proves nothing when two lines name different owners', () => {
    assert.equal(readProfileOwnerMarker('reiwa_id: cmbuser0000000000000000b1\nreiwa_id: cmauser0000000000000000a1'), null);
    assert.equal(readProfileOwnerMarker(`reiwa_id: ${USER_ID}\nreiwa_id: ${USER_ID}`), USER_ID);
  });

  it('proves nothing without a marker', () => {
    for (const description of [null, undefined, '', 'imported from donor', 'reiwa_id:', 42]) {
      assert.equal(readProfileOwnerMarker(description), null, String(description));
    }
  });

  it('agrees with what generateProfileName writes', async () => {
    const naming = await nameOf({ user: { login: 'johnny', telegramId: 1n, username: 'TgNick', name: 'John Doe' } });
    assert.equal(readProfileOwnerMarker(naming.description), USER_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One reading of the stored settings
// ═════════════════════════════════════════════════════════════════════════════

describe('readProfileNamingConfig agrees with the settings reader the admin screen shows', () => {
  // Every value here is inside the panel alphabet, so the only question is the
  // length/type/default rules — which must be the ones `readProfileNaming`
  // applies when the settings page loads, or the form shows one prefix while
  // new profiles get another.
  const corpus: unknown[] = [
    null,
    {},
    { profileNaming: null },
    { profileNaming: {} },
    { profileNaming: { prefix: '' } },
    { profileNaming: { prefix: 'x'.repeat(16) } },
    { profileNaming: { prefix: 'x'.repeat(17) } },
    { profileNaming: { prefix: 5, separator: false, suffixBase: [] } },
    { profileNaming: { separator: '---' } },
    { profileNaming: { separator: '--' } },
    { profileNaming: { suffixBase: 's'.repeat(32) } },
    { profileNaming: { suffixBase: 's'.repeat(33) } },
    { profileNaming: { prefix: 'shop', separator: '-', suffixBase: 'vpn' } },
  ];

  for (const stored of corpus) {
    it(`reads ${JSON.stringify(stored)} the same way`, () => {
      assert.deepEqual(readProfileNamingConfig(stored), readBrandingSettings(stored).profileNaming);
    });
  }
});
