import type {
  QuestDaysFallback,
  QuestIconKind,
  QuestPayload,
  QuestRepeat,
  QuestRewardType,
  QuestType,
} from './quests-api'

export interface QuestDraft {
  type: QuestType
  titleRu: string
  titleEn: string
  descRu: string
  descEn: string
  rewardType: QuestRewardType
  rewardAmount: string
  rewardPlanId: string
  daysFallback: QuestDaysFallback
  iconKind: QuestIconKind
  iconRef: string
  subBuckets: string[]
  platforms: string[]
  contactFilters: string[]
  inactiveDays: string
  repeat: QuestRepeat
  cooldownHours: string
  startAt: string
  endAt: string
  maxCompletionsGlobal: string
  requiredFriends: string
  channelId: string
  channelLink: string
  partnerMethod: QuestPartnerMethod
  partnerSlug: string
  partnerCode: string
  partnerLandingUrl: string
  partnerDwellSeconds: string
  enabled: boolean
}

export type QuestPartnerMethod = 'manual_code' | 'postback' | 'timed_visit'

export interface QuestValidationMessages {
  readonly titleRequired: string
  readonly rewardAmountRequired: string
  readonly planRequired: string
  readonly channelLinkRequired: string
  readonly channelLinkInvalid: string
  readonly channelIdInvalid: string
  readonly channelIdRequiredForInvite: string
  readonly windowInvalid: string
  readonly partnerRequired: string
}

export function emptyQuestDraft(): QuestDraft {
  return {
    type: 'LINK_TELEGRAM',
    titleRu: '',
    titleEn: '',
    descRu: '',
    descEn: '',
    rewardType: 'POINTS',
    rewardAmount: '3',
    rewardPlanId: '',
    daysFallback: 'MINT_PROMOCODE',
    iconKind: 'PRESET',
    iconRef: 'telegram',
    subBuckets: [],
    platforms: [],
    contactFilters: [],
    inactiveDays: '',
    repeat: 'ONCE',
    cooldownHours: '',
    startAt: '',
    endAt: '',
    maxCompletionsGlobal: '',
    requiredFriends: '',
    channelId: '',
    channelLink: '',
    partnerMethod: 'manual_code',
    partnerSlug: '',
    partnerCode: '',
    partnerLandingUrl: '',
    partnerDwellSeconds: '',
    enabled: false,
  }
}

function parseIntOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const n = Number.parseInt(trimmed, 10)
  return Number.isFinite(n) ? n : null
}

/** Field-level validation. Returns a map of field → message (empty = valid). */
export function validateQuestDraft(
  draft: QuestDraft,
  messages: QuestValidationMessages,
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.titleRu.trim().length === 0 || draft.titleEn.trim().length === 0) {
    errors.title = messages.titleRequired
  }
  const amount = parseIntOrNull(draft.rewardAmount) ?? 0
  if (draft.rewardType !== 'PROMOCODE' && amount <= 0) {
    errors.rewardAmount = messages.rewardAmountRequired
  }
  if (draft.rewardType === 'DAYS' && draft.daysFallback === 'GRANT_TRIAL' && draft.rewardPlanId.trim().length === 0) {
    errors.rewardPlanId = messages.planRequired
  }
  if (draft.type === 'SUBSCRIBE_CHANNEL') {
    const channelId = draft.channelId.trim()
    const channelLink = draft.channelLink.trim()
    const isPublicLink = isTelegramPublicChannelLink(channelLink)
    const isPrivateInvite = isTelegramPrivateInviteLink(channelLink)

    if (channelLink.length === 0) {
      errors.channelLink = messages.channelLinkRequired
    } else if (!isPublicLink && !isPrivateInvite) {
      errors.channelLink = messages.channelLinkInvalid
    }

    if (channelId.length > 0 && !isTelegramChannelId(channelId)) {
      errors.channelId = messages.channelIdInvalid
    } else if (isPrivateInvite && channelId.length === 0) {
      errors.channelId = messages.channelIdRequiredForInvite
    }
  }
  if (draft.type === 'PARTNER_TASK') {
    if (draft.partnerSlug.trim().length === 0) {
      errors.partnerSlug = messages.partnerRequired
    }
    if (draft.partnerMethod === 'manual_code' && draft.partnerCode.trim().length === 0) {
      errors.partnerCode = messages.partnerRequired
    }
  }
  const start = draft.startAt.trim()
  const end = draft.endAt.trim()
  if (start.length > 0 && end.length > 0 && new Date(end).getTime() <= new Date(start).getTime()) {
    errors.endAt = messages.windowInvalid
  }
  return errors
}

