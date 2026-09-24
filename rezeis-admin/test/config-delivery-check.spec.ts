import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigDeliveryCheckProcessor } from '../src/modules/bot-config/config-versions/config-delivery-check.processor';
import { ConfigDeliveryCheckService } from '../src/modules/bot-config/config-versions/config-delivery-check.service';
import type {
  ConfigDeliveryReport,
  ConfigDeliveryState,
  ConfigHintOutcome,
} from '../src/modules/bot-config/config-versions/config-delivery-state';
import {
  CONFIG_DELIVERY_CHECK_DELAY_MS,
  CONFIG_DELIVERY_CHECK_JOB,
  type ConfigDeliveryCheckJobData,
  type ConfigVersionConsumer,
  type ConfigVersionKey,
} from '../src/modules/bot-config/config-versions/config-versions.constants';
import type { ConfigVersionsService } from '../src/modules/bot-config/config-versions/config-versions.service';
import type { UndeliveredRecord } from '../src/modules/notifications/undelivered-record';

/**
 * "Did the operator's save reach the cabinet?" — two minutes after it
 * ════════════════════════════════════════════════════════════════════
 * The owner's rule (24.09.2026): a warning ONLY if a change has not reached the
 * cabinet within two minutes. It used to be two failed hint attempts ten seconds
 * apart — a card about a hint the cabinet's own poll no longer needed, and no
 * card at all when the hint arrived and the cabinet still did not take the
 * change.
 *
 * The evidence is what each cabinet process reports it HOLDS when it polls,
 * against what the database says two minutes after the save. The hint's own
 * outcome is the fallback evidence, for a process gone quiet and for a cabinet
 * too old to report.
 */

const SAVED_AT = 1_700_000_000_000;
const CHECK_AT = SAVED_AT + CONFIG_DELIVERY_CHECK_DELAY_MS;
const OLD = 'a'.repeat(32);
const NEW = 'b'.repeat(32);

interface World {
  versions: Partial<Record<ConfigVersionKey, string>>;
  reports: Record<ConfigVersionConsumer, ConfigDeliveryReport | null>;
  latestSave: Partial<Record<ConfigVersionKey, number>>;
  hint: ConfigHintOutcome | null;
}

function world(overrides: Partial<World> = {}): World {
  return {
    versions: { publicConfig: NEW, customEmojiPacks: NEW, botConfig: NEW, platformPolicy: NEW },
    reports: { api: null, bot: null },
    latestSave: {},
    hint: null,
    ...overrides,
  };
}

function report(held: ConfigDeliveryReport['held'], ageMs = 10_000): ConfigDeliveryReport {
  return { held, reportedAt: CHECK_AT - ageMs };
}

function build(state: World, options: { queueRefuses?: boolean } = {}) {
  const records: UndeliveredRecord[] = [];
  const adds: Array<{ name: string; data: ConfigDeliveryCheckJobData; opts: Record<string, unknown> }> = [];
  const busts: number[] = [];
  const marks: Array<{ group: ConfigVersionKey; savedAt: number }> = [];
  const outcomes: ConfigHintOutcome[] = [];
  let bustedBeforeFirstAwait = false;
  const versions = {
    bust: () => busts.push(Date.now()),
    current: async (opts?: { fresh?: boolean }) => {
      assert.equal(opts?.fresh, true, 'the check reads the database, not the poll cache');
      return state.versions;
    },
  } as unknown as ConfigVersionsService;
  const deliveryState = {
    markSave: async (group: ConfigVersionKey, savedAt: number) => {
      bustedBeforeFirstAwait ||= busts.length > 0;
      marks.push({ group, savedAt });
    },
    latestSave: async (group: ConfigVersionKey) => state.latestSave[group] ?? null,
    reports: async () => state.reports,
    hintOutcome: async () => state.hint,
    recordHintOutcome: async (_event: string, outcome: ConfigHintOutcome) => {
      outcomes.push(outcome);
    },
  } as unknown as ConfigDeliveryState;
  const queue = {
    add: async (name: string, data: ConfigDeliveryCheckJobData, opts: Record<string, unknown>) => {
      if (options.queueRefuses === true) throw new Error('READONLY You can’t write against a read only replica');
      adds.push({ name, data, opts });
      return { id: 'job-1' };
    },
  };
  const service = new ConfigDeliveryCheckService(
    versions,
    deliveryState,
    queue as never,
    (record) => {
      records.push(record);
    },
  );
  return { service, records, adds, busts, marks, outcomes, bustedFirst: () => bustedBeforeFirstAwait };
}

function job(event: ConfigDeliveryCheckJobData['event'], groups: ConfigVersionKey[]): ConfigDeliveryCheckJobData {
  return { event, groups, savedAt: SAVED_AT, reason: 'branding.primary' };
}

