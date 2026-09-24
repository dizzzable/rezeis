/**
 * Default notification templates for the "seed" action exposed to the
 * admin panel.
 *
 * Keys mirror the slugs declared by the React notifications page (in
 * `web/src/features/notifications/notifications-page.tsx`). When a new
 * notification kind is added, list it here so the operator can re-seed
 * the row instead of writing the title/body from scratch in the UI.
 *
 * Body templates use minimal Handlebars-style placeholders (`{{name}}`)
 * which are resolved by the consuming emitter. The seeding logic does
 * NOT overwrite existing rows.
 *
 * Locale model: each template ships with RU + optional EN copy. When the
 * EN copy is empty at delivery time, the bot falls back to the RU
 * column — so a deployment that hasn't authored EN translations keeps
 * working unchanged.
 *
 * Buttons: each template carries an ordered array of action buttons
 * (`webApp` / `url` / `callback`) attached to the rendered Telegram
 * message. The expiry-warning rows now own the "Продлить" / "Главное
 * меню" pair that used to live in `auto-renew.service.ts`; replacing
 * the hard-coded constant means operators can edit those buttons from
 * the new "Карта бота" module.
 */
export interface DefaultNotificationTemplateButton {
  readonly labelRu: string;
  readonly labelEn?: string;
  readonly kind: 'webApp' | 'url' | 'callback';
  /** Mini App route for `webApp`; absolute URL for `url`; callback id for `callback`. */
  readonly target: string;
}

export interface DefaultNotificationTemplate {
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly titleEn?: string;
  readonly bodyEn?: string;
  readonly buttons?: ReadonlyArray<DefaultNotificationTemplateButton>;
}

/** Canonical "Продлить + Главное меню" button pair for expiry-related rows. */
const EXPIRY_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '🔄 Продлить подписку', labelEn: '🔄 Renew subscription', kind: 'webApp', target: '/renew' },
  { labelRu: '🏠 Главное меню', labelEn: '🏠 Main menu', kind: 'callback', target: 'menu:main' },
];

/** Referral-program rows deep-link the user into the cabinet referrals page. */
const REFERRAL_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '👥 Реферальная программа', labelEn: '👥 Referrals', kind: 'webApp', target: '/referrals' },
  { labelRu: '🏠 Главное меню', labelEn: '🏠 Main menu', kind: 'callback', target: 'menu:main' },
];

/**
 * Points rows land on the exchange, not the referrals page: a subscriber told
 * they just earned points wants to see what those points buy.
 */
const POINTS_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '🪙 Обменять баллы', labelEn: '🪙 Exchange points', kind: 'webApp', target: '/referrals/exchange' },
  { labelRu: '🏠 Главное меню', labelEn: '🏠 Main menu', kind: 'callback', target: 'menu:main' },
];

/** Partner-program rows deep-link to the partner cabinet. */
const PARTNER_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '🤝 Партнёрский кабинет', labelEn: '🤝 Partner dashboard', kind: 'webApp', target: '/partner' },
  { labelRu: '🏠 Главное меню', labelEn: '🏠 Main menu', kind: 'callback', target: 'menu:main' },
];

/**
 * The subscription card every expiry-family message carries.
 *
 * ── Why one shared body instead of six ───────────────────────────────────
 *
 * The six messages differ only in their first line — how long is left, or
 * that nothing is. Everything under it is the same statement of what the
 * customer has, and writing it out six times guarantees the six copies drift:
 * the operator edits one, and the other five keep the old wording.
 *
 * ── The placeholders, and where they come from ───────────────────────────
 *
 * `{{profile}}`  the VPN profile name, read from the panel.
 * `{{plan}}`     the plan snapshot on the subscription.
 * `{{devices}}`  how many devices are free, or the allowance when the bound
 *                count is unknown, or "Безлимит".
 * `{{traffic}}`  a whole line with a traffic light — unlimited, or used /
 *                limit with the remainder. `{{trafficUsed}}`,
 *                `{{trafficLimit}}` and `{{trafficLeft}}` are available
 *                separately for an operator who wants a different shape.
 * `{{expiresDate}}` / `{{expiresTime}}` the deadline, in the time zone the
 *                operator set in platform settings.
 *
 * Every one of them collapses to nothing when the fact is unknown — an
 * unreachable VPN panel costs a line, never the message.
 */
