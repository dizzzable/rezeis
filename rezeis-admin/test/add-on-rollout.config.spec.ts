import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';

import {
  ADD_ON_ROLLOUT_FLAG_NAMES,
  ADD_ON_SWITCH_DEFAULTS,
  ADD_ON_SWITCH_NAMES,
  type AddOnRolloutFlags,
  describeAddOnSwitches,
  planAddOnSwitchUpdate,
  readAddOnRolloutFlags,
  readEnvOverride,
  readStoredAddOnSwitches,
  resolveAddOnRolloutFlags,
  resolveIntakeResetCapabilities,
  resolveResetCapabilities,
} from '../src/modules/add-on-entitlements/add-on-rollout.config';

/** No `ADDON_*` line at all: what an install has once it follows the notes. */
const NO_ENV: NodeJS.ProcessEnv = {};

const RESET_VARIABLES = [
  'ADDON_RESET_EXPIRY_DAY',
  'ADDON_RESET_EXPIRY_WEEK',
  'ADDON_RESET_EXPIRY_MONTH',
  'ADDON_RESET_EXPIRY_MONTH_ROLLING',
] as const;

describe('add-on switches — the defaults', () => {
  it('ship all three ON — «Докупка трафика до сброса» since 25.09.2026, once the reset instants matched live Remnawave', () => {
    // The whole table, keys included: a missing or an extra switch fails here
    // as surely as a flipped default.
    assert.deepEqual(
      { ...ADD_ON_SWITCH_DEFAULTS },
      { durableAccounting: true, deviceCleanupAuto: true, trafficResetExpiry: true },
    );
    assert.deepEqual([...ADD_ON_SWITCH_NAMES], ['durableAccounting', 'deviceCleanupAuto', 'trafficResetExpiry']);
  });

  it('run stages 1, 2, 4 and 6 — every reset strategy — while nothing is set, on the page or in .env', () => {
    assert.deepEqual(resolveAddOnRolloutFlags({}, NO_ENV), {
      entitlementShadow: true,
      directPurchase: true,
      deviceCleanupAuto: true,
      resetExpiry: { DAY: true, WEEK: true, MONTH: true, MONTH_ROLLING: true },
    });
  });

  it('keep stage 4 OFF where .env says so, over the new default and over a stored ON', () => {
    const off = Object.fromEntries(RESET_VARIABLES.map((name) => [name, 'false']));
    const none = { DAY: false, WEEK: false, MONTH: false, MONTH_ROLLING: false };
    assert.deepEqual(resolveAddOnRolloutFlags({}, off).resetExpiry, none);
    assert.deepEqual(resolveAddOnRolloutFlags({ trafficResetExpiry: true }, off).resetExpiry, none);
    // A switch the operator turned off stays off too.
    assert.deepEqual(resolveAddOnRolloutFlags({ trafficResetExpiry: false }, NO_ENV).resetExpiry, none);
  });

  it('read the seven variables of the three switches and nothing else: a line for a deleted stage decides nothing', () => {
    assert.deepEqual(
      [...ADD_ON_ROLLOUT_FLAG_NAMES],
      ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE', 'ADDON_DEVICE_CLEANUP_AUTO', ...RESET_VARIABLES],
    );
    // Stages 3 and 5 were deleted with their code: an install whose .env still
    // carries their lines runs exactly like one without them.
    const leftovers = resolveAddOnRolloutFlags({}, { ADDON_PROJECTION_SYNC: 'true', ADDON_RENEWAL_ADDONS: 'true' });
    assert.deepEqual(leftovers, resolveAddOnRolloutFlags({}, NO_ENV));
    assert.deepEqual(Object.keys(leftovers).sort(), ['deviceCleanupAuto', 'directPurchase', 'entitlementShadow', 'resetExpiry']);
  });
});

