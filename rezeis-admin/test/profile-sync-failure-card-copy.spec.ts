import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SyncAction } from '@prisma/client';

import { syncFailedForGoodCopy } from '../src/modules/profile-sync/profile-sync.processor';

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

describe('the card for a sync that failed for good', () => {
  for (const action of [SyncAction.CREATE, SyncAction.UPDATE]) {
    it(`${action}: sends the operator to «Синхронизировать все», which pushes — and warns off the ↻, which pulls`, () => {
      const { nextSteps } = syncFailedForGoodCopy(action, 5, 'Remnawave answered 400');
      assert.match(nextSteps, /нажмите «Синхронизировать все»/);
      assert.match(nextSteps, /Значок ↻ у отдельной подписки для этого не подходит/);
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

  it('a DELETE the processor refused: the profile is another live subscription’s, and nobody deletes it', () => {
    const { why, nextSteps } = syncFailedForGoodCopy(SyncAction.DELETE, 5, REFUSAL);
    assert.match(why, /им пользуется другая подписка/);
    assert.match(nextSteps, /Не удаляйте этот профиль в Remnawave/);
    assert.doesNotMatch(nextSteps, /Удалите профиль этого пользователя/);
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
});