const SUBSCRIPTION_CARD_RU =
  '\n\n' +
  '👤 {{profile}}\n' +
  '📦 Тариф: {{plan}}\n' +
  '📱 Устройств: {{devices}}\n' +
  '📊 Трафик — {{traffic}}\n\n' +
  '📆 Окончание действия подписки: {{expiresDate}}\n' +
  '⏳ Время: {{expiresTime}}';

const SUBSCRIPTION_CARD_EN =
  '\n\n' +
  '👤 {{profile}}\n' +
  '📦 Plan: {{plan}}\n' +
  '📱 Devices: {{devices}}\n' +
  '📊 Traffic — {{traffic}}\n\n' +
  '📆 Subscription ends: {{expiresDate}}\n' +
  '⏳ Time: {{expiresTime}}';

const DURATION_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'expires_in_3_days',
    title: '⚠️ Подписка истекает через 3 дня',
    titleEn: '⚠️ Subscription expires in 3 days',
    body: 'Привет, {{name}}! Твоя подписка истекает через 3 дня ⚠️' + SUBSCRIPTION_CARD_RU,
    bodyEn: 'Hi, {{name}}! Your subscription expires in 3 days ⚠️' + SUBSCRIPTION_CARD_EN,
    buttons: EXPIRY_BUTTONS,
  },
  {
    type: 'expires_in_2_days',
    title: '⚠️ Подписка истекает через 2 дня',
    titleEn: '⚠️ Subscription expires in 2 days',
    body: 'Привет, {{name}}! Твоя подписка истекает через 2 дня ⚠️' + SUBSCRIPTION_CARD_RU,
    bodyEn: 'Hi, {{name}}! Your subscription expires in 2 days ⚠️' + SUBSCRIPTION_CARD_EN,
    buttons: EXPIRY_BUTTONS,
  },
  {
    type: 'expires_in_1_days',
    title: '⚠️ Подписка истекает завтра',
    titleEn: '⚠️ Subscription expires tomorrow',
    body: 'Привет, {{name}}! Твоя подписка истекает завтра ⚠️' + SUBSCRIPTION_CARD_RU,
    bodyEn: 'Hi, {{name}}! Your subscription expires tomorrow ⚠️' + SUBSCRIPTION_CARD_EN,
    buttons: EXPIRY_BUTTONS,
  },
  {
    type: 'expired',
    title: '⛔ Подписка закончилась',
    titleEn: '⛔ Subscription has ended',
    body: 'Привет, {{name}}! Твоя подписка закончилась ⛔' + SUBSCRIPTION_CARD_RU,
    bodyEn: 'Hi, {{name}}! Your subscription has ended ⛔' + SUBSCRIPTION_CARD_EN,
    buttons: EXPIRY_BUTTONS,
  },
  {
    type: 'expired_1_day_ago',
    title: '⏰ Подписка закончилась вчера',
    titleEn: '⏰ Subscription ended yesterday',
    body:
      'Привет, {{name}}! Твоя подписка закончилась вчера — доступ уже отключён ⏰' +
      SUBSCRIPTION_CARD_RU,
    bodyEn:
      'Hi, {{name}}! Your subscription ended yesterday — access is already off ⏰' +
      SUBSCRIPTION_CARD_EN,
    buttons: EXPIRY_BUTTONS,
  },
  {
    type: 'limited',
    title: '⚠️ Подписка ограничена',
    titleEn: '⚠️ Subscription limited',
    body:
      'Привет, {{name}}! Лимит трафика исчерпан, доступ временно ограничен ⚠️' +
      SUBSCRIPTION_CARD_RU,
    bodyEn:
      'Hi, {{name}}! Your traffic limit is used up and access is temporarily restricted ⚠️' +
      SUBSCRIPTION_CARD_EN,
    buttons: EXPIRY_BUTTONS,
  },
];

