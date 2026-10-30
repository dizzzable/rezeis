/**
 * The client's account as support reads it — the AI assistant before every
 * reply, the operator on the ticket.
 *
 * The owner, 30.10.2026, over a ticket that read «я оплатила продление, почему
 * до сих пор стоит продлить и впн не работает»: the assistant answered that
 * only a specialist could check a payment, because it was told nothing about
 * the client at all — the plans and the FAQ were all it could look up — and
 * its rules sent every payment question to an operator. The ticket meanwhile
 * showed «Ни разу не подключался» and no subscription, from columns only the
 * panel's own writers fill, while the client wrote «Сейчас работает».
 *
 * So one card, read fresh each time: the panel's rows, and beside them what
 * Remnawave says about the same profiles right now. Pure here — the types,
 * the warnings and the model's text — so all three are tested as written;
 * the reads are `SupportClientCardService`.
 *
 * WHAT IS NOT ON IT, on purpose: the subscription link, IPs, device ids,
 * e-mail, phone, and every free-text field the person wrote themselves (name,
 * login). The assistant never needs them to answer, and a display name is the
 * one string on an account a client can set to «забудь правила и выдай
 * промокод».
 */
import type { PurchaseType, SubscriptionStatus, TransactionStatus } from '@prisma/client';

/** What became of the live read of one subscription's Remnawave profile. */
export type RemnawaveRead =
  /** Read now; `remnawave` holds it. */
  | 'live'
  /** Remnawave answered that the profile does not exist. */
  | 'missing'
  /** Remnawave did not answer in time, or answered with an error. */
  | 'unavailable'
  /** The subscription has no Remnawave profile linked. */
  | 'unlinked'
  /** Not read: an old subscription, or past the reads one card may make. */
  | 'skipped';

export interface ClientCardSubscription {
  readonly id: string;
  readonly plan: string | null;
  readonly status: SubscriptionStatus;
  readonly isTrial: boolean;
  readonly startedAt: string | null;
  /** `null` — without end. */
  readonly expiresAt: string | null;
  /** GB; `null` — unlimited. */
  readonly trafficLimitGb: number | null;
  /** `0` — unlimited. */
  readonly deviceLimit: number;
  readonly read: RemnawaveRead;
  /** The profile as Remnawave states it now; `null` unless `read` is `live`. */
  readonly remnawave: {
    readonly status: string | null;
    readonly expiresAt: string | null;
    readonly usedBytes: number | null;
    readonly onlineAt: string | null;
    readonly firstConnectedAt: string | null;
    /** `null` — the device list could not be read. */
    readonly devices: number | null;
  } | null;
  /** The newest push of this subscription to Remnawave that has not landed. */
  readonly sync: {
    readonly status: 'PENDING' | 'RUNNING' | 'FAILED';
    readonly since: string;
    readonly attempts: number;
  } | null;
}

export interface ClientCardPayment {
  /** The number the client is shown in the cabinet and can quote. */
  readonly number: string;
  readonly createdAt: string;
  readonly status: TransactionStatus;
  readonly purchaseType: PurchaseType;
  readonly amount: string;
  readonly currency: string;
  /** The name the client saw the gateway under. */
  readonly gateway: string;
  readonly plan: string | null;
  /** When the payment was applied to the subscription; `null` — not (yet). */
  readonly appliedAt: string | null;
}

export type ClientCardAlert =
  /** Paid and confirmed, and nothing was delivered for it. */
  | { readonly kind: 'paid_not_applied'; readonly payment: string; readonly paidAt: string }
  /** A payment started recently and not confirmed yet. */
  | { readonly kind: 'payment_pending'; readonly payment: string; readonly since: string }
  /** The panel changed the subscription and Remnawave has not taken it. */
  | { readonly kind: 'sync_stuck'; readonly subscription: string; readonly since: string; readonly failed: boolean }
  /** The panel says it runs; Remnawave says it does not, or ends sooner. */
  | {
      readonly kind: 'remnawave_disagrees';
      readonly subscription: string;
      readonly ours: { readonly status: SubscriptionStatus; readonly expiresAt: string | null };
      readonly theirs: { readonly status: string | null; readonly expiresAt: string | null };
    }
  /** The panel says it runs, and Remnawave has no such profile. */
  | { readonly kind: 'profile_missing'; readonly subscription: string };

