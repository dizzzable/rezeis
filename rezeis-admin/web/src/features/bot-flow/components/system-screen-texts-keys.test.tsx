/**
 * The bot texts a built-in screen of «Карта бота» lists, against what reiwa
 * sends from that screen.
 *
 * The invite screen answers with one of three messages INSTEAD of the hub
 * (reiwa `src/bot/pages/invite.ts`): `referral.disabled`, `referral.invited_only`,
 * `referral.link_unavailable`. None was listed, so none could be found or
 * changed on the map. And a few listed texts are shown only on another road —
 * `support.title` is the `/help` command's text, the «Помощь» button shows the
 * screen's own — which the bare key did not say.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { valueAt } from '@/test/i18n-key-paths'
import { renderWithProviders } from '@/test/test-utils'

import { BOT_MAP_DICTIONARIES } from '../page-dictionaries.fixtures'
import { SystemScreenTexts } from './SystemScreenTexts'

// What the route loads with the page: the captions live in it.
beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

function mockTextsApi(): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the invite screen’s texts', () => {
  it.each([
    ['referral.disabled', 'botFlow.screenTexts.captions.referralDisabled'],
    ['referral.invited_only', 'botFlow.screenTexts.captions.referralInvitedOnly'],
    ['referral.link_unavailable', 'botFlow.screenTexts.captions.referralLinkUnavailable'],
  ])('lists %s, the message the bot sends instead of the hub, and says when', async (key, caption) => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="invite" />)

    expect(await screen.findByText(key)).toBeInTheDocument()
    expect(screen.getByText(i18n.t(caption))).toBeInTheDocument()
  })

  it('says which texts a partner gets instead of this screen’s own', async () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="invite" />)

    expect(await screen.findByText('partner.hub.title')).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.screenTexts.captions.partnerTitle'))).toBeInTheDocument()
  })

  it('says the hub’s own title stands only where there is no invite screen', async () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="invite" />)

    expect(await screen.findByText('referral.hub.title')).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.screenTexts.captions.hubTitle'))).toBeInTheDocument()
  })
})

describe('the rules screen’s texts', () => {
  // reiwa `rules.ts`: `findScreenByName(…, 'rules')` first, the pack's text
  // only without that screen — and this editor opens on that very screen.
  it.each([
    ['rules.intro', 'botFlow.screenTexts.captions.rulesIntro'],
    ['rules.unavailable', 'botFlow.screenTexts.captions.rulesUnavailable'],
  ])('says %s is sent only while there is no «rules» screen', async (key, caption) => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="rules" />)

    expect(await screen.findByText(key)).toBeInTheDocument()
    expect(screen.getByText(i18n.t(caption))).toBeInTheDocument()
    // A key missing from a dictionary renders as its own path — and would match above.
    for (const [, dictionary] of BOT_MAP_DICTIONARIES) expect(typeof valueAt(dictionary, caption), caption).toBe('string')
  })
})

describe('the help screen’s texts', () => {
  it('says `support.title` is the /help command’s text, not the button’s', async () => {
    mockTextsApi()
    renderWithProviders(<SystemScreenTexts screenName="help" />)

    expect(await screen.findByText('support.title')).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.screenTexts.captions.supportTitle'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('botFlow.screenTexts.captions.supportNotConfigured'))).toBeInTheDocument()
  })
})