const REFERRAL_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'referral_attached',
    title: '🤝 Вас пригласил {{referrerName}}',
    titleEn: '🤝 You were invited by {{referrerName}}',
    body: 'Теперь вы участвуете в реферальной программе. Бонусы будут начисляться автоматически.',
    bodyEn: 'You\'re now part of the referral program. Rewards will be credited automatically.',
    buttons: REFERRAL_BUTTONS,
  },
  {
    type: 'referral_reward',
    title: '🎁 Реферальный бонус',
    titleEn: '🎁 Referral reward',
    body: 'Вам начислено <b>{{amount}}</b> {{currency}} за активного реферала.',
    bodyEn: 'You earned <b>{{amount}}</b> {{currency}} for an active referral.',
    buttons: REFERRAL_BUTTONS,
  },
  {
    type: 'referral_qualified',
    title: '✅ Реферал подтверждён',
    titleEn: '✅ Referral qualified',
    body: 'Ваш реферал {{referralName}} оплатил подписку — бонусы начислены.',
    bodyEn: 'Your referral {{referralName}} paid for a subscription — rewards credited.',
    buttons: REFERRAL_BUTTONS,
  },
];

const POINTS_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'points_cashback_credited',
    title: '🪙 Начислен кэшбэк',
    titleEn: '🪙 Cashback credited',
    body: 'За покупку начислено <b>{{points}}</b> баллов. Ваш баланс: <b>{{balance}}</b>.',
    bodyEn: 'Your purchase earned <b>{{points}}</b> points. Your balance: <b>{{balance}}</b>.',
    buttons: POINTS_BUTTONS,
  },
];

/**
 * The three advertising decisions a partner used to hear nothing about.
 *
 * `AdPlacementRequestService` has emitted these since the module shipped, and
 * `fanout` gates EVERY channel on a rendered template — Telegram, web-push and
 * the operator mirror alike. With no catalogue row, `rendered` was `null` and
 * all three produced nothing at all: the partner's request was countered,
 * rejected or activated in a screen they had no reason to reopen, and the
 * only trace was a feed row with no text.
 *
 * The gap was undiscoverable from the panel too: the Seed button inserts the
 * catalogue, and nothing lists types that HAVE no catalogue entry.
 */
const ADVERTISING_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'advertising.request_countered',
    title: '📝 Встречное предложение по размещению',
    titleEn: '📝 Counter-offer on your placement',
    body:
      'По вашей заявке на размещение предложены другие условия: ' +
      '<b>{{approvedWindowDays}}</b> дн. вместо запрошенных {{proposedWindowDays}}. ' +
      'Откройте партнёрский кабинет, чтобы принять или отказаться.',
    bodyEn:
      'Your placement request came back with different terms: ' +
      '<b>{{approvedWindowDays}}</b> days instead of the {{proposedWindowDays}} you asked for. ' +
      'Open the partner dashboard to accept or decline.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'advertising.request_rejected',
    title: '🚫 Заявка на размещение отклонена',
    titleEn: '🚫 Placement request declined',
    body: 'Ваша заявка на размещение отклонена. Причина: {{reviewNotes}}',
    bodyEn: 'Your placement request was declined. Reason: {{reviewNotes}}',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'advertising.request_activated',
    title: '🚀 Размещение запущено',
    titleEn: '🚀 Placement is live',
    body:
      'Ваше размещение активировано на <b>{{approvedWindowDays}}</b> дн. ' +
      'Площадок в кампании: {{placements}}. Статистика — в партнёрском кабинете.',
    bodyEn:
      'Your placement is live for <b>{{approvedWindowDays}}</b> days. ' +
      'Placements in the campaign: {{placements}}. Statistics are in the partner dashboard.',
    buttons: PARTNER_BUTTONS,
  },
];