describe('when a hint is sent', () => {
  it('busts the versions first, marks the save per group, and checks it two minutes later', async () => {
    const { service, adds, marks, busts, bustedFirst } = build(world());

    await service.hintSent('reiwa.branding.invalidate', 'branding.primary');

    assert.equal(busts.length, 1);
    assert.ok(bustedFirst(), 'the bust comes before anything that waits: a poll after the hint is told the save');
    assert.deepEqual(
      marks.map((mark) => mark.group),
      ['publicConfig', 'customEmojiPacks'],
    );
    assert.equal(adds.length, 1);
    const added = adds[0] as (typeof adds)[number];
    assert.equal(added.name, CONFIG_DELIVERY_CHECK_JOB);
    assert.deepEqual(added.data.groups, ['publicConfig', 'customEmojiPacks']);
    assert.equal(added.data.event, 'reiwa.branding.invalidate');
    assert.equal(added.opts['delay'], 120_000, 'two minutes — the owner’s number, written out');
    assert.equal(added.opts['attempts'], 1);
  });

  it('never fails the save when the queue refuses the check', async () => {
    const { service } = build(world(), { queueRefuses: true });
    await assert.doesNotReject(() => service.hintSent('reiwa.landing.invalidate', 'publish'));
  });

  it('keeps the relay’s final word on the hint', async () => {
    const { service, outcomes } = build(world());
    await service.hintSettled('reiwa.bot.invalidate', false, 'timeout');
    assert.equal(outcomes.length, 1);
    assert.equal((outcomes[0] as ConfigHintOutcome).delivered, false);
    assert.equal((outcomes[0] as ConfigHintOutcome).status, 'timeout');
  });
});

