/**
 * What the bot shows that the flow graph has no block for — the map's copy of
 * it, so an operator can see it and configure it («Карта бота» shows every
 * button and text the bot really has; owner's rule, 23.09.2026).
 *
 * Two parts:
 *   • the main menu's own additions — the buttons and texts reiwa builds
 *     around the operator's menu buttons (`start.ts`, `main-keyboard.ts`,
 *     `trial-button.ts`, `bot-message/message-builder.ts`);
 *   • the bot's built-in screens with no block — `SYSTEM_SCREENS`, one per
 *     message reiwa sends from `src/bot/pages/**` that no flow screen stands
 *     in for: the language picker, the channel gate's prompt, the channel
 *     quest, the return from a payment, the password reset, `/paysupport`,
 *     the error message, AI support, the `/` command list, the answer to a
 *     button onto a deleted screen and the one-line service answers.
 *
 * Every text key and button here is one reiwa reads; each entry names where.
 * A button's `iconKey` is given only where reiwa renders it through
 * `renderSystemButton(…, '<iconKey>', …)` — the only buttons whose icon it
 * reads from `bot.sysbtn_icon.<iconKey>`. Keep this in step with reiwa: a
 * button or text added there and not here is a thing nobody can configure.
 */
import type { SystemButtonPreview } from './types'

/**
 * The trial button reiwa puts on top of the main menu for a customer with no
 * active subscription while a trial is on offer — `resolveTrialButton`
 * (`widgets/trial-button.ts`): «Попробовать бесплатно» from `menu.btn_trial_free`,
 * or `menu.btn_trial_paid` with the price for a paid trial. Its icon is the
 * emoji registry's TRIAL / GIFT / PROMO, not a system-button slot.
 */
export const MAIN_MENU_SYSTEM_BUTTONS: readonly SystemButtonPreview[] = [
  {
    key: 'menu-trial',
    labelKey: 'botFlow.systemButtons.mainMenu.trial',
    isBack: false,
    textKey: 'menu.btn_trial_free',
    conditionKey: 'botFlow.systemButtons.conditions.trial',
  },
  {
    key: 'menu-trial-paid',
    labelKey: 'botFlow.systemButtons.mainMenu.trialPaid',
    isBack: false,
    textKey: 'menu.btn_trial_paid',
    conditionKey: 'botFlow.systemButtons.conditions.trialPaid',
  },
]

/**
 * The main menu's own additions as the canvas node and the «Список» card draw
 * them: the trial button once — it is one button with two captions, and the
 * inspector edits both (`MAIN_MENU_SYSTEM_BUTTONS`).
 */
export const MAIN_MENU_CHIPS: readonly SystemButtonPreview[] = MAIN_MENU_SYSTEM_BUTTONS.slice(0, 1)

/**
 * The texts the bot writes around the greeting: the greeting itself when the
 * start screen has none (`bot.welcome_message`), the line it sends instead of
 * an empty one (`menu.choose_action`, also the answer to the old `back_to_menu`
 * button, `menu.ts`), and the subscription lines under it
 * (`buildProfileSummary`).
 */
export const MAIN_MENU_TEXT_KEYS: readonly string[] = [
  'bot.welcome_message',
  'menu.choose_action',
  'profile.subscription',
  'profile.devices',
  'profile.devices_unlimited',
  'profile.traffic',
  'profile.unlimited',
  'profile.until',
  'common.not_available',
]

/**
 * The reiwa i18n keys each built-in screen of the flow renders from, shown in
 * its inspector (`SystemScreenTexts`). Keyed by the lowercase screen name (the
 * `name` operators give the built-in screens, reiwa's `SCREEN_OVERRIDE_NAME`
 * sentinels).
 */