describe('add-on switches — the stored switch decides while .env is silent', () => {
  it('«Новый учёт докупок» OFF stops stages 1 and 2, and nothing else', () => {
    const flags = resolveAddOnRolloutFlags({ durableAccounting: false }, NO_ENV);
    assert.equal(flags.entitlementShadow, false);
    assert.equal(flags.directPurchase, false);
    assert.equal(flags.deviceCleanupAuto, true);
  });

  it('«Удалять лишние устройства автоматически» OFF stops stage 6, and nothing else', () => {
    const flags = resolveAddOnRolloutFlags({ deviceCleanupAuto: false }, NO_ENV);
    assert.equal(flags.deviceCleanupAuto, false);
    assert.equal(flags.entitlementShadow, true);
    assert.equal(flags.directPurchase, true);
  });

  it('«Докупка трафика до сброса» ON opens every reset strategy at once', () => {
    const flags = resolveAddOnRolloutFlags({ trafficResetExpiry: true }, NO_ENV);
    assert.deepEqual(flags.resetExpiry, { DAY: true, WEEK: true, MONTH: true, MONTH_ROLLING: true });
  });

  it('takes only real booleans of known switches out of the column', () => {
    assert.deepEqual(readStoredAddOnSwitches(null), {});
    assert.deepEqual(readStoredAddOnSwitches([true]), {});
    assert.deepEqual(readStoredAddOnSwitches('{"durableAccounting":false}'), {});
    assert.deepEqual(
      readStoredAddOnSwitches({
        durableAccounting: false,
        // Not what the writer stores: treated as never set, not guessed at.
        deviceCleanupAuto: 'false',
        trafficResetExpiry: true,
        projectionSync: true,
      }),
      { durableAccounting: false, trafficResetExpiry: true },
    );
  });
});

describe('add-on switches — an explicit .env value wins', () => {
  it('over the stored switch, in both directions', () => {
    const offOverOn = resolveAddOnRolloutFlags(
      { durableAccounting: true, deviceCleanupAuto: true },
      {
        ADDON_ENTITLEMENT_SHADOW: 'false',
        ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'false',
        ADDON_DEVICE_CLEANUP_AUTO: 'false',
      },
    );
    assert.equal(offOverOn.entitlementShadow, false);
    assert.equal(offOverOn.directPurchase, false);
    assert.equal(offOverOn.deviceCleanupAuto, false);

    const onOverOff = resolveAddOnRolloutFlags(
      { trafficResetExpiry: false, deviceCleanupAuto: false },
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_DEVICE_CLEANUP_AUTO: 'true' },
    );
    assert.equal(onOverOff.resetExpiry.MONTH, true);
    assert.equal(onOverOff.deviceCleanupAuto, true);
    // The strategies .env does not name stay with the switch.
    assert.equal(onOverOff.resetExpiry.DAY, false);
  });

  it('one variable at a time: a lone ADDON_ENTITLEMENT_SHADOW decides stage 1 and leaves stage 2 to the switch', () => {
    const flags = resolveAddOnRolloutFlags({ durableAccounting: false }, { ADDON_ENTITLEMENT_SHADOW: 'true' });
    assert.equal(flags.entitlementShadow, true);
    assert.equal(flags.directPurchase, false);
  });

  it('means ON for "true", "1", "on" or "yes" and OFF for "false", "0", "off" or "no", whatever the case or padding', () => {
    for (const on of ['true', '1', 'TRUE', ' True ', 'on', 'On', 'yes', ' YES\t']) {
      assert.equal(readEnvOverride(on, 'ADDON_RESET_EXPIRY_DAY'), true, JSON.stringify(on));
      const flags = resolveAddOnRolloutFlags({ trafficResetExpiry: false }, { ADDON_RESET_EXPIRY_DAY: on });
      assert.equal(flags.resetExpiry.DAY, true, JSON.stringify(on));
    }
    // `off` and `no` too: the 0.9.7.69 notes told operators to write the
    // stages off, and a line in their own words must keep them OFF now.
    for (const off of ['false', '0', 'FALSE', ' False ', '0\t', 'off', ' OFF ', 'no', 'No']) {
      assert.equal(readEnvOverride(off, 'ADDON_ENTITLEMENT_SHADOW'), false, JSON.stringify(off));
      const flags = resolveAddOnRolloutFlags({ durableAccounting: true }, { ADDON_ENTITLEMENT_SHADOW: off });
      assert.equal(flags.entitlementShadow, false, JSON.stringify(off));
    }
  });

  it('leaves the stage to the switch for unset, empty and unrecognised values', () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    try {
      for (const value of [undefined, '', '   ', 'enabled', 'disabled', 'offf', 'nope']) {
        assert.equal(readEnvOverride(value, 'ADDON_ENTITLEMENT_SHADOW'), null, JSON.stringify(value));
        const off = resolveAddOnRolloutFlags({ durableAccounting: false }, { ADDON_ENTITLEMENT_SHADOW: value });
        assert.equal(off.entitlementShadow, false, `stored OFF, ${JSON.stringify(value)}`);
        const untouched = resolveAddOnRolloutFlags({}, { ADDON_ENTITLEMENT_SHADOW: value });
        assert.equal(untouched.entitlementShadow, true, `default ON, ${JSON.stringify(value)}`);
      }
    } finally {
      mock.restoreAll();
    }
  });

  it('warns once for each unrecognised value, naming the variable and the page that decides instead', () => {
    const warned: string[] = [];
    mock.method(Logger.prototype, 'warn', (message: unknown) => void warned.push(String(message)));
    try {
      // A value no other test reads: the "once" is kept per process.
      const odd = `maybe-${process.pid}-${Date.now()}`;
      for (let read = 0; read < 3; read += 1) {
        resolveAddOnRolloutFlags({}, { ADDON_ENTITLEMENT_SHADOW: odd, ADDON_DEVICE_CLEANUP_AUTO: 'off' });
      }
      assert.equal(warned.length, 1, warned.join('\n'));
      assert.match(warned[0]!, new RegExp(`ADDON_ENTITLEMENT_SHADOW="${odd}" is not a recognised value`));
      assert.match(warned[0]!, /«Доп\. услуги»/);
    } finally {
      mock.restoreAll();
    }
  });
});