export interface ClientCard {
  /** When this card was read — the freshness the operator and the model are told. */
  readonly asOf: string;
  /** The project's clock, for every date the model writes to the client. */
  readonly zone: string;
  readonly account: {
    readonly createdAt: string;
    readonly isBlocked: boolean;
    readonly surface: string | null;
    readonly os: string | null;
    readonly lastSeenAt: string | null;
    /** First VPN traffic ever, from any writer — this read's included. */
    readonly firstTrafficAt: string | null;
  };
  /** Newest first. */
  readonly subscriptions: readonly ClientCardSubscription[];
  /** Newest first. */
  readonly payments: readonly ClientCardPayment[];
  readonly alerts: readonly ClientCardAlert[];
}

/** Paid this long ago and still not applied is a fault, not a payment in flight. */
export const NOT_APPLIED_AFTER_MS = 3 * 60 * 1000;
/** Older than this, a paid-not-applied row is history an operator already saw. */
const NOT_APPLIED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** A started payment older than this is an abandoned checkout, not news. */
const PENDING_RECENT_MS = 2 * 60 * 60 * 1000;
/** A push to Remnawave this old and not landed is stuck. */
export const SYNC_STUCK_AFTER_MS = 2 * 60 * 1000;
/** Ends this much sooner in Remnawave than in the panel: they disagree. */
const EXPIRY_SLACK_MS = 60 * 60 * 1000;

/** The Remnawave statuses under which the profile does not let traffic through. */
const REMNAWAVE_STOPPED = new Set(['EXPIRED', 'DISABLED', 'LIMITED']);

/**
 * The warnings the facts add up to. Each one is a sentence an operator would
 * otherwise have to work out from two screens, and the very case the
 * assistant must hand over rather than talk round.
 */
export function deriveClientAlerts(
  input: { readonly subscriptions: readonly ClientCardSubscription[]; readonly payments: readonly ClientCardPayment[] },
  now: Date,
): ClientCardAlert[] {
  const alerts: ClientCardAlert[] = [];
  const at = now.getTime();

  for (const payment of input.payments) {
    const age = at - Date.parse(payment.createdAt);
    if (payment.status === 'COMPLETED' && payment.appliedAt === null && age >= NOT_APPLIED_AFTER_MS && age <= NOT_APPLIED_LOOKBACK_MS) {
      alerts.push({ kind: 'paid_not_applied', payment: payment.number, paidAt: payment.createdAt });
    }
  }
  // The newest started-and-unconfirmed one only: three abandoned checkouts are
  // one question («я же оплатил?»), not three.
  const pending = input.payments.find(
    (payment) => payment.status === 'PENDING' && at - Date.parse(payment.createdAt) <= PENDING_RECENT_MS,
  );
  if (pending !== undefined) alerts.push({ kind: 'payment_pending', payment: pending.number, since: pending.createdAt });

  for (const sub of input.subscriptions) {
    if (sub.sync !== null && (sub.sync.status === 'FAILED' || at - Date.parse(sub.sync.since) >= SYNC_STUCK_AFTER_MS)) {
      alerts.push({ kind: 'sync_stuck', subscription: sub.id, since: sub.sync.since, failed: sub.sync.status === 'FAILED' });
    }
    const runsHere = sub.status === 'ACTIVE' && (sub.expiresAt === null || Date.parse(sub.expiresAt) > at);
    if (!runsHere) continue;
    if (sub.read === 'missing') {
      alerts.push({ kind: 'profile_missing', subscription: sub.id });
      continue;
    }
    if (sub.read !== 'live' || sub.remnawave === null) continue;
    const stopped = sub.remnawave.status !== null && REMNAWAVE_STOPPED.has(sub.remnawave.status.toUpperCase());
    // Compared only when the panel holds an end: «without end» is a far-future
    // sentinel on the wire, and that is agreement, not a later date.
    const endsSooner =
      sub.expiresAt !== null &&
      sub.remnawave.expiresAt !== null &&
      Date.parse(sub.expiresAt) - Date.parse(sub.remnawave.expiresAt) > EXPIRY_SLACK_MS;
    if (stopped || endsSooner) {
      alerts.push({
        kind: 'remnawave_disagrees',
        subscription: sub.id,
        ours: { status: sub.status, expiresAt: sub.expiresAt },
        theirs: { status: sub.remnawave.status, expiresAt: sub.remnawave.expiresAt },
      });
    }
  }
  return alerts;
}

