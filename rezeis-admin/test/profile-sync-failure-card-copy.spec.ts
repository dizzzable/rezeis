import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SyncAction } from '@prisma/client';

import { formatErrorEventCardHtml } from '../src/common/services/error-report.util';
import { clipHtmlCard } from '../src/common/services/system-events.service';
import { syncFailedForGoodCopy } from '../src/modules/profile-sync/profile-sync.processor';
import { SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE } from '../src/modules/remnawave/services/stale-panel-link';

/**
 * What the card for a sync job that failed for good tells the operator to press.
 *
 * The first version sent them to the ↻ on the subscription. That button PULLS:
 * it reads the profile back and writes Remnawave's expiry into the row, so after
 * a failed UPDATE it rolls a paid term back to the old date. And it told them to
 * press «Удалить» again after a failed DELETE, on a subscription that is already
 * DELETED — a no-op. Each case below is one of those, or its neighbour.
 */

const REFUSAL =
  "Refusing to delete Remnawave profile 'p-1' for subscription s-1: it is claimed by subscription s-2, " +
  "which is live on profile 'p-1' (matched over panel id 7). Deleting would take the live profile.";
const STALE =
  `${SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE}: refusing to delete Remnawave profile ` +
  "'0b5a…' for subscription s-1 — that is a 2.x uuid and the panel answers only to 3.x numeric ids.";

describe('the card for a sync that failed for good', () => {
  for (const action of [SyncAction.CREATE, SyncAction.UPDATE]) {
    it(`${action}: sends the operator to «Синхронизировать все», which pushes — and warns off the ↻, which pulls`, () => {
      const { nextSteps } = syncFailedForGoodCopy(action, 5, 'Remnawave answered 400');
      assert.match(nextSteps, /нажмите «Синхронизировать все»/);
      assert.match(nextSteps, /Не значок ↻ у подписки/);
      assert.doesNotMatch(nextSteps, /нажмите у подписки «Синхронизировать»/);
    });
  }

  it('a failed DELETE: the profile is removed by hand, because «Удалить» again does nothing', () => {
    const { why, nextSteps } = syncFailedForGoodCopy(SyncAction.DELETE, 5, 'Remnawave answered 500');
    assert.match(why, /не удалён и продолжает работать/);
    assert.match(nextSteps, /Удалите профиль этого пользователя в Remnawave вручную/);
    assert.match(nextSteps, /повторное «Удалить» ничего не сделает/);
    assert.doesNotMatch(nextSteps, /Синхронизировать/);
  });

  it('a DELETE refused because the profile is another live subscription’s: nobody deletes it', () => {
    const { why, nextSteps } = syncFailedForGoodCopy(SyncAction.DELETE, 5, REFUSAL);
    assert.match(why, /им пользуется другая подписка/);
    assert.match(nextSteps, /Не удаляйте этот профиль в Remnawave/);
    assert.doesNotMatch(nextSteps, /Удалите профиль этого пользователя/);
  });

  it('a DELETE refused over a 2.x uuid: the subscription is gone, so the profile goes by hand', () => {
    const { why, nextSteps } = syncFailedForGoodCopy(SyncAction.DELETE, 5, STALE);
    assert.match(why, /идентификатор Remnawave 2\.x/);
    // The row is DELETED already, so no list can re-link it: «Подписки без
    // привязки к Remnawave» shows live subscriptions only. What is left is the
    // profile in the panel, found by the name it still answers to.
    assert.match(nextSteps, /найдите его там по имени профиля этого пользователя и удалите вручную/);
    assert.match(nextSteps, /Повторять задачу не нужно/);
    assert.doesNotMatch(nextSteps, /Починка привязки к панели/);
  });

  it('a failed traffic reset: the path to the button that says «Сбросить»', () => {
    const { nextSteps } = syncFailedForGoodCopy(SyncAction.TRAFFIC_RESET, 5, 'Remnawave answered 400');
    assert.match(nextSteps, /«Быстрые действия» → «Сброс трафика» → «Сбросить»/);
  });

  it('points at the message BELOW, where the card now prints it', () => {
    for (const action of [SyncAction.CREATE, SyncAction.UPDATE, SyncAction.DELETE, SyncAction.TRAFFIC_RESET]) {
      const { nextSteps } = syncFailedForGoodCopy(action, 5, 'x');
      assert.doesNotMatch(nextSteps, /«💬 Сообщение» выше/, action);
    }
  });

  it('leaves room in a 1024-character caption for the start of the message it points at', () => {
    // The default route on a standard install: no bot token in the panel, the
    // .txt attached, the card sent as that file's caption and clipped from the
    // end. A text that fills the budget cuts off the reason it sends people to.
    const copy = syncFailedForGoodCopy(SyncAction.UPDATE, 5, 'x');
    const card = formatErrorEventCardHtml(
      {
        kind: 'event.system.error',
        severity: 'ERROR',
        category: 'SYSTEM',
        message: 'Profile sync failed: Remnawave refused the update (400): squad not found',
        timestamp: '2026-09-23T10:00:00.000Z',
        metadata: {
          reason: 'profile_sync_failed',
          why: copy.why,
          nextSteps: copy.nextSteps,
          userId: 'cmfq2x9k30000abcdefghijkl',
          telegramId: '5123456789',
          userName: 'Анна Иванова',
          username: 'anna_ivanova',
          login: 'anna_web',
        },
      },
      { version: '0.9.7.68', commit: '1995af6e1234', branch: 'main' },
      true,
      { emoji: '🔄', title: 'Подписка не обновилась в Remnawave' },
    );
    const caption = clipHtmlCard(card, 1024);
    assert.ok(caption.includes('💬 Сообщение: Profile sync failed: Remnawave refused'), caption);
  });
});