describe('add-on switches — what the page shows', () => {
  it('each switch in page order, with what it runs as, its default, the stored choice and no lock', () => {
    assert.deepEqual(describeAddOnSwitches({ deviceCleanupAuto: false }, NO_ENV), [
      { name: 'durableAccounting', enabled: true, defaultEnabled: true, stored: null, env: [], locked: false },
      { name: 'deviceCleanupAuto', enabled: false, defaultEnabled: true, stored: false, env: [], locked: false },
      { name: 'trafficResetExpiry', enabled: true, defaultEnabled: true, stored: null, env: [], locked: false },
    ]);
  });

  it('names the .env lines that decide a switch, and shows the switch as the stages actually run', () => {
    mock.method(Logger.prototype, 'warn', () => undefined);
    try {
      const [durable, cleanup, reset] = describeAddOnSwitches(
        { durableAccounting: true, trafficResetExpiry: false },
        {
          ADDON_ENTITLEMENT_DIRECT_PURCHASE: 'false',
          ADDON_RESET_EXPIRY_WEEK: 'yes',
          ADDON_DEVICE_CLEANUP_AUTO: 'nonsense',
        },
      );
      // Stage 2 is off by .env: the switch shows OFF although stored ON, and is locked.
      assert.equal(durable!.enabled, false, 'a switch is ON only while every stage it carries is');
      assert.equal(durable!.stored, true);
      assert.deepEqual(durable!.env, [{ variable: 'ADDON_ENTITLEMENT_DIRECT_PURCHASE', enabled: false }]);
      assert.equal(durable!.locked, true, 'one line of a switch of stages locks it whole');
      // A value the panel does not recognise locks nothing.
      assert.deepEqual(cleanup!.env, []);
      assert.equal(cleanup!.enabled, true);
      assert.equal(cleanup!.locked, false);
      // One rule ON by .env, the others with the switch (stored OFF): the switch
      // shows its own OFF and stays the operator's (N1 gap 3).
      assert.equal(reset!.enabled, false);
      assert.deepEqual(reset!.env, [{ variable: 'ADDON_RESET_EXPIRY_WEEK', enabled: true }]);
      assert.equal(reset!.locked, false);
    } finally {
      mock.restoreAll();
    }
  });

  it('N1 gap 3: .env turning ONE reset rule off leaves the switch at the value the other rules run with — not off as a whole', () => {
    const env = { ADDON_RESET_EXPIRY_DAY: 'false' };
    const reset = describeAddOnSwitches({}, env)[2]!;

    assert.deepEqual(reset, {
      name: 'trafficResetExpiry',
      enabled: true,
      defaultEnabled: true,
      stored: null,
      env: [{ variable: 'ADDON_RESET_EXPIRY_DAY', enabled: false }],
      locked: false,
    });
    // …which is exactly how the stages run.
    assert.deepEqual(resolveAddOnRolloutFlags({}, env).resetExpiry, {
      DAY: false,
      WEEK: true,
      MONTH: true,
      MONTH_ROLLING: true,
    });
  });

  it('N1 gap 3: a switch of rules with EVERY rule in .env is locked and shows how they run', () => {
    const reset = describeAddOnSwitches(
      { trafficResetExpiry: true },
      {
        ADDON_RESET_EXPIRY_DAY: 'false',
        ADDON_RESET_EXPIRY_WEEK: 'true',
        ADDON_RESET_EXPIRY_MONTH: 'true',
        ADDON_RESET_EXPIRY_MONTH_ROLLING: 'true',
      },
    )[2]!;

    assert.equal(reset.locked, true);
    assert.equal(reset.enabled, false, 'ON only while every rule is');
  });
});