const PARTNER_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'partner_referral_registered',
    title: '🆕 Новый реферал партнёра',
    titleEn: '🆕 New partner referral',
    body: 'Зарегистрирован новый пользователь по вашей партнёрской ссылке.',
    bodyEn: 'A new user signed up via your partner link.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'partner_earning',
    title: '💰 Поступление на партнёрский баланс',
    titleEn: '💰 Partner balance credit',
    body: 'На баланс зачислено <b>{{amount}}</b> {{currency}}. Уровень: {{level}}.',
    bodyEn: 'Your balance was credited with <b>{{amount}}</b> {{currency}}. Level: {{level}}.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'partner_withdrawal_request_created',
    title: '🧾 Заявка на вывод создана',
    titleEn: '🧾 Withdrawal request created',
    body: 'Заявка на сумму <b>{{amount}}</b> {{currency}} принята в обработку.',
    bodyEn: 'A withdrawal request for <b>{{amount}}</b> {{currency}} is being processed.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'partner_withdrawal_under_review',
    title: '🔍 Вывод на проверке',
    titleEn: '🔍 Withdrawal under review',
    body: 'Заявка <b>{{requestId}}</b> взята в обработку оператором.',
    bodyEn: 'Request <b>{{requestId}}</b> is being reviewed by an operator.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'partner_withdrawal_completed',
    title: '✅ Выплата выполнена',
    titleEn: '✅ Payout completed',
    body: 'Вывод <b>{{amount}}</b> {{currency}} зачислен. Спасибо за партнёрство.',
    bodyEn: 'Withdrawal of <b>{{amount}}</b> {{currency}} has been paid out. Thanks for partnering.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'partner_withdrawal_rejected',
    title: '❌ Выплата отклонена',
    titleEn: '❌ Payout rejected',
    body: 'Заявка отклонена. Причина: {{reason}}.',
    bodyEn: 'The request was rejected. Reason: {{reason}}.',
    buttons: PARTNER_BUTTONS,
  },
  // Dot-notation aliases that match SystemEvents type strings
  // (partner.earning, partner.withdrawal_approved, ...). Pre-seeded
  // disabled so the Email bridge skips them by default; operators
  // toggle each on per channel via the admin UI.
  {
    type: 'partner.earning',
    title: '💰 Поступление на партнёрский баланс',
    titleEn: '💰 Partner balance credit',
    body: 'На баланс зачислено <b>{{amountMinor}}</b>. Уровень: L{{level}}.',
    bodyEn: 'Balance credited with <b>{{amountMinor}}</b>. Level: L{{level}}.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'partner.withdrawal_approved',
    title: '✅ Выплата выполнена',
    titleEn: '✅ Payout completed',
    body: 'Заявка <b>{{withdrawalId}}</b> на сумму {{amountMinor}} зачислена.',
    bodyEn: 'Withdrawal <b>{{withdrawalId}}</b> for {{amountMinor}} has been paid out.',
    buttons: PARTNER_BUTTONS,
  },
  {
    type: 'partner.withdrawal_rejected',
    title: '❌ Выплата отклонена',
    titleEn: '❌ Payout rejected',
    body:
      'Заявка <b>{{withdrawalId}}</b> на сумму {{amountMinor}} отклонена.\n' +
      'Причина: {{reason}}.',
    bodyEn:
      'Withdrawal <b>{{withdrawalId}}</b> for {{amountMinor}} was rejected.\n' +
      'Reason: {{reason}}.',
    buttons: PARTNER_BUTTONS,
  },
];