describe('the check, two minutes after the save', () => {
  it('stays quiet when every process that polls holds the current version', async () => {
    const { service, records } = build(
      world({
        reports: {
          api: report({ publicConfig: NEW, customEmojiPacks: NEW }),
          bot: report({ botConfig: OLD, platformPolicy: NEW }),
        },
      }),
    );

    const findings = await service.check(job('reiwa.branding.invalidate', ['publicConfig', 'customEmojiPacks']), CHECK_AT);

    // The bot's old bot config is not this save's business.
    assert.deepEqual(findings, []);
    assert.deepEqual(records, []);
  });

  it('counts "holds nothing" as delivered: its next read asks the panel', async () => {
    const { service, records } = build(world({ reports: { api: report({ publicConfig: null }), bot: null } }));
    assert.deepEqual(await service.check(job('reiwa.branding.invalidate', ['publicConfig']), CHECK_AT), []);
    assert.deepEqual(records, []);
  });

  it('warns when a process that polls still holds the old version — the change was not taken', async () => {
    const { service, records } = build(
      world({ reports: { api: report({ publicConfig: OLD, customEmojiPacks: NEW }), bot: null } }),
    );

    const findings = await service.check(job('reiwa.branding.invalidate', ['publicConfig', 'customEmojiPacks']), CHECK_AT);

    assert.deepEqual(findings, [{ cause: 'stale', group: 'publicConfig', consumer: 'api', held: OLD, current: NEW }]);
    assert.equal(records.length, 1);
    const card = records[0] as UndeliveredRecord;
    assert.equal(card.metadata['relayEvent'], 'reiwa.branding.invalidate');
    assert.equal(card.metadata['relayStatus'], 'not-applied');
    assert.equal(card.metadata['reason'], 'config_not_delivered');
    assert.match(String(card.metadata['why']), /оформление кабинета/);
    assert.match(String(card.metadata['why']), /сайт кабинета/);
    // How the operator checks it, in the card itself.
    assert.match(String(card.metadata['why']), /обновите страницу/);
    assert.match(String(card.metadata['why']), /\/start/);
  });

  it('a process gone quiet, with the hint delivered, is delivered: the poll is what fails, not the change', async () => {
    const { service, records } = build(
      world({
        reports: { api: report({ publicConfig: OLD }, 5 * 60_000), bot: null },
        hint: { delivered: true, status: 'unconfirmed', at: SAVED_AT + 1_000 },
      }),
    );
    assert.deepEqual(await service.check(job('reiwa.branding.invalidate', ['publicConfig']), CHECK_AT), []);
    assert.deepEqual(records, []);
  });

  it('a process gone quiet with the hint not delivered either: nothing says it arrived', async () => {
    const { service, records } = build(
      world({
        reports: { api: report({ publicConfig: OLD }, 5 * 60_000), bot: null },
        hint: { delivered: false, status: 'failed', at: SAVED_AT + 11_000 },
      }),
    );

    const findings = await service.check(job('reiwa.branding.invalidate', ['publicConfig']), CHECK_AT);

    assert.equal(findings.length, 1);
    assert.equal((findings[0] as { cause: string }).cause, 'silent');
    const card = records[0] as UndeliveredRecord;
    assert.equal(card.metadata['relayStatus'], 'no-check-in');
    assert.match(String(card.metadata['why']), /docker compose ps/);
    assert.match(String(card.metadata['why']), /REZEIS_HOST/);
  });

  it('judges a quiet process by THIS save’s hint, not an older one of the same kind', async () => {
    const { service, records } = build(
      world({
        reports: { api: report({ publicConfig: OLD }, 5 * 60_000), bot: null },
        hint: { delivered: true, status: 'unconfirmed', at: SAVED_AT - 60_000 },
      }),
    );
    const findings = await service.check(job('reiwa.branding.invalidate', ['publicConfig']), CHECK_AT);
    assert.equal(findings.length, 1);
    assert.equal(records.length, 1);
  });

  it('a cabinet too old to report: the hint is the only evidence, as before', async () => {
    const lost = build(world({ hint: { delivered: false, status: 'timeout', at: SAVED_AT + 11_000 } }));
    const findings = await lost.service.check(job('reiwa.bot.invalidate', ['botConfig']), CHECK_AT);
    assert.deepEqual(findings, [{ cause: 'hint-lost', group: 'botConfig', hintStatus: 'timeout' }]);
    assert.equal((lost.records[0] as UndeliveredRecord).metadata['relayStatus'], 'timeout');

    // Delivered, or never sent (the webhook not configured): quiet.
    const delivered = build(world({ hint: { delivered: true, status: 'unconfirmed', at: SAVED_AT + 500 } }));
    assert.deepEqual(await delivered.service.check(job('reiwa.bot.invalidate', ['botConfig']), CHECK_AT), []);
    const none = build(world());
    assert.deepEqual(await none.service.check(job('reiwa.bot.invalidate', ['botConfig']), CHECK_AT), []);
    assert.deepEqual([...delivered.records, ...none.records], []);
  });

  it('leaves a group a later save owns to that save’s check', async () => {
    // Two saves a minute apart are judged by the second one's deadline.
    const { service, records } = build(
      world({
        reports: { api: report({ publicConfig: OLD }), bot: null },
        latestSave: { publicConfig: SAVED_AT + 60_000 },
      }),
    );
    assert.deepEqual(await service.check(job('reiwa.branding.invalidate', ['publicConfig']), CHECK_AT), []);
    assert.deepEqual(records, []);
  });

  it('says nothing about a group whose version cannot be read right now', async () => {
    const { service, records } = build(
      world({ versions: { customEmojiPacks: NEW }, reports: { api: report({ publicConfig: OLD }), bot: null } }),
    );
    assert.deepEqual(await service.check(job('reiwa.branding.invalidate', ['publicConfig']), CHECK_AT), []);
    assert.deepEqual(records, []);
  });

  it('raises one card per cause, naming every group and process it covers', async () => {
    const { service, records } = build(
      world({
        reports: {
          api: report({ publicConfig: OLD, platformPolicy: OLD }),
          bot: report({ platformPolicy: OLD }),
        },
      }),
    );

    await service.check(job('reiwa.platform.policy_invalidated', ['platformPolicy', 'publicConfig']), CHECK_AT);

    assert.equal(records.length, 1, 'three stale copies of one save are one card');
    assert.equal(
      (records[0] as UndeliveredRecord).signature,
      JSON.stringify(['config-delivery', 'not-applied', ['api:platformPolicy', 'api:publicConfig', 'bot:platformPolicy']]),
    );
  });

  it('gives the same cause the same signature on every save, so the alert gate coalesces it', async () => {
    const make = () =>
      build(world({ reports: { api: report({ publicConfig: OLD }, 5 * 60_000), bot: null } }));
    const first = make();
    const second = make();
    await first.service.check(job('reiwa.branding.invalidate', ['publicConfig']), CHECK_AT);
    await second.service.check({ ...job('reiwa.branding.invalidate', ['publicConfig']), reason: 'another save' }, CHECK_AT);
    assert.equal((first.records[0] as UndeliveredRecord).signature, (second.records[0] as UndeliveredRecord).signature);
  });

  it('runs on its queue: the processor hands the job to the check', async () => {
    // The processor checks at the real clock, so the report is anchored to it.
    const { service, records } = build(
      world({ reports: { api: { held: { publicConfig: OLD }, reportedAt: Date.now() - 10_000 }, bot: null } }),
    );
    const processor = new ConfigDeliveryCheckProcessor(service);
    const outcome = await processor.process({
      id: 'job-1',
      data: { ...job('reiwa.branding.invalidate', ['publicConfig']), savedAt: Date.now() - CONFIG_DELIVERY_CHECK_DELAY_MS },
    } as never);
    assert.deepEqual(outcome, { findings: 1 });
    assert.equal((records[0] as UndeliveredRecord).metadata['relayStatus'], 'not-applied');
  });
});
