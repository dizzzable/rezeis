/**
 * Mini App "terminal" pages — fixed cabinet routes that buttons across the
 * bot surface deep-link into. Surfaced as read-only nodes on the new
 * "Карта бота" so the operator sees where each path actually ends. Adding
 * a new terminal: extend the array here and (when needed) the resolver
 * in `notification-target-resolver.ts`.
 */
export interface MiniAppTerminal {
  /** Cabinet route — must match the actual SPA route. */
  readonly route: '/dashboard' | '/renew' | '/referrals' | '/promo' | '/subscribe' | '/partner';
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
    route: '/renew',
    nameRu: 'Продление подписки',
    nameEn: 'Subscription renewal',
    descriptionRu: 'Страница продления — целевой экран expiry-уведомлений.',
    descriptionEn: 'Renewal page — destination of expiry notifications.',
  },
  {
    route: '/referrals',
    nameRu: 'Реферальная программа',
    nameEn: 'Referral program',
    descriptionRu: 'Кабинет рефералов — целевой экран реферальных бонусов.',
    descriptionEn: 'Referrals cabinet — destination of referral rewards.',
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
    route: '/subscribe',
    nameRu: 'Покупка подписки',
    nameEn: 'Subscription checkout',
    descriptionRu: 'Покупка / выбор тарифа.',
    descriptionEn: 'Purchase / plan selection.',
  },
];

/** Stable id used as the canvas node id for a Mini App terminal. */
export function miniAppTerminalNodeId(route: string): string {
  return `mini-app:${route}`;
}