const SYSTEM_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'bot_lifetime',
    title: '🤖 Бот стартовал',
    titleEn: '🤖 Bot lifecycle event',
    body: 'Запуск/остановка/перезапуск бота: <b>{{event}}</b> в {{at}}.',
    bodyEn: 'Bot start/stop/restart: <b>{{event}}</b> at {{at}}.',
  },
  {
    type: 'bot_update',
    title: '🆙 Обновление бота',
    titleEn: '🆙 Bot update',
    body: 'Версия {{version}} опубликована.',
    bodyEn: 'Version {{version}} published.',
  },
  {
    type: 'user_registered',
    title: '👤 Новый пользователь',
    titleEn: '👤 New user',
    body: 'Зарегистрирован пользователь {{name}} (Telegram ID: {{telegramId}}).',
    bodyEn: 'User {{name}} registered (Telegram ID: {{telegramId}}).',
  },
  {
    type: 'web_user_registered',
    title: '🌐 Новый пользователь (web)',
    titleEn: '🌐 New user (web)',
    body: 'Регистрация через веб-портал: {{email}}.',
    bodyEn: 'Web-portal sign-up: {{email}}.',
  },
  {
    type: 'web_welcome',
    title: '👋 Добро пожаловать',
    titleEn: '👋 Welcome',
    body: 'Ваш аккаунт готов. Ваш логин для входа: {{login}}. Пароль вы задали при регистрации — по соображениям безопасности мы его не отправляем.',
    bodyEn: 'Your account is ready. Your login is {{login}}. You set your password during sign-up — for security we never email it.',
  },
  {
    type: 'web_account_linked',
    title: '🔗 Web-аккаунт привязан',
    titleEn: '🔗 Web account linked',
    body: 'Пользователь {{name}} связал бот с web-аккаунтом ({{email}}).',
    bodyEn: 'User {{name}} linked the bot to a web account ({{email}}).',
  },
  {
    type: 'access_policy',
    title: '🛡 Политика доступа',
    titleEn: '🛡 Access policy',
    body: 'Изменён режим доступа: {{mode}}. Применил: {{adminLogin}}.',
    bodyEn: 'Access mode changed to {{mode}} by {{adminLogin}}.',
  },
  {
    type: 'subscription',
    title: '📦 Подписка',
    titleEn: '📦 Subscription',
    body: 'Событие подписки: {{event}} ({{plan}}, пользователь {{userId}}).',
    bodyEn: 'Subscription event: {{event}} ({{plan}}, user {{userId}}).',
  },
  {
    type: 'promocode_activated',
    title: '🏷 Промокод активирован',
    titleEn: '🏷 Promo code activated',
    body: 'Промокод <b>{{code}}</b> активирован пользователем {{userId}}.',
    bodyEn: 'Promo code <b>{{code}}</b> was activated by user {{userId}}.',
  },
  {
    type: 'trial_getted',
    title: '🎁 Триал выдан',
    titleEn: '🎁 Trial granted',
    body: 'Пользователь {{userId}} получил пробный период.',
    bodyEn: 'User {{userId}} got a trial period.',
  },
  {
    type: 'node_status',
    title: '🛰 Состояние узла',
    titleEn: '🛰 Node status',
    body: 'Узел <b>{{node}}</b>: {{status}}.',
    bodyEn: 'Node <b>{{node}}</b>: {{status}}.',
  },
  {
    type: 'user_first_connected',
    title: '🔌 Первое подключение',
    titleEn: '🔌 First connection',
    body: 'Пользователь {{name}} впервые подключился к ноде {{node}}.',
    bodyEn: 'User {{name}} connected for the first time on node {{node}}.',
  },
  {
    type: 'user_hwid',
    title: '🧷 Привязка устройства',
    titleEn: '🧷 Device bound',
    body: 'Пользователь {{name}} зарегистрировал устройство {{hwid}}.',
    bodyEn: 'User {{name}} registered device {{hwid}}.',
  },
  {
    type: 'user_hwid_revoked',
    title: '🗑️ Удаление устройства',
    titleEn: '🗑️ Device revoked',
    body: 'Пользователь {{name}} удалил устройство {{hwid}}. Осталось устройств: {{remaining}}.',
    bodyEn: 'User {{name}} revoked device {{hwid}}. Remaining devices: {{remaining}}.',
  },
];

/** Support-reply rows deep-link the user into the cabinet tickets section. */
const SUPPORT_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '💬 Открыть обращение', labelEn: '💬 Open ticket', kind: 'webApp', target: '/support' },
];