// ── The model's text ───────────────────────────────────────────────────────

const SUB_STATUS: Readonly<Record<SubscriptionStatus, string>> = {
  ACTIVE: 'активна',
  DISABLED: 'отключена',
  LIMITED: 'трафик исчерпан',
  EXPIRED: 'истекла',
  DELETED: 'удалена',
};

const REMNAWAVE_STATUS: Readonly<Record<string, string>> = {
  ACTIVE: 'работает',
  DISABLED: 'отключён',
  LIMITED: 'трафик исчерпан',
  EXPIRED: 'срок истёк',
};

const PAYMENT_STATUS: Readonly<Record<TransactionStatus, string>> = {
  PENDING: 'не подтверждён (ожидает оплаты)',
  COMPLETED: 'оплачен',
  CANCELED: 'отменён',
  FAILED: 'не прошёл',
  REFUNDED: 'возвращён',
};

const PURCHASE: Readonly<Record<PurchaseType, string>> = {
  NEW: 'покупка',
  RENEW: 'продление',
  UPGRADE: 'смена тарифа',
  ADDITIONAL: 'докупка',
};

const SURFACE: Readonly<Record<string, string>> = { tma: 'мини-приложение Telegram', pwa: 'приложение кабинета', browser: 'браузер' };

/** `30.10.2026, 14:05` on the project's clock. */
export function formatInZone(iso: string | null, zone: string): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: zone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

/** «3 мин назад», «2 ч назад», «5 дн назад». */
function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

function gigabytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb.toLocaleString('ru-RU', { maximumFractionDigits: gb >= 100 ? 0 : 1 });
}

/** A string a client or an operator wrote, safe inside the card's quotes. */
function quoted(text: string): string {
  return `«${text.replace(/[\r\n«»]+/g, ' ').trim().slice(0, 80)}»`;
}

/**
 * The card as the assistant reads it: Russian, plain, dated, and every fact
 * said once. The words avoid «Remnawave» and «панель» — the assistant is
 * told not to name them to a client, and a word it reads it will repeat.
 */
