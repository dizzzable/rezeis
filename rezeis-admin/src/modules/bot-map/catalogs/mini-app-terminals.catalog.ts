/**
 * Mini App "terminal" pages — fixed cabinet routes that buttons across the
 * bot surface deep-link into. Surfaced as read-only nodes on "Карта бота" so
 * the operator sees where each path actually ends, and offered as the list a
 * notification's «Mini App» button picks its screen from.
 *
 * EVERY ROUTE HERE MUST BE A ROUTE OF THE CABINET — reiwa's `web/src/App.tsx`,
 * inside the protected shell. The map draws a button to a route on this list
 * green, so a route the cabinet does not have is a broken button drawn as a
 * working one: `/subscribe` («Покупка подписки») was exactly that until
 * 23.09.2026 — the cabinet has no such page, a Mini App opened on it fell
 * through to the catch-all and landed on the home screen. The same list is
 * pinned on both sides: `test/bot-map-composer.service.spec.ts` here and
 * `web/test/mini-app-screen-routes.test.tsx` in reiwa, which checks each one
 * against the cabinet's routes. Change one, change the other.
 *
 * Only pages that open on their own: `/purchase` is the step after `/plans`
 * and expects the plan chosen there. A path with a query (`/promo?code=…`,
 * `/support?ticket=…`, `/subscription/connect?subscriptionId=…`) is still
 * this route; the map reads a button by its path.
 */
export type MiniAppRoute =
  | '/dashboard'
  | '/open-in-browser'
  | '/subscription'
  | '/subscription/devices'
  | '/subscription/connect'
  | '/plans'
  | '/renew'
  | '/upgrade'
  | '/addons'
  | '/referrals'
  | '/referrals/exchange'
  | '/partner'
  | '/promo'
  | '/wheel'
  | '/events'
  | '/activity'
  | '/settings'
  | '/settings/transactions'
  | '/settings/faq'
  | '/support';

export interface MiniAppTerminal {
  /** Cabinet route — must match the actual SPA route. */
  readonly route: MiniAppRoute;
  /** Display name shown on the canvas / list rail (RU). */
  readonly nameRu: string;
  /** Display name shown on the canvas / list rail (EN). */
  readonly nameEn: string;
  /** Short purpose blurb for the inspector preview. */
  readonly descriptionRu: string;
  readonly descriptionEn: string;
}