export const SCREEN_TEXT_KEYS: Readonly<Record<string, readonly string[]>> = {
  invite: [
    'referral.hub.title',
    'referral.hub.description',
    'referral.hub.stat_invited',
    'referral.hub.stat_qualified',
    'referral.hub.stat_pending',
    'referral.hub.stat_points',
    'referral.hub.link_label',
    // The website link, since 22.09.2026 (reiwa `src/bot/pages/invite.ts`):
    // its label under the Telegram link, its copy button, and the line that
    // carries it in the message «Поделиться» sends.
    'referral.hub.web_link_label',
    'referral.hub.open_cabinet',
    'referral.hub.open_exchange',
    'invite.share_button',
    'invite.copy_button',
    'invite.copy_web_button',
    'invite.share_prompt',
    'invite.share_web_line',
    // «Поделиться» on the cabinet's referral page (reiwa
    // `src/bot/pages/inline-share.ts`): it opens Telegram's inline composer and
    // the bot answers with one result — `title` and `description` are what the
    // sender picks in the composer, `message` is what is sent (the bot adds the
    // link under it), `open` is the button under the message. The `_plain`
    // three stand in when the sender has no referral link to share (a stranger,
    // invite-only admission, the program paused), and `start` is the composer's
    // button offering such a sender the bot.
    'inline.share.message',
    'inline.share.title',
    'inline.share.description',
    'inline.share.open',
    'inline.share.message_plain',
    'inline.share.title_plain',
    'inline.share.description_plain',
    'inline.share.start',
    'partner.hub.title',
    'partner.hub.description',
    'partner.hub.stat_balance',
    'partner.hub.stat_earned',
    'partner.hub.stat_referred',
    'partner.hub.open_cabinet',
    // What the invite button answers INSTEAD of a hub, each with «◀️ В меню»
    // under it (reiwa `invite.ts`): the program switched off for a
    // non-partner, the program open only to invited users, and a link there is
    // nothing to build from.
    'referral.disabled',
    'referral.invited_only',
    'referral.link_unavailable',
  ],
  rules: ['rules.intro', 'rules.unavailable', 'rules.open_button'],
  help: [
    'support.title',
    'support.not_configured',
    'help.open_app_button',
    'help.contact_button',
    'help.contact_prefill',
    'help.contact_support',
  ],
}

/** A text a built-in screen sends, with a caption saying when where the key does not. */
export interface SystemScreenText {
  readonly key: string
  readonly captionKey?: string
}

/** A screen the bot builds by itself that no flow block stands in for. */
export interface SystemScreen {
  /** Stable id; its canvas node is `system:<id>` (`systemScreenNodeId`). */
  readonly id: string
  readonly titleKey: string
  /** i18n key: how a customer gets to it. */
  readonly triggerKey: string
  readonly buttons: readonly SystemButtonPreview[]
  readonly texts: readonly SystemScreenText[]
}

const CAPTION = 'botFlow.systemScreens.captions'

/** `help.contact_button` → the support chat — the same system button as on the help screen. */
function contactButton(key: string): SystemButtonPreview {
  return {
    key,
    labelKey: 'botFlow.systemButtons.help.contact',
    isBack: false,
    iconKey: 'help_contact',
    textKey: 'help.contact_button',
    conditionKey: 'botFlow.systemButtons.conditions.helpContact',
  }
}

/** «📢 Перейти в канал» and «✅ Я подписался» — `inlineButton(t(…))`, no icon slot. */
function channelButtons(prefix: string, joinConditionKey?: string): readonly SystemButtonPreview[] {
  return [
    {
      key: `${prefix}-join`,
      labelKey: 'botFlow.systemScreens.buttons.channelJoin',
      isBack: false,
      textKey: 'channel.join_button',
      ...(joinConditionKey !== undefined ? { conditionKey: joinConditionKey } : {}),
    },
    {
      key: `${prefix}-check`,
      labelKey: 'botFlow.systemScreens.buttons.channelCheck',
      isBack: false,
      textKey: 'channel.check_button',
    },
  ]
}