describe('add-on switches — a change from the page', () => {
  it('is refused whole for a switch .env decides, naming its variables', () => {
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: {},
        // The first change alone would be allowed; the request is refused whole.
        changes: { deviceCleanupAuto: false, trafficResetExpiry: true },
        confirmOff: true,
        env: {
          ADDON_RESET_EXPIRY_DAY: 'false',
          ADDON_RESET_EXPIRY_WEEK: 'off',
          ADDON_RESET_EXPIRY_MONTH: 'no',
          ADDON_RESET_EXPIRY_MONTH_ROLLING: '0',
        },
      }),
      {
        kind: 'SET_IN_ENV',
        switchName: 'trafficResetExpiry',
        variables: [
          'ADDON_RESET_EXPIRY_DAY',
          'ADDON_RESET_EXPIRY_WEEK',
          'ADDON_RESET_EXPIRY_MONTH',
          'ADDON_RESET_EXPIRY_MONTH_ROLLING',
        ],
      },
    );
    // A switch of stages is refused on ONE line.
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: {},
        changes: { durableAccounting: false },
        confirmOff: true,
        env: { ADDON_ENTITLEMENT_SHADOW: 'false' },
      }),
      { kind: 'SET_IN_ENV', switchName: 'durableAccounting', variables: ['ADDON_ENTITLEMENT_SHADOW'] },
    );
    // Even to the value .env already gives it: storing a value the panel
    // cannot apply would only surprise whoever later removes the line.
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: {},
        changes: { deviceCleanupAuto: true },
        confirmOff: false,
        env: { ADDON_DEVICE_CLEANUP_AUTO: 'true' },
      }),
      { kind: 'SET_IN_ENV', switchName: 'deviceCleanupAuto', variables: ['ADDON_DEVICE_CLEANUP_AUTO'] },
    );
  });

  it('N1 gap 3: stores a change to a switch of rules .env decides only in part — it applies to the rules no line names', () => {
    const env = { ADDON_RESET_EXPIRY_DAY: 'false', ADDON_RESET_EXPIRY_MONTH_ROLLING: '0' };
    // Turning it OFF is still a switch-off: asked first.
    assert.deepEqual(
      planAddOnSwitchUpdate({ stored: {}, changes: { trafficResetExpiry: false }, confirmOff: false, env }),
      { kind: 'OFF_NOT_CONFIRMED', switchName: 'trafficResetExpiry' },
    );
    const plan = planAddOnSwitchUpdate({ stored: {}, changes: { trafficResetExpiry: false }, confirmOff: true, env });
    assert.deepEqual(plan, { kind: 'WRITE', next: { trafficResetExpiry: false }, changed: ['trafficResetExpiry'] });
    // …and it moves exactly the rules `.env` leaves to the switch.
    const onlyWeek = { ADDON_RESET_EXPIRY_WEEK: 'true' };
    const stored = plan.kind === 'WRITE' ? plan.next : {};
    assert.deepEqual(resolveAddOnRolloutFlags(stored, onlyWeek).resetExpiry, {
      DAY: false,
      WEEK: true,
      MONTH: false,
      MONTH_ROLLING: false,
    });
  });

  it('asks for confirmation to turn a switch OFF — from its default ON and from a stored ON', () => {
    assert.deepEqual(
      planAddOnSwitchUpdate({ stored: {}, changes: { durableAccounting: false }, confirmOff: false, env: NO_ENV }),
      { kind: 'OFF_NOT_CONFIRMED', switchName: 'durableAccounting' },
    );
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: { trafficResetExpiry: true },
        changes: { trafficResetExpiry: false },
        confirmOff: false,
        env: NO_ENV,
      }),
      { kind: 'OFF_NOT_CONFIRMED', switchName: 'trafficResetExpiry' },
    );
  });

  it('turns a switch OFF once confirmed, keeping the other stored choices', () => {
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: { trafficResetExpiry: true },
        changes: { deviceCleanupAuto: false },
        confirmOff: true,
        env: NO_ENV,
      }),
      { kind: 'WRITE', next: { trafficResetExpiry: true, deviceCleanupAuto: false }, changed: ['deviceCleanupAuto'] },
    );
  });

  it('never asks to turn a switch ON, or to keep an OFF switch OFF', () => {
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: { trafficResetExpiry: false },
        changes: { trafficResetExpiry: true },
        confirmOff: false,
        env: NO_ENV,
      }),
      { kind: 'WRITE', next: { trafficResetExpiry: true }, changed: ['trafficResetExpiry'] },
    );
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: { deviceCleanupAuto: false },
        changes: { deviceCleanupAuto: false },
        confirmOff: false,
        env: NO_ENV,
      }),
      { kind: 'WRITE', next: { deviceCleanupAuto: false }, changed: [] },
    );
  });

  it('lists as changed only the switches whose value moves', () => {
    assert.deepEqual(
      planAddOnSwitchUpdate({
        stored: { deviceCleanupAuto: false, trafficResetExpiry: false },
        changes: { durableAccounting: true, deviceCleanupAuto: true, trafficResetExpiry: true },
        confirmOff: false,
        env: NO_ENV,
      }),
      {
        kind: 'WRITE',
        next: { durableAccounting: true, deviceCleanupAuto: true, trafficResetExpiry: true },
        changed: ['deviceCleanupAuto', 'trafficResetExpiry'],
      },
    );
    // A switch already ON by default does not move when it is turned ON.
    assert.deepEqual(
      planAddOnSwitchUpdate({ stored: {}, changes: { trafficResetExpiry: true }, confirmOff: false, env: NO_ENV }),
      { kind: 'WRITE', next: { trafficResetExpiry: true }, changed: [] },
    );
  });
});

