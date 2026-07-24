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
  channelLinkRequired: 'channel link required',
  channelLinkInvalid: 'channel link invalid',
  channelIdInvalid: 'channel id invalid',
  channelIdRequiredForInvite: 'channel id required for invite',
  windowInvalid: 'window invalid',
  partnerRequired: 'partner required',
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

  it('requires a join link for SUBSCRIBE_CHANNEL', () => {
    expect(validateQuestDraft(draft({ type: 'SUBSCRIBE_CHANNEL' }), messages).channelLink).toBe(
      'channel link required',
    )
  })

  it('accepts a public channel link without a numeric ID', () => {
    expect(
      validateQuestDraft(
        draft({ type: 'SUBSCRIBE_CHANNEL', channelLink: 'https://t.me/rezeisnews' }),
        messages,
      ),
    ).toEqual({})
  })

  it('requires a valid numeric ID together with a private invite link', () => {
    expect(
      validateQuestDraft(
        draft({ type: 'SUBSCRIBE_CHANNEL', channelLink: 'https://t.me/+AbCdEf12345' }),
        messages,
      ).channelId,
    ).toBe('channel id required for invite')
    expect(
      validateQuestDraft(
        draft({
          type: 'SUBSCRIBE_CHANNEL',
          channelId: '-1001234567890',
          channelLink: 'https://t.me/+AbCdEf12345',
        }),
        messages,
      ),
    ).toEqual({})
  })

  it('requires a partner slug for PARTNER_TASK', () => {
    expect(validateQuestDraft(draft({ type: 'PARTNER_TASK' }), messages).partnerSlug).toBe(
      'partner required',
    )
  })

  it('requires a code for a manual_code partner quest', () => {
    const base = draft({ type: 'PARTNER_TASK', partnerSlug: 'acme', partnerMethod: 'manual_code' })
    expect(validateQuestDraft(base, messages).partnerCode).toBe('partner required')
    expect(
      validateQuestDraft({ ...base, partnerCode: 'PROMO' }, messages).partnerCode,
    ).toBeUndefined()
  })

  it('does not require a code for postback / timed_visit', () => {
    expect(
      validateQuestDraft(draft({ type: 'PARTNER_TASK', partnerSlug: 'acme', partnerMethod: 'postback' }), messages)
        .partnerCode,
    ).toBeUndefined()
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

  it('emits a public channel link for SUBSCRIBE_CHANNEL', () => {
    const payload = buildQuestPayload(
      draft({ type: 'SUBSCRIBE_CHANNEL', channelLink: 'https://t.me/rezeisnews' }),
    )
    expect(payload.params).toEqual({ channelLink: 'https://t.me/rezeisnews' })
  })

  it('emits the channel ID and invite link for a private channel', () => {
    const payload = buildQuestPayload(
      draft({
        type: 'SUBSCRIBE_CHANNEL',
        channelId: '-1001234567890',
        channelLink: 'https://t.me/+AbCdEf12345',
      }),
    )
    expect(payload.params).toEqual({
      channelId: '-1001234567890',
      channelLink: 'https://t.me/+AbCdEf12345',
    })
  })

  it('emits a partner block for a manual_code PARTNER_TASK', () => {
    const payload = buildQuestPayload(
      draft({
        type: 'PARTNER_TASK',
        partnerSlug: 'acme',
        partnerMethod: 'manual_code',
        partnerCode: 'PROMO2026',
        partnerLandingUrl: 'https://acme.example/offer',
      }),
    )
    expect(payload.params).toEqual({
      partner: {
        method: 'manual_code',
        partnerSlug: 'acme',
        code: 'PROMO2026',
        landingUrl: 'https://acme.example/offer',
      },
    })
  })

  it('emits a timed_visit partner block with dwell seconds and no code', () => {
    const payload = buildQuestPayload(
      draft({
        type: 'PARTNER_TASK',
        partnerSlug: 'acme',
        partnerMethod: 'timed_visit',
        partnerLandingUrl: 'https://acme.example/land',
        partnerDwellSeconds: '30',
      }),
    )
    expect(payload.params).toEqual({
      partner: {
        method: 'timed_visit',
        partnerSlug: 'acme',
        landingUrl: 'https://acme.example/land',
        minDwellSeconds: 30,
      },
    })
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

  it('restores partner fields from a PARTNER_TASK quest', () => {
    const restored = questToDraft({
      type: 'PARTNER_TASK',
      title: { ru: 'Партнёр', en: 'Partner' },
      description: { ru: '', en: '' },
      iconKind: 'PRESET',
      iconRef: 'gift',
      rewardType: 'POINTS',
      rewardAmount: 5,
      rewardPlanId: null,
      daysFallback: 'MINT_PROMOCODE',
      audienceFilter: null,
      repeat: 'ONCE',
      cooldownHours: null,
      startAt: null,
      endAt: null,
      maxCompletionsGlobal: null,
      params: {
        partner: {
          method: 'timed_visit',
          partnerSlug: 'acme',
          landingUrl: 'https://acme.example/land',
          minDwellSeconds: 30,
        },
      },
      enabled: true,
    })
    expect(restored.type).toBe('PARTNER_TASK')
    expect(restored.partnerMethod).toBe('timed_visit')
    expect(restored.partnerSlug).toBe('acme')
    expect(restored.partnerLandingUrl).toBe('https://acme.example/land')
    expect(restored.partnerDwellSeconds).toBe('30')
  })

  it('restores channel configuration from a SUBSCRIBE_CHANNEL quest', () => {
    const restored = questToDraft({
      type: 'SUBSCRIBE_CHANNEL',
      title: { ru: 'Подписаться', en: 'Subscribe' },
      description: { ru: '', en: '' },
      iconKind: 'PRESET',
      iconRef: 'telegram',
      rewardType: 'POINTS',
      rewardAmount: 5,
      rewardPlanId: null,
      daysFallback: 'MINT_PROMOCODE',
      audienceFilter: null,
      repeat: 'ONCE',
      cooldownHours: null,
      startAt: null,
      endAt: null,
      maxCompletionsGlobal: null,
      params: {
        channelId: '-1001234567890',
        channelLink: 'https://t.me/+AbCdEf12345',
      },
      enabled: true,
    })

    expect(restored.channelId).toBe('-1001234567890')
    expect(restored.channelLink).toBe('https://t.me/+AbCdEf12345')
  })
})
