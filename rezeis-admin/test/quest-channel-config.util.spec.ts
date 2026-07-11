import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveQuestChannelConfig } from '../src/modules/quests/utils/quest-channel-config.util';

describe('resolveQuestChannelConfig', () => {
  it('resolves a numeric channel id + public join link', () => {
    const cfg = resolveQuestChannelConfig({
      channelId: '-1001234567890',
      channelLink: 'https://t.me/rezeisnews',
    });
    assert.deepStrictEqual(cfg, {
      chatId: '-1001234567890',
      joinUrl: 'https://t.me/rezeisnews',
    });
  });

  it('derives chatId=@username and joinUrl from a public username alone', () => {
    const cfg = resolveQuestChannelConfig({ channelUsername: 'rezeisnews' });
    assert.deepStrictEqual(cfg, {
      chatId: '@rezeisnews',
      joinUrl: 'https://t.me/rezeisnews',
    });
  });

  it('strips a leading @ from a configured username', () => {
    const cfg = resolveQuestChannelConfig({ channelUsername: '@rezeisnews' });
    assert.equal(cfg?.chatId, '@rezeisnews');
  });

  it('derives a public username from a public join link', () => {
    const cfg = resolveQuestChannelConfig({ channelLink: 'https://t.me/rezeisnews' });
    assert.equal(cfg?.chatId, '@rezeisnews');
    assert.equal(cfg?.joinUrl, 'https://t.me/rezeisnews');
  });

  it('accepts a private invite link ONLY with a numeric chat id (cannot prove membership alone)', () => {
    const withId = resolveQuestChannelConfig({
      channelId: '-1009876543210',
      channelLink: 'https://t.me/+AbCdEf12345',
    });
    assert.equal(withId?.chatId, '-1009876543210');
    assert.equal(withId?.joinUrl, 'https://t.me/+AbCdEf12345');

    // Private invite without a numeric id → unverifiable → null.
    assert.equal(
      resolveQuestChannelConfig({ channelLink: 'https://t.me/+AbCdEf12345' }),
      null,
    );
  });

  it('rejects a malformed username even when a link would otherwise suffice', () => {
    assert.equal(
      resolveQuestChannelConfig({
        channelUsername: 'bad name!',
        channelLink: 'https://t.me/rezeisnews',
      }),
      null,
    );
  });

  it('rejects a non-telegram / non-https / query-carrying join link', () => {
    assert.equal(resolveQuestChannelConfig({ channelLink: 'http://t.me/rezeisnews' }), null);
    assert.equal(resolveQuestChannelConfig({ channelLink: 'https://evil.example/rezeisnews' }), null);
    assert.equal(resolveQuestChannelConfig({ channelLink: 'https://t.me/rezeisnews?spy=1' }), null);
    assert.equal(resolveQuestChannelConfig({ channelLink: 'https://t.me/rezeisnews#x' }), null);
  });

  it('rejects a bare numeric id that is not a -100 supergroup/channel id', () => {
    assert.equal(resolveQuestChannelConfig({ channelId: '12345' }), null);
  });

  it('returns null for junk / empty input', () => {
    for (const junk of [null, 42, 'str', [], {}, { channelId: '' }]) {
      assert.equal(resolveQuestChannelConfig(junk as never), null);
    }
  });
});
