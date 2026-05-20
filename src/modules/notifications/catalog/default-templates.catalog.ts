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
 * Locale note: bodies are authored in Russian as the rezeis-admin user
 * base is RU-first. Operators editing each template through the admin
 * panel can replace the text with any locale they need; a future
 * enhancement is a per-locale catalog (`seedDefaults({ locale })`)
 * that ships matching translations.
 */
export interface DefaultNotificationTemplate {
  readonly type: string;
  readonly title: string;
  readonly body: string;
}

const DURATION_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'expires_in_3_days',
    title: '⏳ Подписка истекает через 3 дня',
    body:
      '<b>Привет, {{name}}!</b>\n\n' +
      'Срок действия вашей подписки <b>{{plan}}</b> истекает <b>{{expiresAt}}</b>.\n' +
      'Продлите её, чтобы не потерять доступ.',
  },
  {
    type: 'expires_in_2_days',
    title: '⏳ Подписка истекает через 2 дня',
    body:
      '<b>Привет, {{name}}!</b>\n\nОсталось всего 2 дня до окончания подписки <b>{{plan}}</b>.',
  },
  {
    type: 'expires_in_1_days',
    title: '⏳ Подписка истекает завтра',
    body:
      '<b>Привет, {{name}}!</b>\n\nЗавтра ваша подписка <b>{{plan}}</b> закончится. Продлите её одним кликом.',
  },
  {
    type: 'expired',
    title: '⛔ Подписка завершена',
    body: 'Подписка <b>{{plan}}</b> закончилась. Продлите доступ в один клик.',
  },
  {
    type: 'limited',
    title: '⚠️ Подписка ограничена',
    body: 'Превышен лимит трафика по подписке <b>{{plan}}</b>. Доступ временно ограничен.',
  },
  {
    type: 'expired_1_day_ago',
    title: '⏰ Подписка истекла вчера',
    body: 'Подписка <b>{{plan}}</b> закончилась вчера. Продлите её, чтобы вернуть доступ.',
  },
];

const REFERRAL_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'referral_attached',
    title: '🤝 Вас пригласил {{referrerName}}',
    body: 'Теперь вы участвуете в реферальной программе. Бонусы будут начисляться автоматически.',
  },
  {
    type: 'referral_reward',
    title: '🎁 Реферальный бонус',
    body: 'Вам начислено <b>{{amount}}</b> {{currency}} за активного реферала.',
  },
  {
    type: 'referral_qualified',
    title: '✅ Реферал подтверждён',
    body: 'Ваш реферал {{referralName}} оплатил подписку — бонусы начислены.',
  },
];

const PARTNER_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'partner_referral_registered',
    title: '🆕 Новый реферал партнёра',
    body: 'Зарегистрирован новый пользователь по вашей партнёрской ссылке.',
  },
  {
    type: 'partner_earning',
    title: '💰 Поступление на партнёрский баланс',
    body: 'На баланс зачислено <b>{{amount}}</b> {{currency}}. Уровень: {{level}}.',
  },
  {
    type: 'partner_withdrawal_request_created',
    title: '🧾 Заявка на вывод создана',
    body: 'Заявка на сумму <b>{{amount}}</b> {{currency}} принята в обработку.',
  },
  {
    type: 'partner_withdrawal_under_review',
    title: '🔍 Вывод на проверке',
    body: 'Заявка <b>{{requestId}}</b> взята в обработку оператором.',
  },
  {
    type: 'partner_withdrawal_completed',
    title: '✅ Выплата выполнена',
    body: 'Вывод <b>{{amount}}</b> {{currency}} зачислен. Спасибо за партнёрство.',
  },
  {
    type: 'partner_withdrawal_rejected',
    title: '❌ Выплата отклонена',
    body: 'Заявка отклонена. Причина: {{reason}}.',
  },
];

const SYSTEM_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  {
    type: 'bot_lifetime',
    title: '🤖 Бот стартовал',
    body: 'Запуск/остановка/перезапуск бота: <b>{{event}}</b> в {{at}}.',
  },
  {
    type: 'bot_update',
    title: '🆙 Обновление бота',
    body: 'Версия {{version}} опубликована.',
  },
  {
    type: 'user_registered',
    title: '👤 Новый пользователь',
    body: 'Зарегистрирован пользователь {{name}} (Telegram ID: {{telegramId}}).',
  },
  {
    type: 'web_user_registered',
    title: '🌐 Новый пользователь (web)',
    body: 'Регистрация через веб-портал: {{email}}.',
  },
  {
    type: 'web_account_linked',
    title: '🔗 Web-аккаунт привязан',
    body: 'Пользователь {{name}} связал бот с web-аккаунтом ({{email}}).',
  },
  {
    type: 'access_policy',
    title: '🛡 Политика доступа',
    body: 'Изменён режим доступа: {{mode}}. Применил: {{adminLogin}}.',
  },
  {
    type: 'subscription',
    title: '📦 Подписка',
    body: 'Событие подписки: {{event}} ({{plan}}, пользователь {{userId}}).',
  },
  {
    type: 'promocode_activated',
    title: '🏷 Промокод активирован',
    body: 'Промокод <b>{{code}}</b> активирован пользователем {{userId}}.',
  },
  {
    type: 'trial_getted',
    title: '🎁 Триал выдан',
    body: 'Пользователь {{userId}} получил пробный период.',
  },
  {
    type: 'node_status',
    title: '🛰 Состояние узла',
    body: 'Узел <b>{{node}}</b>: {{status}}.',
  },
  {
    type: 'user_first_connected',
    title: '🔌 Первое подключение',
    body: 'Пользователь {{name}} впервые подключился к ноде {{node}}.',
  },
  {
    type: 'user_hwid',
    title: '🧷 Привязка устройства',
    body: 'Пользователь {{name}} зарегистрировал устройство {{hwid}}.',
  },
  {
    type: 'user_hwid_revoked',
    title: '🗑️ Удаление устройства',
    body: 'Пользователь {{name}} удалил устройство {{hwid}}. Осталось устройств: {{remaining}}.',
  },
];

export const DEFAULT_NOTIFICATION_TEMPLATES: ReadonlyArray<DefaultNotificationTemplate> = [
  ...DURATION_TEMPLATES,
  ...REFERRAL_TEMPLATES,
  ...PARTNER_TEMPLATES,
  ...SYSTEM_TEMPLATES,
];
