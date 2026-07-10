import { describe, expect, it } from 'vitest'

import {
  buildQuestPayload,
  emptyQuestDraft,
  questToDraft,
  validateQuestDraft,
  type QuestDraft,
  type QuestValidationMessages,
} from './quests-form-schema'

const messages: QuestValidationMessages = {
  titleRequired: 'title required',
  rewardAmountRequired: 'reward required',
  planRequired: 'plan required',
  channelRequired: 'channel required',
  windowInvalid: 'window invalid',
}

function draft(overrides: Partial<QuestDraft> = {}): QuestDraft {
  return { ...emptyQuestDraft(), titleRu: 'Привяжи', titleEn: 'Link', ...overrides }
}

describe('validateQuestDraft', () => {
  it('passes a minimal valid POINTS quest', () => {
    expect(validateQuestDraft(draft(), messages)).toEqual({})
  })

  it('requires a title in both languages', () => {
    expect(validateQuestDraft(draft({ titleEn: '' }), messages).title).toBe('title required')
    expect(validateQuestDraft(draft({ titleRu: '  ' }), messages).title).toBe('title required')
  })

  it('requires a positive reward amount for non-promocode rewards', () => {
    expect(validateQuestDraft(draft({ rewardType: 'DAYS', rewardAmount: '0' }), messages).rewardAmount).toBe(
      'reward required',
    )
    // PROMOCODE ignores amount
    expect(
      validateQuestDraft(draft({ rewardType: 'PROMOCODE', rewardAmount: '0' }), messages).rewardAmount,
    ).toBeUndefined()
  })

  it('requires a plan only when granting a trial for DAYS', () => {
    const base = draft({ rewardType: 'DAYS', rewardAmount: '3', daysFallback: 'GRANT_TRIAL' })
    expect(validateQuestDraft(base, messages).rewardPlanId).toBe('plan required')
    expect(validateQuestDraft({ ...base, rewardPlanId: 'plan_1' }, messages).rewardPlanId).toBeUndefined()
    // MINT_PROMOCODE fallback does not need a plan
    expect(
      validateQuestDraft({ ...base, daysFallback: 'MINT_PROMOCODE' }, messages).rewardPlanId,
    ).toBeUndefined()
  })

  it('requires a channel id for SUBSCRIBE_CHANNEL', () => {
    expect(validateQuestDraft(draft({ type: 'SUBSCRIBE_CHANNEL' }), messages).channelId).toBe(
      'channel required',
    )
  })

  it('rejects an end date before start date', () => {
    const bad = draft({ startAt: '2026-07-10T12:00', endAt: '2026-07-09T12:00' })
    expect(validateQuestDraft(bad, messages).endAt).toBe('window invalid')
  })
})

describe('buildQuestPayload', () => {
  it('builds a clean POINTS payload with no audience filter or params', () => {
    const payload = buildQuestPayload(draft({ rewardAmount: '5' }))
    expect(payload.type).toBe('LINK_TELEGRAM')
    expect(payload.rewardType).toBe('POINTS')
    expect(payload.rewardAmount).toBe(5)
    expect(payload.audienceFilter).toBeNull()
    expect(payload.params).toBeNull()
    expect(payload.cooldownHours).toBeNull()
    expect(payload.rewardPlanId).toBeNull()
  })

  it('serializes the audience filter only for non-empty categories', () => {
    const payload = buildQuestPayload(
      draft({ subBuckets: ['ACTIVE'], platforms: ['web'], inactiveDays: '14' }),
    )
    expect(payload.audienceFilter).toEqual({
      subscription: ['ACTIVE'],
      platforms: ['web'],
      inactiveDays: 14,
    })
  })

  it('emits requiredFriends param for INVITE_FRIENDS', () => {
    const payload = buildQuestPayload(draft({ type: 'INVITE_FRIENDS', requiredFriends: '3' }))
    expect(payload.params).toEqual({ requiredFriends: 3 })
  })

  it('emits channelId param for SUBSCRIBE_CHANNEL', () => {
    const payload = buildQuestPayload(
      draft({ type: 'SUBSCRIBE_CHANNEL', channelId: '-100123' }),
    )
    expect(payload.params).toEqual({ channelId: '-100123' })
  })

  it('sets cooldownHours only for repeatable quests', () => {
    expect(buildQuestPayload(draft({ repeat: 'ONCE', cooldownHours: '24' })).cooldownHours).toBeNull()
    expect(
      buildQuestPayload(draft({ repeat: 'REPEATABLE', cooldownHours: '24' })).cooldownHours,
    ).toBe(24)
  })
})

describe('questToDraft round-trip', () => {
  it('restores a draft from a persisted quest shape', () => {
    const restored = questToDraft({
      type: 'INVITE_FRIENDS',
      title: { ru: 'Пригласи', en: 'Invite' },
      description: { ru: '', en: '' },
      iconKind: 'PRESET',
      iconRef: 'friends',
      rewardType: 'DAYS',
      rewardAmount: 7,
      rewardPlanId: 'plan_1',
      daysFallback: 'GRANT_TRIAL',
      audienceFilter: { subscription: ['NONE'] },
      repeat: 'REPEATABLE',
      cooldownHours: 12,
      startAt: '2026-07-10T12:00:00.000Z',
      endAt: null,
      maxCompletionsGlobal: 100,
      params: { requiredFriends: 3 },
      enabled: true,
    })
    expect(restored.type).toBe('INVITE_FRIENDS')
    expect(restored.requiredFriends).toBe('3')
    expect(restored.subBuckets).toEqual(['NONE'])
    expect(restored.cooldownHours).toBe('12')
    expect(restored.startAt).toBe('2026-07-10T12:00')
    expect(restored.enabled).toBe(true)
  })
})
