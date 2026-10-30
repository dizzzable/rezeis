import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, RefreshCw } from 'lucide-react';

import { api } from '@/lib/api';
import { cn, formatDate, formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * «Клиент сейчас» — the ticket author's subscriptions, payments and live VPN
 * profile, read on open and every minute while the ticket is on screen.
 *
 * The owner, 30.10.2026, over a ticket whose header said «Ни разу не
 * подключался» and showed no subscription while the client wrote «Сейчас
 * работает»: those badges came from columns only the panel's own writers
 * fill. This block reads Remnawave beside them, says when it read, and puts
 * the faults it adds up to first. It is the same card the AI assistant reads
 * before every reply (`GET /admin/support-tickets/:id/client-card`).
 *
 * Once a minute, not with the thread's five seconds: every read goes to
 * Remnawave for each recent subscription.
 */

/** Mirrors `ClientCard` in `support-client-card.ts` (panel server). */
interface ClientCardSubscription {
  id: string;
  plan: string | null;
  status: 'ACTIVE' | 'DISABLED' | 'LIMITED' | 'EXPIRED' | 'DELETED';
  isTrial: boolean;
  expiresAt: string | null;
  trafficLimitGb: number | null;
  deviceLimit: number;
  read: 'live' | 'missing' | 'unavailable' | 'unlinked' | 'skipped' | 'not_read';
  remnawave: {
    status: string | null;
    expiresAt: string | null;
    usedBytes: number | null;
    onlineAt: string | null;
    firstConnectedAt: string | null;
    devices: number | null;
  } | null;
  sync: { status: 'PENDING' | 'RUNNING' | 'FAILED'; since: string; attempts: number } | null;
}

interface ClientCardPayment {
  number: string;
  createdAt: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELED' | 'FAILED' | 'REFUNDED';
  purchaseType: 'NEW' | 'RENEW' | 'UPGRADE' | 'ADDITIONAL';
  amount: string;
  currency: string;
  gateway: string;
  plan: string | null;
  appliedAt: string | null;
}

type ClientCardAlert =
  | { kind: 'paid_not_applied'; payment: string; paidAt: string }
  | { kind: 'payment_pending'; payment: string; since: string }
  | { kind: 'sync_stuck'; subscription: string; since: string; failed: boolean }
  | {
      kind: 'remnawave_disagrees';
      subscription: string;
      ours: { status: ClientCardSubscription['status']; expiresAt: string | null };
      theirs: { status: string | null; expiresAt: string | null };
    }
  | { kind: 'profile_missing'; subscription: string };

export interface ClientCard {
  asOf: string;
  zone: string;
  account: { firstTrafficAt: string | null };
  subscriptions: ClientCardSubscription[];
  payments: ClientCardPayment[];
  alerts: ClientCardAlert[];
}

export function ClientCardPanel({ ticketId }: { readonly ticketId: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<boolean | null>(null);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['support-ticket-client-card', ticketId],
    queryFn: async () => (await api.get<{ card: ClientCard | null }>(`/admin/support-tickets/${ticketId}/client-card`)).data,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  const card = data?.card ?? null;
  if (card === null || !Array.isArray(card.subscriptions)) return null;

  // Unfolded by itself when something is wrong: a fault is what the operator
  // has to see before answering.
  const expanded = open ?? card.alerts.length > 0;
  const k = (key: string) => `supportTicketsPage.detail.client.${key}`;
  const ago = (iso: string) => relativeAgo(iso, card.asOf, i18n.language);
  const label = (id: string) => {
    const index = card.subscriptions.findIndex((sub) => sub.id === id);
    const sub = card.subscriptions[index];
    return sub?.plan ?? `#${index + 1}`;
  };
  const current = card.subscriptions[0] ?? null;

  return (
    <div className="border-b px-4 py-2 text-xs" data-testid="ticket-client-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-foreground">{t(k('title'))}</span>
        {current !== null ? (
          <span className="min-w-0 truncate text-muted-foreground">
            {subscriptionSummary(current, t, card.asOf)}
          </span>
        ) : (
          <span className="text-muted-foreground">{t(k('noSubscriptions'))}</span>
        )}
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          {t(k('asOf'), { time: formatDateTime(card.asOf) })}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label={t(k('refresh'))}
            title={t(k('refresh'))}
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label={expanded ? t(k('hide')) : t(k('show'))}
            title={expanded ? t(k('hide')) : t(k('show'))}
            onClick={() => setOpen(!expanded)}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </span>
      </div>

      {card.alerts.length > 0 && (
        <ul className="mt-1.5 space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-200" data-testid="ticket-client-alerts">
          {card.alerts.map((alert, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{alertText(alert, t, label)}</span>
            </li>
          ))}
        </ul>
      )}

      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          <p className="text-muted-foreground">
            {card.account.firstTrafficAt !== null
              ? t(k('firstTraffic'), { date: formatDate(card.account.firstTrafficAt) })
              : t(k('neverConnected'))}
          </p>
          {card.subscriptions.map((sub) => (
            <div key={sub.id} className="rounded-md border px-2 py-1.5">
              <p className="text-foreground">{subscriptionSummary(sub, t, card.asOf)}</p>
              <p className="text-muted-foreground">{liveLine(sub, t, ago)}</p>
              {sub.sync !== null && (
                <p className={cn(sub.sync.status === 'FAILED' ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
                  {sub.sync.status === 'FAILED'
                    ? t(k('sync.failed'), { count: sub.sync.attempts })
                    : t(k('sync.pending'), { time: formatDateTime(sub.sync.since) })}
                </p>
              )}
            </div>
          ))}
          {card.payments.length > 0 && (
            <div>
              <p className="font-medium text-foreground">{t(k('payments'))}</p>
              <ul className="space-y-0.5">
                {card.payments.map((payment) => (
                  <li key={payment.number} className="text-muted-foreground">
                    {formatDateTime(payment.createdAt)} · {t(k(`purchase.${payment.purchaseType}`))}
                    {payment.plan ? ` «${payment.plan}»` : ''} · {payment.amount} {payment.currency} · {payment.gateway} ·{' '}
                    <span
                      className={cn(
                        payment.status === 'COMPLETED' && payment.appliedAt === null && 'font-medium text-rose-600 dark:text-rose-400',
                        payment.status === 'COMPLETED' && payment.appliedAt !== null && 'text-emerald-700 dark:text-emerald-400',
                      )}
                    >
                      {t(k(`paymentStatus.${payment.status}`))}
                      {payment.status === 'COMPLETED' &&
                        (payment.appliedAt !== null
                          ? `, ${t(k('applied'), { time: formatDateTime(payment.appliedAt) })}`
                          : `, ${t(k('notApplied'))}`)}
                    </span>{' '}
                    · №{payment.number}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type T = (key: string, options?: Record<string, unknown>) => string;

/** «Стандарт · Активна до 9 нояб. · пробная». */
function subscriptionSummary(sub: ClientCardSubscription, t: T, asOf: string): string {
  const k = (key: string) => `supportTicketsPage.detail.client.${key}`;
  const status = t(`supportTicketsPage.detail.ctx.sub.${sub.status.toLowerCase()}`, { defaultValue: sub.status });
  const term =
    sub.expiresAt === null
      ? t(k('noEnd'))
      : Date.parse(sub.expiresAt) > Date.parse(asOf)
        ? t(k('until'), { date: formatDateTime(sub.expiresAt) })
        : t(k('ended'), { date: formatDateTime(sub.expiresAt) });
  return [sub.plan ?? '—', `${status}, ${term}`, sub.isTrial ? t('supportTicketsPage.detail.ctx.trial') : null]
    .filter((part) => part !== null)
    .join(' · ');
}

/** What Remnawave says about the profile right now, or why it says nothing. */
function liveLine(sub: ClientCardSubscription, t: T, ago: (iso: string) => string): string {
  const k = (key: string) => `supportTicketsPage.detail.client.${key}`;
  if (sub.read !== 'live' || sub.remnawave === null) return t(k(`read.${sub.read}`));
  const live = sub.remnawave;
  const parts: string[] = [];
  if (live.status !== null) parts.push(t(k('remnawave'), { status: live.status }));
  if (live.usedBytes !== null) {
    const used = (live.usedBytes / 1024 ** 3).toFixed(live.usedBytes >= 100 * 1024 ** 3 ? 0 : 1);
    parts.push(
      sub.trafficLimitGb !== null && sub.trafficLimitGb > 0
        ? t(k('traffic'), { used, limit: sub.trafficLimitGb })
        : t(k('trafficUnlimited'), { used }),
    );
  }
  if (live.devices !== null) {
    parts.push(
      sub.deviceLimit > 0 ? t(k('devices'), { count: live.devices, limit: sub.deviceLimit }) : t(k('devicesUnlimited'), { count: live.devices }),
    );
  }
  parts.push(
    live.onlineAt !== null
      ? t(k('online'), { ago: ago(live.onlineAt) })
      : live.firstConnectedAt !== null
        ? t(k('onlineUnknown'))
        : t(k('neverOnline')),
  );
  return parts.join(' · ');
}

function alertText(alert: ClientCardAlert, t: T, label: (id: string) => string): string {
  const k = (key: string) => `supportTicketsPage.detail.client.alerts.${key}`;
  switch (alert.kind) {
    case 'paid_not_applied':
      return t(k('paid_not_applied'), { payment: alert.payment, time: formatDateTime(alert.paidAt) });
    case 'payment_pending':
      return t(k('payment_pending'), { payment: alert.payment, time: formatDateTime(alert.since) });
    case 'sync_stuck':
      return alert.failed
        ? t(k('sync_failed'), { plan: label(alert.subscription) })
        : t(k('sync_slow'), { plan: label(alert.subscription), time: formatDateTime(alert.since) });
    case 'remnawave_disagrees':
      return t(k('remnawave_disagrees'), {
        plan: label(alert.subscription),
        // The panel's own status in words; Remnawave's as Remnawave spells it,
        // which is what the operator will find on its page.
        ours: `${t(`supportTicketsPage.detail.client.status.${alert.ours.status}`, { defaultValue: alert.ours.status })}${alert.ours.expiresAt !== null ? ` ${t('supportTicketsPage.detail.client.until', { date: formatDateTime(alert.ours.expiresAt) })}` : ''}`,
        theirs: `${alert.theirs.status ?? '?'}${alert.theirs.expiresAt !== null ? ` ${t('supportTicketsPage.detail.client.until', { date: formatDateTime(alert.theirs.expiresAt) })}` : ''}`,
      });
    case 'profile_missing':
      return t(k('profile_missing'), { plan: label(alert.subscription) });
  }
}

/** «3 мин назад», «2 h ago» — against the card's own moment, not the clock. */
function relativeAgo(iso: string, asOf: string, language: string): string {
  const seconds = Math.round((Date.parse(iso) - Date.parse(asOf)) / 1000);
  const format = new Intl.RelativeTimeFormat(language.startsWith('ru') ? 'ru' : 'en', { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, 'minute');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 172_800) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86_400), 'day');
}