const SUPPORT_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'support_reply',
    title: '💬 Поддержка ответила',
    titleEn: '💬 Support replied',
    body:
      'По вашему обращению «{{subject}}» есть новый ответ от поддержки. ' +
      'Откройте раздел «Поддержка», чтобы прочитать.',
    bodyEn:
      'There is a new reply to your ticket "{{subject}}". ' +
      'Open the Support section to read it.',
    buttons: SUPPORT_BUTTONS,
  },
  {
    // A thread the OPERATOR started. Separate from `support_reply` because
    // "there is a new reply to your ticket" is false for a ticket the client
    // never opened — and it is the first sentence they read. The delivered
    // notification event still carries type `support_reply`, which is what
    // the cabinet counts and clears; see `SupportNotificationsService`.
    type: 'support_ticket_opened',
    title: '💬 Поддержка написала вам',
    titleEn: '💬 Support started a conversation',
    body:
      'Поддержка открыла обращение «{{subject}}» и ждёт вашего ответа. ' +
      'Откройте раздел «Поддержка», чтобы прочитать и ответить.',
    bodyEn:
      'Support opened the ticket "{{subject}}" and is waiting for your reply. ' +
      'Open the Support section to read and answer.',
    buttons: SUPPORT_BUTTONS,
  },
];

/**
 * «Помощь с подключением»: the connect screen first, a person second.
 *
 * `/dashboard?connect=help` is the cabinet's one deep link for this help — the
 * dashboard opens the connection screen through the operator's own door switch
 * (internal screen or the external subscription page), so the button never
 * bypasses that choice. The bot carries the query string in the Mini App path.
 */
const CONNECT_HELP_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '📲 Подключить', labelEn: '📲 Connect', kind: 'webApp', target: '/dashboard?connect=help' },
  { labelRu: '💬 Поддержка', labelEn: '💬 Support', kind: 'webApp', target: '/support' },
];

const CONNECT_HELP_ADVICE_RU =
  '\n\nОткройте экран подключения — он подскажет приложение для вашего устройства ' +
  'и добавит подписку в одно касание. Если что-то не выйдет, напишите нам: поможем.';

const CONNECT_HELP_ADVICE_EN =
  '\n\nOpen the connection screen: it suggests an app for your device and adds your ' +
  "subscription in one tap. If something doesn't work, message us and we'll help.";

/**
 * Sent once per subscription, N hours after it was bought (or granted), when
 * its VPN profile has verifiably never connected. Two types, one switch:
 *
 *   connect_help        the customer PAID (a paid trial and a partner-balance
 *                       purchase included) — the text may say «оплачена»;
 *   connect_help_trial  a free trial, an operator's gift, a promo or a 0 ₽
 *                       checkout — nothing was paid, so the text must not say
 *                       it was.
 *
 * No `{{name}}`: a customer who signed up on the web may have none, and a
 * message that opens with a bare comma reads broken. An operator who wants the
 * name can add it — the placeholder works as in every other template.
 */
const CONNECT_HELP_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'connect_help',
    title: 'Не получилось подключиться?',
    titleEn: "Couldn't connect?",
    body:
      'Подписка «{{plan}}» оплачена, но VPN на ней ещё ни разу не подключался.' +
      CONNECT_HELP_ADVICE_RU,
    bodyEn:
      "Your “{{plan}}” subscription is paid, but the VPN hasn't connected on it yet." +
      CONNECT_HELP_ADVICE_EN,
    buttons: CONNECT_HELP_BUTTONS,
  },
  {
    type: 'connect_help_trial',
    title: 'Не получилось подключиться?',
    titleEn: "Couldn't connect?",
    body:
      'Подписка «{{plan}}» уже работает, но VPN на ней ещё ни разу не подключался.' +
      CONNECT_HELP_ADVICE_RU,
    bodyEn:
      "Your “{{plan}}” subscription is active, but the VPN hasn't connected on it yet." +
      CONNECT_HELP_ADVICE_EN,
    buttons: CONNECT_HELP_BUTTONS,
  },
];