/** Build the API payload from a validated draft. */
export function buildQuestPayload(draft: QuestDraft): QuestPayload {
  const audienceFilter: QuestAudienceFilterDraft = {}
  if (draft.subBuckets.length > 0) audienceFilter.subscription = draft.subBuckets
  if (draft.platforms.length > 0) audienceFilter.platforms = draft.platforms
  if (draft.contactFilters.length > 0) audienceFilter.contact = draft.contactFilters
  const inactive = parseIntOrNull(draft.inactiveDays)
  if (inactive !== null && inactive > 0) audienceFilter.inactiveDays = inactive

  const params: Record<string, unknown> = {}
  if (draft.type === 'INVITE_FRIENDS') {
    const required = parseIntOrNull(draft.requiredFriends)
    if (required !== null && required > 0) params.requiredFriends = required
  }
  if (draft.type === 'SUBSCRIBE_CHANNEL') {
    if (draft.channelId.trim().length > 0) {
      params.channelId = draft.channelId.trim()
    }
    if (draft.channelLink.trim().length > 0) {
      params.channelLink = draft.channelLink.trim()
    }
  }
  if (draft.type === 'PARTNER_TASK' && draft.partnerSlug.trim().length > 0) {
    const partner: Record<string, unknown> = {
      method: draft.partnerMethod,
      partnerSlug: draft.partnerSlug.trim(),
    }
    if (draft.partnerMethod === 'manual_code' && draft.partnerCode.trim().length > 0) {
      partner.code = draft.partnerCode.trim()
    }
    if (draft.partnerLandingUrl.trim().length > 0) {
      partner.landingUrl = draft.partnerLandingUrl.trim()
    }
    if (draft.partnerMethod === 'timed_visit') {
      const dwell = parseIntOrNull(draft.partnerDwellSeconds)
      if (dwell !== null && dwell >= 0) partner.minDwellSeconds = dwell
    }
    params.partner = partner
  }

  return {
    type: draft.type,
    title: { ru: draft.titleRu.trim(), en: draft.titleEn.trim() },
    description: { ru: draft.descRu.trim(), en: draft.descEn.trim() },
    iconKind: draft.iconKind,
    iconRef: draft.iconRef.trim(),
    rewardType: draft.rewardType,
    rewardAmount: parseIntOrNull(draft.rewardAmount) ?? 0,
    rewardPlanId: draft.rewardPlanId.trim().length > 0 ? draft.rewardPlanId.trim() : null,
    daysFallback: draft.daysFallback,
    audienceFilter: Object.keys(audienceFilter).length > 0 ? audienceFilter : null,
    repeat: draft.repeat,
    cooldownHours: draft.repeat === 'REPEATABLE' ? parseIntOrNull(draft.cooldownHours) : null,
    startAt: draft.startAt.trim().length > 0 ? draft.startAt.trim() : null,
    endAt: draft.endAt.trim().length > 0 ? draft.endAt.trim() : null,
    maxCompletionsGlobal: parseIntOrNull(draft.maxCompletionsGlobal),
    params: Object.keys(params).length > 0 ? params : null,
    enabled: draft.enabled,
  }
}

interface QuestAudienceFilterDraft {
  subscription?: string[]
  platforms?: string[]
  contact?: string[]
  inactiveDays?: number
}

export function questToDraft(quest: {
  type: QuestType
  title: { ru: string; en: string }
  description: { ru: string; en: string }
  iconKind: QuestIconKind
  iconRef: string
  rewardType: QuestRewardType
  rewardAmount: number
  rewardPlanId: string | null
  daysFallback: QuestDaysFallback
  audienceFilter: QuestAudienceFilterDraft | null
  repeat: QuestRepeat
  cooldownHours: number | null
  startAt: string | null
  endAt: string | null
  maxCompletionsGlobal: number | null
  params: Record<string, unknown> | null
  enabled: boolean
}): QuestDraft {
  const params = quest.params ?? {}
  const partner = (params.partner ?? {}) as Record<string, unknown>
  const partnerMethod: QuestPartnerMethod =
    partner.method === 'postback' || partner.method === 'timed_visit' ? partner.method : 'manual_code'
  return {
    type: quest.type,
    titleRu: quest.title.ru,
    titleEn: quest.title.en,
    descRu: quest.description.ru,
    descEn: quest.description.en,
    rewardType: quest.rewardType,
    rewardAmount: String(quest.rewardAmount),
    rewardPlanId: quest.rewardPlanId ?? '',
    daysFallback: quest.daysFallback,
    iconKind: quest.iconKind,
    iconRef: quest.iconRef,
    subBuckets: quest.audienceFilter?.subscription ?? [],
    platforms: quest.audienceFilter?.platforms ?? [],
    contactFilters: quest.audienceFilter?.contact ?? [],
    inactiveDays: quest.audienceFilter?.inactiveDays ? String(quest.audienceFilter.inactiveDays) : '',
    repeat: quest.repeat,
    cooldownHours: quest.cooldownHours ? String(quest.cooldownHours) : '',
    startAt: quest.startAt ? quest.startAt.slice(0, 16) : '',
    endAt: quest.endAt ? quest.endAt.slice(0, 16) : '',
    maxCompletionsGlobal: quest.maxCompletionsGlobal ? String(quest.maxCompletionsGlobal) : '',
    requiredFriends: typeof params.requiredFriends === 'number' ? String(params.requiredFriends) : '',
    channelId: typeof params.channelId === 'string' ? params.channelId : '',
    channelLink:
      typeof params.channelLink === 'string'
        ? params.channelLink
        : typeof params.channelUsername === 'string'
          ? `https://t.me/${params.channelUsername.replace(/^@/, '')}`
          : '',
    partnerMethod,
    partnerSlug: typeof partner.partnerSlug === 'string' ? partner.partnerSlug : '',
    partnerCode: typeof partner.code === 'string' ? partner.code : '',
    partnerLandingUrl: typeof partner.landingUrl === 'string' ? partner.landingUrl : '',
    partnerDwellSeconds:
      typeof partner.minDwellSeconds === 'number' ? String(partner.minDwellSeconds) : '',
    enabled: quest.enabled,
  }
}

function isTelegramChannelId(value: string): boolean {
  return /^-100\d{6,20}$/.test(value)
}

function isTelegramPublicChannelLink(value: string): boolean {
  return /^https:\/\/(?:t\.me|telegram\.me)\/[A-Za-z][A-Za-z0-9_]{4,31}\/?$/.test(value)
}

function isTelegramPrivateInviteLink(value: string): boolean {
  return /^https:\/\/(?:t\.me|telegram\.me)\/\+[A-Za-z0-9_-]{5,128}\/?$/.test(value)
}