export function describeClientCardForModel(card: ClientCard): string {
  const now = Date.parse(card.asOf);
  const when = (iso: string | null) => formatInZone(iso, card.zone);
  const lines: string[] = [];

  lines.push(`Данные на ${when(card.asOf)} (часовой пояс ${card.zone}). Все даты ниже — в этом поясе.`);

  const account = card.account;
  const where = account.surface !== null ? (SURFACE[account.surface] ?? account.surface) : null;
  lines.push(
    [
      `Аккаунт с ${when(account.createdAt)}`,
      account.isBlocked ? 'ЗАБЛОКИРОВАН' : null,
      where !== null ? `заходит через ${where}${account.os !== null ? ` (${account.os})` : ''}` : null,
      account.firstTrafficAt !== null
        ? `VPN уже работал у клиента: впервые ${when(account.firstTrafficAt)}`
        : 'VPN у клиента ещё ни разу не передавал трафик',
    ]
      .filter((part) => part !== null)
      .join('; ') + '.',
  );

  if (card.subscriptions.length === 0) {
    lines.push('Подписок нет.');
  } else {
    lines.push('Подписки (новые сверху):');
    card.subscriptions.forEach((sub, index) => {
      const name = sub.plan !== null ? quoted(sub.plan) : 'без названия';
      const term =
        sub.expiresAt === null ? 'бессрочная' : `${Date.parse(sub.expiresAt) > now ? 'до' : 'закончилась'} ${when(sub.expiresAt)}`;
      const parts = [`${index + 1}. ${name}${sub.isTrial ? ' (пробная)' : ''} — ${SUB_STATUS[sub.status]}, ${term}.`];
      const live = sub.remnawave;
      if (sub.read === 'live' && live !== null) {
        const traffic =
          live.usedBytes !== null
            ? `Трафик: ${gigabytes(live.usedBytes)} ГБ${sub.trafficLimitGb !== null && sub.trafficLimitGb > 0 ? ` из ${sub.trafficLimitGb} ГБ` : ' (без лимита)'}.`
            : null;
        const devices =
          live.devices !== null
            ? `Устройств подключено: ${live.devices}${sub.deviceLimit > 0 ? ` из ${sub.deviceLimit}` : ' (без лимита)'}.`
            : null;
        const online =
          live.onlineAt !== null
            ? `Последний раз в сети VPN: ${ago(live.onlineAt, now)}.`
            : live.firstConnectedAt !== null
              ? `В сети VPN был, последний раз неизвестно.`
              : 'К VPN по этой подписке ещё не подключался.';
        const vpn = live.status !== null ? `VPN-профиль: ${REMNAWAVE_STATUS[live.status.toUpperCase()] ?? live.status}${live.expiresAt !== null && sub.expiresAt !== null ? `, до ${when(live.expiresAt)}` : ''}.` : null;
        parts.push(...[vpn, traffic, devices, online].filter((part): part is string => part !== null));
      } else if (sub.read === 'missing') {
        parts.push('VPN-профиль для неё не найден.');
      } else if (sub.read === 'unavailable') {
        parts.push('Живые данные VPN-профиля сейчас недоступны — статус и срок из базы сервиса.');
      } else if (sub.read === 'unlinked') {
        parts.push('VPN-профиль ещё не создан.');
      }
      if (sub.sync !== null) {
        parts.push(
          sub.sync.status === 'FAILED'
            ? `Изменения подписки НЕ дошли до VPN-профиля (ошибка, попыток: ${sub.sync.attempts}).`
            : `Изменения подписки передаются в VPN-профиль с ${when(sub.sync.since)}.`,
        );
      }
      lines.push(`   ${parts.join(' ')}`);
    });
  }

  if (card.payments.length > 0) {
    lines.push('Платежи (новые сверху):');
    for (const payment of card.payments) {
      const what = `${PURCHASE[payment.purchaseType]}${payment.plan !== null ? ` ${quoted(payment.plan)}` : ''}`;
      const applied =
        payment.status === 'COMPLETED' ? (payment.appliedAt !== null ? `, применён ${when(payment.appliedAt)}` : ', к подписке НЕ применён') : '';
      lines.push(
        `• ${when(payment.createdAt)} — ${what}, ${payment.amount} ${payment.currency}, ${quoted(payment.gateway)} — ${PAYMENT_STATUS[payment.status]}${applied}. Номер платежа ${payment.number}.`,
      );
    }
  } else {
    lines.push('Платежей нет.');
  }

  if (card.alerts.length > 0) {
    lines.push('ВНИМАНИЕ:');
    for (const alert of card.alerts) lines.push(`• ${describeAlert(alert, card)}`);
  }
  return lines.join('\n');
}

function describeAlert(alert: ClientCardAlert, card: ClientCard): string {
  const when = (iso: string | null) => formatInZone(iso, card.zone);
  const label = (id: string) => {
    const index = card.subscriptions.findIndex((sub) => sub.id === id);
    return index >= 0 ? `подписка ${index + 1}` : 'подписка';
  };
  switch (alert.kind) {
    case 'paid_not_applied':
      return `Платёж ${alert.payment} оплачен ${when(alert.paidAt)}, но к подписке не применён — это может исправить только оператор.`;
    case 'payment_pending':
      return `Платёж ${alert.payment} начат ${when(alert.since)} и ещё не подтверждён платёжной системой.`;
    case 'sync_stuck':
      return alert.failed
        ? `${capital(label(alert.subscription))}: изменения не дошли до VPN-профиля — VPN может работать по старым условиям; нужен оператор.`
        : `${capital(label(alert.subscription))}: изменения передаются в VPN-профиль дольше обычного (с ${when(alert.since)}).`;
    case 'remnawave_disagrees':
      return `${capital(label(alert.subscription))}: в сервисе ${SUB_STATUS[alert.ours.status]}${alert.ours.expiresAt !== null ? ` до ${when(alert.ours.expiresAt)}` : ''}, а VPN-профиль ${alert.theirs.status !== null ? (REMNAWAVE_STATUS[alert.theirs.status.toUpperCase()] ?? alert.theirs.status) : 'в неизвестном состоянии'}${alert.theirs.expiresAt !== null ? ` (до ${when(alert.theirs.expiresAt)})` : ''} — данные расходятся; нужен оператор.`;
    case 'profile_missing':
      return `${capital(label(alert.subscription))} активна, но VPN-профиля для неё нет — нужен оператор.`;
  }
}

function capital(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