/**
 * «Купить снова»: the cabinet's add-on purchase, for the subscription the
 * notice is about — the notice carries `subscriptionId`, and the fanout adds
 * it to a bare `/addons` (`linkButtonsToSubscription`), so the page opens on
 * that subscription's offers instead of asking which one.
 */
const ADD_ON_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '🔁 Купить снова', labelEn: '🔁 Buy again', kind: 'webApp', target: '/addons' },
  { labelRu: '🏠 Главное меню', labelEn: '🏠 Main menu', kind: 'callback', target: 'menu:main' },
];

/** A device add-on's notice: the devices page beside «Купить снова» — where the customer chooses which stay. */
const ADD_ON_DEVICE_BUTTONS: ReadonlyArray<DefaultNotificationTemplateButton> = [
  { labelRu: '🔁 Купить снова', labelEn: '🔁 Buy again', kind: 'webApp', target: '/addons' },
  { labelRu: '📱 Устройства', labelEn: '📱 Devices', kind: 'webApp', target: '/subscription/devices' },
];

const ADD_ON_RENEWAL_RU = '\n\nПродление подписки опцию не продлевает: когда она закончится, её можно купить снова.';
const ADD_ON_RENEWAL_EN =
  '\n\nRenewing the subscription does not renew the add-on: once it ends, you can buy it again.';

/**
 * A dated add-on — one bought while the durable model is on — three days
 * before it ends and when it has ended (`AddOnExpiryNoticeService`). Add-ons
 * bought before the model have no end and get neither.
 *
 * SIX TEMPLATES, because a device add-on's end means two different things: with
 * `ADDON_DEVICE_CLEANUP_AUTO` on, the extra devices are disconnected by
 * themselves, newest first; with it off, they stay and new ones over the limit
 * do not connect. Each text is written out whole, where the operator reads and
 * edits it in «Карта бота», and the sender picks the one for the add-on and
 * the flag. The customer has ONE switch per moment for all three
 * (`SUBSCRIBER_SWITCH_OF_TYPE`).
 *
 * The words are the cabinet's own: «Дополнительные опции» / «Мои опции» in
 * Russian, "Add-ons" in English.
 *
 * The placeholders: `{{addon}}` the add-on's name as it was sold,
 * `{{addonValue}}` «+2 устройства» / «+10 ГБ», `{{addonAmount}}` the same
 * without the plus, `{{endsDate}}` / `{{endsTime}}` / `{{endsDateTime}}` when
 * it ends, in the operator's time zone; `{{plan}}`, `{{profile}}` and the
 * subscription's own `{{expiresDate}}` as in the expiry notices.
 */