export const MINI_APP_TERMINALS: ReadonlyArray<MiniAppTerminal> = [
  {
    route: '/dashboard',
    nameRu: 'Дашборд кабинета',
    nameEn: 'Cabinet dashboard',
    descriptionRu: 'Главный экран кабинета: подписки, устройства, статус.',
    descriptionEn: 'Cabinet home: subscriptions, devices, status.',
  },
  {
    route: '/open-in-browser',
    nameRu: 'Кабинет в браузере',
    nameEn: 'Cabinet in the browser',
    descriptionRu:
      'Открывает кабинет в браузере телефона, уже с выполненным входом. Сюда ведёт «Кабинет» в меню бота, если у кнопки не задан свой адрес.',
    descriptionEn:
      "Opens the cabinet in the phone's own browser, already signed in. «Кабинет» in the bot's menu leads here unless the button has an address of its own.",
  },
  {
    route: '/subscription',
    nameRu: 'Подписка',
    nameEn: 'Subscription',
    descriptionRu: 'Подписка подробно: срок, трафик, ссылка подключения.',
    descriptionEn: 'The subscription in detail: term, traffic, connection link.',
  },
  {
    route: '/subscription/devices',
    nameRu: 'Устройства',
    nameEn: 'Devices',
    descriptionRu: 'Подключённые устройства и их лимит.',
    descriptionEn: 'Connected devices and their limit.',
  },
  {
    route: '/subscription/connect',
    nameRu: 'Подключение устройства',
    nameEn: 'Connecting a device',
    descriptionRu:
      'Инструкция и ссылка подключения. Без `?subscriptionId=` берёт первую подписку со ссылкой.',
    descriptionEn:
      'Connection guide and link. Without `?subscriptionId=` it takes the first subscription with a link.',
  },
  {
    route: '/plans',
    nameRu: 'Тарифы',
    nameEn: 'Plans',
    descriptionRu: 'Выбор тарифа и покупка подписки.',
    descriptionEn: 'Plan selection and subscription purchase.',
  },
  {
    route: '/renew',
    nameRu: 'Продление подписки',
    nameEn: 'Subscription renewal',
    descriptionRu: 'Страница продления — целевой экран expiry-уведомлений.',
    descriptionEn: 'Renewal page — destination of expiry notifications.',
  },
  {
    route: '/upgrade',
    nameRu: 'Улучшение тарифа',
    nameEn: 'Plan upgrade',
    descriptionRu: 'Переход на тариф выше.',
    descriptionEn: 'Moving to a higher plan.',
  },
  {
    route: '/addons',
    nameRu: 'Дополнения',
    nameEn: 'Add-ons',
    descriptionRu: 'Покупка дополнений к подписке.',
    descriptionEn: 'Buying add-ons for the subscription.',
  },
  {
    route: '/referrals',
    nameRu: 'Реферальная программа',
    nameEn: 'Referral program',
    descriptionRu: 'Кабинет рефералов — целевой экран реферальных бонусов.',
    descriptionEn: 'Referrals cabinet — destination of referral rewards.',
  },
  {
    route: '/referrals/exchange',
    nameRu: 'Обмен баллов',
    nameEn: 'Points exchange',
    descriptionRu: 'Обмен реферальных баллов.',
    descriptionEn: 'Exchanging referral points.',
  },
  {
    route: '/partner',
    nameRu: 'Партнёрский кабинет',
    nameEn: 'Partner dashboard',
    descriptionRu: 'Партнёрская программа — выплаты, статусы, выводы.',
    descriptionEn: 'Partner program — payouts, statuses, withdrawals.',
  },
  {
    route: '/promo',
    nameRu: 'Активация промокода',
    nameEn: 'Promo code activation',
    descriptionRu: 'Страница активации промокода. Принимает `?code=` и подставляет код в форму.',
    descriptionEn: 'Promo code activation page. Reads `?code=` and pre-fills the form.',
  },
  {
    route: '/wheel',
    nameRu: 'Рулетка',
    nameEn: 'Prize wheel',
    descriptionRu: 'Рулетка с призами.',
    descriptionEn: 'The prize wheel.',
  },
  {
    route: '/events',
    nameRu: 'События',
    nameEn: 'Events',
    descriptionRu: 'Что идёт сейчас: рулетка и конкурсы, свой итог розыгрыша.',
    descriptionEn: "What is running now: the wheel and contests, the person's own draw result.",
  },
  {
    route: '/activity',
    nameRu: 'Активность',
    nameEn: 'Activity',
    descriptionRu: 'Платежи и уведомления подписчика, двумя вкладками.',
    descriptionEn: "The subscriber's payments and notifications, in two tabs.",
  },
  {
    route: '/settings',
    nameRu: 'Настройки',
    nameEn: 'Settings',
    descriptionRu: 'Настройки кабинета.',
    descriptionEn: 'Cabinet settings.',
  },
  {
    route: '/settings/transactions',
    nameRu: 'История платежей',
    nameEn: 'Payment history',
    descriptionRu: 'Платежи и списания подписчика.',
    descriptionEn: "The subscriber's payments and charges.",
  },
  {
    route: '/settings/faq',
    nameRu: 'Помощь (FAQ)',
    nameEn: 'Help (FAQ)',
    descriptionRu: 'Частые вопросы.',
    descriptionEn: 'Frequently asked questions.',
  },
  {
    route: '/support',
    nameRu: 'Поддержка (тикеты)',
    nameEn: 'Support (tickets)',
    descriptionRu: 'Раздел тикетов в кабинете — целевой экран уведомления «Поддержка ответила». Принимает `?ticket=` и открывает нужное обращение.',
    descriptionEn: 'Cabinet tickets section — destination of the "Support replied" notification. Reads `?ticket=` and opens that conversation.',
  },
];

/** Stable id used as the canvas node id for a Mini App terminal. */
export function miniAppTerminalNodeId(route: string): string {
  return `mini-app:${route}`;
}