describe('add-on switches — the reader', () => {
  it('asks the reader it is given, and falls back to .env and the defaults without one', async () => {
    const fromReader: AddOnRolloutFlags = resolveAddOnRolloutFlags(
      { durableAccounting: false, deviceCleanupAuto: false },
      NO_ENV,
    );
    let asked = 0;
    const reader = {
      flags: async (): Promise<AddOnRolloutFlags> => {
        asked += 1;
        return fromReader;
      },
    };
    assert.deepEqual(await readAddOnRolloutFlags(reader), fromReader);
    assert.equal(asked, 1);

    const saved = new Map(ADD_ON_ROLLOUT_FLAG_NAMES.map((name) => [name, process.env[name]]));
    try {
      for (const name of ADD_ON_ROLLOUT_FLAG_NAMES) delete process.env[name];
      assert.deepEqual(await readAddOnRolloutFlags(undefined), resolveAddOnRolloutFlags({}, NO_ENV));
      process.env['ADDON_DEVICE_CLEANUP_AUTO'] = 'off';
      assert.equal((await readAddOnRolloutFlags(undefined)).deviceCleanupAuto, false);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('reset capabilities', () => {
  it('open a strategy only while its stage-4 flag is on', () => {
    const flags = resolveAddOnRolloutFlags(
      { trafficResetExpiry: false },
      { ADDON_RESET_EXPIRY_MONTH: 'true', ADDON_RESET_EXPIRY_DAY: '1' },
    );
    assert.deepEqual(resolveResetCapabilities(flags), { DAY: 'ENABLED', MONTH: 'ENABLED' });
    assert.deepEqual(resolveResetCapabilities(resolveAddOnRolloutFlags({ trafficResetExpiry: false }, NO_ENV)), {});
    // The default: every strategy.
    assert.equal(Object.keys(resolveResetCapabilities(resolveAddOnRolloutFlags({}, NO_ENV))).length, 4);
  });

  it('sell nothing «до следующего сброса» while direct purchase is off, and exactly the flag-pure map while it is on', () => {
    const open = resolveAddOnRolloutFlags({ trafficResetExpiry: true }, NO_ENV);
    assert.equal(Object.keys(resolveResetCapabilities(open)).length, 4);
    assert.deepEqual(resolveIntakeResetCapabilities(open), resolveResetCapabilities(open));

    const intakeClosed = resolveAddOnRolloutFlags({ trafficResetExpiry: true, durableAccounting: false }, NO_ENV);
    assert.deepEqual(resolveIntakeResetCapabilities(intakeClosed), {});
    // Expiry and anchoring of goods already sold do not depend on intake.
    assert.equal(Object.keys(resolveResetCapabilities(intakeClosed)).length, 4);
  });
});

describe('where an operator reads about the switches', () => {
  const root = join(__dirname, '..');

  it('.env.example and docs/environment.md no longer offer a stage variable', () => {
    for (const file of ['.env.example', join('docs', 'environment.md')]) {
      const text = readFileSync(join(root, file), 'utf8');
      for (const name of [...ADD_ON_ROLLOUT_FLAG_NAMES, 'ADDON_PROJECTION_SYNC', 'ADDON_RENEWAL_ADDONS']) {
        assert.equal(text.includes(name), false, `${file} must not name ${name}`);
      }
    }
  });

  it('the runbook names the page and every switch as the page renders it, and no deleted stage variable', () => {
    const runbook = readFileSync(join(root, 'docs', 'operator-add-on-entitlements-rollout.md'), 'utf8');
    const page = readFileSync(join(root, 'web', 'src', 'i18n', 'features', 'addOns.ru.ts'), 'utf8');
    for (const label of ['Новый учёт докупок', 'Удалять лишние устройства автоматически', 'Докупка трафика до сброса']) {
      assert.ok(page.includes(`label: '${label}'`), `the page renders «${label}»`);
      assert.ok(runbook.includes(`«${label}»`), `the runbook names «${label}»`);
    }
    assert.ok(page.includes("tab: 'Настройки'"));
    assert.ok(runbook.includes('«Доп. услуги» → tab «Настройки»'));
    assert.ok(page.includes("setInEnv: 'Задано в .env: {{variables}}'"));
    assert.ok(runbook.replace(/\s+/g, ' ').includes('«Задано в .env»'));
    for (const name of ['ADDON_PROJECTION_SYNC', 'ADDON_RENEWAL_ADDONS']) {
      assert.equal(runbook.includes(name), false, `the runbook must not name ${name}`);
    }
  });
});
