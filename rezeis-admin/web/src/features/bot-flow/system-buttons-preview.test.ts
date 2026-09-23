import { describe, expect, it } from 'vitest'

import { valueAt } from '@/test/i18n-key-paths'

import { BOT_MAP_DICTIONARIES } from './page-dictionaries.fixtures'
import { computeSystemButtons } from './utils'

type Screen = Parameters<typeof computeSystemButtons>[0]

function screenNamed(name: string, overrides: Partial<Screen> = {}): Screen {
  return { name, isRoot: false, buttons: [], ...overrides } as unknown as Screen
}

/**
 * The buttons reiwa adds to its built-in invite screen, as the constructor's
 * canvas draws them. reiwa added «🌐 Скопировать ссылку на сайт» on 22.09.2026
 * and neither this list nor the inspector's preview beside it
 * (`ScreenEditorPanel`) showed it — two copies of the same list, and the
 * operator's picture of the bot was missing a button either way.
 */
describe('the invite screen on the canvas', () => {
  it('shows the website-link button reiwa adds, right after «Скопировать ссылку», where reiwa puts it', () => {
    expect(computeSystemButtons(screenNamed('invite')).map((button) => button.key)).toEqual([
      'invite-share',
      'invite-copy',
      'invite-copy-web',
      'invite-open-cabinet',
      'invite-partner-cabinet',
      'invite-open-exchange',
      'invite-back',
    ])
  })

  /**
   * reiwa `src/bot/pages/invite.ts`: the referral hub ends with «👤 Профиль в
   * кабинете» and «💱 Обменять баллы», the partner hub with «🤝 Партнёрский
   * кабинет» and — while the partner still owns points — the same exchange
   * button, all through `hubButton(t('…'))`. The map drew neither hub's cabinet
   * buttons, so an operator could not find, let alone rename, three buttons
   * every customer who opens «Пригласить» is shown.
   */
  it('shows the cabinet buttons of both hubs, each with the text key the bot reads its caption from', () => {
    const byKey = new Map(computeSystemButtons(screenNamed('invite')).map((b) => [b.key, b]))

    expect(byKey.get('invite-open-cabinet')?.textKey).toBe('referral.hub.open_cabinet')
    expect(byKey.get('invite-open-exchange')?.textKey).toBe('referral.hub.open_exchange')
    expect(byKey.get('invite-partner-cabinet')?.textKey).toBe('partner.hub.open_cabinet')
    // `hubButton` renders through `renderButtonLabel`, not `renderSystemButton`:
    // there is no `bot.sysbtn_icon.*` slot the bot would read for them, so the
    // map must not offer an icon picker that changes nothing.
    for (const key of ['invite-open-cabinet', 'invite-open-exchange', 'invite-partner-cabinet']) {
      expect(byKey.get(key)?.iconKey).toBeUndefined()
    }
  })

  it('pairs every button reiwa renders through `renderSystemButton` with the icon slot it reads', () => {
    const slots = computeSystemButtons(screenNamed('invite')).map((b) => [b.key, b.iconKey, b.textKey])
    expect(slots).toEqual([
      ['invite-share', 'invite_share', 'invite.share_button'],
      ['invite-copy', 'invite_copy', 'invite.copy_button'],
      ['invite-copy-web', 'invite_copy_web', 'invite.copy_web_button'],
      ['invite-open-cabinet', undefined, 'referral.hub.open_cabinet'],
      ['invite-partner-cabinet', undefined, 'partner.hub.open_cabinet'],
      ['invite-open-exchange', undefined, 'referral.hub.open_exchange'],
      ['invite-back', 'back', 'back_to_menu'],
    ])
  })
})

/**
 * A button the bot shows only sometimes says when, or the operator reads the
 * map as a promise the bot does not keep — the website-link button is missing
 * for a bot without a username, the cabinet buttons without an https cabinet,
 * «Партнёрский кабинет» for everybody who is not a partner.
 */
describe('a conditional system button says when the bot shows it', () => {
  const conditions = (name: string, overrides: Partial<Screen> = {}) =>
    Object.fromEntries(
      computeSystemButtons(screenNamed(name, overrides)).map((b) => [b.key, b.conditionKey ?? null]),
    )

  it('names a condition for exactly the buttons reiwa builds behind an `if`', () => {
    expect(conditions('invite')).toEqual({
      'invite-share': null,
      'invite-copy': null,
      'invite-copy-web': 'botFlow.systemButtons.conditions.webLink',
      'invite-open-cabinet': 'botFlow.systemButtons.conditions.referralCabinet',
      'invite-partner-cabinet': 'botFlow.systemButtons.conditions.partnerCabinet',
      'invite-open-exchange': 'botFlow.systemButtons.conditions.exchange',
      'invite-back': null,
    })
    expect(conditions('rules')).toEqual({
      'rules-open': 'botFlow.systemButtons.conditions.rulesOpen',
      'rules-back': null,
    })
    expect(conditions('help')).toEqual({
      'help-open-app': 'botFlow.systemButtons.conditions.helpOpenApp',
      'help-contact': 'botFlow.systemButtons.conditions.helpContact',
      'help-back': null,
    })
    // reiwa `dynamic-screen.ts` appends «◀️ В меню» only while the screen has
    // no buttons of its own: the first button the operator adds removes it.
    expect(conditions('promo')).toEqual({ 'auto-back': 'botFlow.systemButtons.conditions.autoBack' })
  })

  it('has the words for every condition in both languages', () => {
    const keys = ['invite', 'rules', 'help', 'promo'].flatMap((name) =>
      computeSystemButtons(screenNamed(name)).flatMap((b) => [b.labelKey, b.conditionKey ?? []].flat()),
    )
    // As the page has them: the core dictionary with the `botMap` bundle.
    for (const [lng, dictionary] of BOT_MAP_DICTIONARIES) {
      for (const key of keys) {
        expect(typeof valueAt(dictionary, key), `${lng}: ${key}`).toBe('string')
      }
    }
  })
})

describe('the back button of a screen the operator built', () => {
  it('is the bot’s «◀️ В меню», with the icon slot and text key every other back button uses', () => {
    expect(computeSystemButtons(screenNamed('promo'))).toEqual([
      expect.objectContaining({ key: 'auto-back', isBack: true, iconKey: 'back', textKey: 'back_to_menu' }),
    ])
  })

  it('goes once the screen has a button of its own, and never sits under the start screen', () => {
    const withButton = screenNamed('promo', { buttons: [{ id: 'b1' }] as unknown as Screen['buttons'] })
    expect(computeSystemButtons(withButton)).toEqual([])
    expect(computeSystemButtons(screenNamed('start', { isRoot: true }))).toEqual([])
  })
})