export const SYSTEM_SCREENS: readonly SystemScreen[] = [
  {
    // `pages/channel-join-prompt.ts` (`sendChannelJoinPrompt`), sent by `/start`
    // and by the gate middleware in front of every other update; the answers to
    // «Я подписался» are `menu.ts`.
    id: 'channelGate',
    titleKey: 'botFlow.systemScreens.channelGate.title',
    triggerKey: 'botFlow.systemScreens.channelGate.trigger',
    buttons: channelButtons('channel-gate', 'botFlow.systemButtons.conditions.channelJoin'),
    texts: [
      { key: 'channel.required', captionKey: `${CAPTION}.channelRequired` },
      { key: 'channel.not_subscribed', captionKey: `${CAPTION}.channelNotSubscribed` },
      { key: 'channel.verified', captionKey: `${CAPTION}.channelVerified` },
    ],
  },
  {
    // `pages/quest-channel.ts` (`replyWithQuestChannelPrompt` and the
    // `quest_channel:<id>` check), reached by `/start quest_channel_<id>`.
    id: 'questChannel',
    titleKey: 'botFlow.systemScreens.questChannel.title',
    triggerKey: 'botFlow.systemScreens.questChannel.trigger',
    buttons: channelButtons('quest-channel'),
    texts: [
      { key: 'quests.channel.prompt', captionKey: `${CAPTION}.questPrompt` },
      { key: 'quests.channel.verified', captionKey: `${CAPTION}.questVerified` },
      { key: 'quests.channel.not_subscribed', captionKey: `${CAPTION}.questNotSubscribed` },
      { key: 'quests.channel.retry', captionKey: `${CAPTION}.questRetry` },
      { key: 'quests.channel.link_first', captionKey: `${CAPTION}.questLinkFirst` },
    ],
  },
  {
    // `pages/lang.ts`: `/lang`, then `lang:<code>`.
    id: 'lang',
    titleKey: 'botFlow.systemScreens.lang.title',
    triggerKey: 'botFlow.systemScreens.lang.trigger',
    buttons: [
      { key: 'lang-ru', labelKey: 'botFlow.systemScreens.buttons.langRu', isBack: false, textKey: 'lang.ru' },
      { key: 'lang-en', labelKey: 'botFlow.systemScreens.buttons.langEn', isBack: false, textKey: 'lang.en' },
    ],
    texts: [
      { key: 'lang.choose', captionKey: `${CAPTION}.langChoose` },
      { key: 'lang.changed', captionKey: `${CAPTION}.langChanged` },
      { key: 'lang.name.ru', captionKey: `${CAPTION}.langName` },
      { key: 'lang.name.en', captionKey: `${CAPTION}.langName` },
    ],
  },
  {
    // `pages/start.ts`, `/start payment_return`.
    id: 'paymentReturn',
    titleKey: 'botFlow.systemScreens.paymentReturn.title',
    triggerKey: 'botFlow.systemScreens.paymentReturn.trigger',
    buttons: [
      {
        key: 'payment-return-open',
        labelKey: 'botFlow.systemScreens.buttons.paymentReturnOpen',
        isBack: false,
        textKey: 'payment_return.open_app',
        conditionKey: 'botFlow.systemButtons.conditions.paymentReturnOpen',
      },
    ],
    texts: [{ key: 'payment_return.title' }],
  },
  {
    // `pages/password-reset.ts`, `/start pwreset`.
    id: 'passwordReset',
    titleKey: 'botFlow.systemScreens.passwordReset.title',
    triggerKey: 'botFlow.systemScreens.passwordReset.trigger',
    buttons: [
      {
        key: 'password-reset-open',
        labelKey: 'botFlow.systemScreens.buttons.passwordReset',
        isBack: false,
        textKey: 'password_reset.button',
        conditionKey: 'botFlow.systemButtons.conditions.passwordReset',
      },
    ],
    texts: [
      { key: 'password_reset.link', captionKey: `${CAPTION}.passwordResetLink` },
      { key: 'password_reset.no_account', captionKey: `${CAPTION}.passwordResetNoAccount` },
      { key: 'password_reset.recently_sent', captionKey: `${CAPTION}.passwordResetRecentlySent` },
      { key: 'password_reset.hourly_limit', captionKey: `${CAPTION}.passwordResetHourlyLimit` },
      { key: 'password_reset.unavailable', captionKey: `${CAPTION}.passwordResetUnavailable` },
    ],
  },
  {
    // `pages/paysupport.ts`, `/paysupport`.
    id: 'paysupport',
    titleKey: 'botFlow.systemScreens.paysupport.title',
    triggerKey: 'botFlow.systemScreens.paysupport.trigger',
    buttons: [
      contactButton('paysupport-contact'),
      {
        key: 'paysupport-back',
        labelKey: 'botFlow.systemButtons.back',
        isBack: true,
        iconKey: 'back',
        textKey: 'back_to_menu',
      },
    ],
    texts: [
      { key: 'paysupport.body', captionKey: `${CAPTION}.paysupportBody` },
      { key: 'paysupport.unavailable', captionKey: `${CAPTION}.paysupportUnavailable` },
      { key: 'paysupport.prefill', captionKey: `${CAPTION}.paysupportPrefill` },
    ],
  },
  {
    // `lib/error-handler.ts` (`bot.catch`).
    id: 'error',
    titleKey: 'botFlow.systemScreens.error.title',
    triggerKey: 'botFlow.systemScreens.error.trigger',
    buttons: [contactButton('error-contact')],
    texts: [{ key: 'error.unknown' }],
  },
  {
    // `pages/ai-support.ts`, `/support`.
    id: 'aiSupport',
    titleKey: 'botFlow.systemScreens.aiSupport.title',
    triggerKey: 'botFlow.systemScreens.aiSupport.trigger',
    buttons: [
      {
        key: 'ai-support-exit',
        labelKey: 'botFlow.systemScreens.buttons.aiExit',
        isBack: false,
        textKey: 'ai_support.exit_button',
        conditionKey: 'botFlow.systemButtons.conditions.aiExit',
      },
    ],
    texts: [
      { key: 'ai_support.intro', captionKey: `${CAPTION}.aiIntro` },
      { key: 'ai_support.unavailable', captionKey: `${CAPTION}.aiUnavailable` },
      { key: 'ai_support.exited', captionKey: `${CAPTION}.aiExited` },
      { key: 'ai_support.rate_limited', captionKey: `${CAPTION}.aiRateLimited` },
      { key: 'ai_support.failed', captionKey: `${CAPTION}.aiFailed` },
    ],
  },
  {
    // `main.ts` → `setMyCommands`: the list Telegram shows for «/», one
    // description per command of `BOT_COMMANDS` (`core/enums/command.enum.ts`).
    id: 'commands',
    titleKey: 'botFlow.systemScreens.commands.title',
    triggerKey: 'botFlow.systemScreens.commands.trigger',
    buttons: [],
    texts: ['start', 'help', 'lang', 'rules', 'paysupport'].map((command) => ({
      key: `commands.${command}.description`,
      captionKey: `${CAPTION}.commandDescription`,
    })),
  },
  {
    // `dynamic-screen.ts`: a `screen:<shortId>` button onto a screen the
    // published flow no longer has — the message and a way back.
    id: 'screenNotFound',
    titleKey: 'botFlow.systemScreens.screenNotFound.title',
    triggerKey: 'botFlow.systemScreens.screenNotFound.trigger',
    buttons: [
      {
        key: 'screen-not-found-back',
        labelKey: 'botFlow.systemButtons.back',
        isBack: true,
        iconKey: 'back',
        textKey: 'back_to_menu',
      },
    ],
    texts: [{ key: 'screen.not_found' }],
  },
  {
    // One-line answers with no buttons: the access mode on `/start`
    // (`accessModeRefusal`, `start.ts`), the Telegram link code (`start.ts`)
    // and Telegram Stars (`payments.ts`).
    id: 'serviceReplies',
    titleKey: 'botFlow.systemScreens.serviceReplies.title',
    triggerKey: 'botFlow.systemScreens.serviceReplies.trigger',
    buttons: [],
    texts: [
      { key: 'access_mode.restricted', captionKey: `${CAPTION}.accessRestricted` },
      { key: 'access_mode.reg_blocked_new', captionKey: `${CAPTION}.accessRegBlocked` },
      { key: 'access_mode.invited_no_code', captionKey: `${CAPTION}.accessInvitedNoCode` },
      { key: 'link.success', captionKey: `${CAPTION}.telegramLink` },
      { key: 'link.invalid', captionKey: `${CAPTION}.telegramLink` },
      { key: 'link.already_linked', captionKey: `${CAPTION}.telegramLink` },
      { key: 'link.user_not_found', captionKey: `${CAPTION}.telegramLink` },
      { key: 'link.error', captionKey: `${CAPTION}.telegramLink` },
      { key: 'payments.stars.received', captionKey: `${CAPTION}.starsReceived` },
      { key: 'payments.stars.received_delayed', captionKey: `${CAPTION}.starsReceived` },
      { key: 'payments.stars.unknown_invoice', captionKey: `${CAPTION}.starsRefused` },
      { key: 'payments.stars.already_handled', captionKey: `${CAPTION}.starsRefused` },
      { key: 'payments.stars.unavailable', captionKey: `${CAPTION}.starsRefused` },
    ],
  },
]

/** The canvas node id of a built-in screen with no block. */
export function systemScreenNodeId(id: string): string {
  return `system:${id}`
}

/** The built-in screen a canvas node id names, or `null`. */
export function systemScreenForNode(nodeId: string | null): SystemScreen | null {
  if (nodeId === null) return null
  return SYSTEM_SCREENS.find((screen) => systemScreenNodeId(screen.id) === nodeId) ?? null
}

/** The built-in screen with this `SystemScreen.id`, or `null`. */
export function systemScreenById(id: string): SystemScreen | null {
  return SYSTEM_SCREENS.find((screen) => screen.id === id) ?? null
}