const ADD_ON_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'addon_ends_in_3_days',
    title: '⏳ Дополнительный трафик заканчивается через 3 дня',
    titleEn: '⏳ Extra traffic ends in 3 days',
    body:
      'Опция «{{addon}}» ({{addonValue}}) к подписке «{{plan}}» действует до {{endsDateTime}}. ' +
      'После этого лимит трафика станет меньше на {{addonAmount}}.' +
      ADD_ON_RENEWAL_RU,
    bodyEn:
      'The add-on “{{addon}}” ({{addonValue}}) to your “{{plan}}” subscription runs until {{endsDateTime}}. ' +
      'After that, your traffic limit goes down by {{addonAmount}}.' +
      ADD_ON_RENEWAL_EN,
    buttons: ADD_ON_BUTTONS,
  },
  {
    type: 'addon_ended',
    title: '⌛ Дополнительный трафик закончился',
    titleEn: '⌛ Extra traffic has ended',
    body:
      'Опция «{{addon}}» ({{addonValue}}) к подписке «{{plan}}» закончилась {{endsDateTime}}: ' +
      'лимит трафика стал меньше на {{addonAmount}}.\n\nЕё можно купить снова.',
    bodyEn:
      'The add-on “{{addon}}” ({{addonValue}}) to your “{{plan}}” subscription ended on {{endsDateTime}}: ' +
      'your traffic limit went down by {{addonAmount}}.\n\nYou can buy it again.',
    buttons: ADD_ON_BUTTONS,
  },
  {
    // `ADDON_DEVICE_CLEANUP_AUTO` off: the devices stay, new ones do not connect.
    type: 'addon_devices_ends_in_3_days',
    title: '⏳ Дополнительные устройства заканчиваются через 3 дня',
    titleEn: '⏳ Extra devices end in 3 days',
    body:
      'Опция «{{addon}}» ({{addonValue}}) к подписке «{{plan}}» действует до {{endsDateTime}}. ' +
      'После этого новые устройства сверх лимита подключить не получится.' +
      ADD_ON_RENEWAL_RU,
    bodyEn:
      'The add-on “{{addon}}” ({{addonValue}}) to your “{{plan}}” subscription runs until {{endsDateTime}}. ' +
      'After that, new devices over the limit will not connect.' +
      ADD_ON_RENEWAL_EN,
    buttons: ADD_ON_DEVICE_BUTTONS,
  },
  {
    type: 'addon_devices_ended',
    title: '⌛ Дополнительные устройства закончились',
    titleEn: '⌛ Extra devices have ended',
    body:
      'Опция «{{addon}}» ({{addonValue}}) к подписке «{{plan}}» закончилась {{endsDateTime}}. ' +
      'Новые устройства сверх лимита подключить не получится.\n\nЕё можно купить снова.',
    bodyEn:
      'The add-on “{{addon}}” ({{addonValue}}) to your “{{plan}}” subscription ended on {{endsDateTime}}. ' +
      'New devices over the limit will not connect.\n\nYou can buy it again.',
    buttons: ADD_ON_DEVICE_BUTTONS,
  },
  {
    // `ADDON_DEVICE_CLEANUP_AUTO` on: the extra devices go by themselves, newest first.
    type: 'addon_devices_auto_ends_in_3_days',
    title: '⏳ Дополнительные устройства заканчиваются через 3 дня',
    titleEn: '⏳ Extra devices end in 3 days',
    body:
      'Опция «{{addon}}» ({{addonValue}}) к подписке «{{plan}}» действует до {{endsDateTime}}. ' +
      'После этого лишние устройства отключатся сами — сначала самые новые. ' +
      'Чтобы выбрать, какие оставить, отключите лишние заранее: «Подписка» → «Управление устройствами».' +
      ADD_ON_RENEWAL_RU,
    bodyEn:
      'The add-on “{{addon}}” ({{addonValue}}) to your “{{plan}}” subscription runs until {{endsDateTime}}. ' +
      'After that, the extra devices are disconnected automatically, newest first. ' +
      'To choose which ones stay, disconnect the extra ones yourself beforehand: “Subscription” → “Manage devices”.' +
      ADD_ON_RENEWAL_EN,
    buttons: ADD_ON_DEVICE_BUTTONS,
  },
  {
    type: 'addon_devices_auto_ended',
    title: '⌛ Дополнительные устройства закончились',
    titleEn: '⌛ Extra devices have ended',
    body:
      'Опция «{{addon}}» ({{addonValue}}) к подписке «{{plan}}» закончилась {{endsDateTime}}. ' +
      'Лишние устройства отключаются сами — сначала самые новые.\n\nЕё можно купить снова.',
    bodyEn:
      'The add-on “{{addon}}” ({{addonValue}}) to your “{{plan}}” subscription ended on {{endsDateTime}}. ' +
      'The extra devices are being disconnected automatically, newest first.\n\nYou can buy it again.',
    buttons: ADD_ON_DEVICE_BUTTONS,
  },
];

export const DEFAULT_NOTIFICATION_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  ...DURATION_TEMPLATES,
  ...ADD_ON_TEMPLATES,
  ...REFERRAL_TEMPLATES,
  ...POINTS_TEMPLATES,
  ...PARTNER_TEMPLATES,
  ...ADVERTISING_TEMPLATES,
  ...SYSTEM_TEMPLATES,
  ...SUPPORT_TEMPLATES,
  ...CONNECT_HELP_TEMPLATES,
];
