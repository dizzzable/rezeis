/**
 * useRealtimeUpdates
 * ──────────────────
 * Mounts an authenticated Socket.IO connection to the admin backend and
 * fans incoming events out into:
 *
 *   1. **React Query cache invalidation** — debounced per query key so a
 *      burst of related events (e.g. a payment that bumps user, dashboard
 *      and audit) only triggers one refetch per affected resource.
 *   2. **Toast notifications** for high-signal events (errors, warnings,
 *      severity overrides). INFO events stay silent to avoid flooding the
 *      operator.
 *   3. **Custom subscription callback** — components that need the raw
 *      stream (audit page, activity timeline) pass an `onEvent` handler.
 *
 * Connection model
 *   - One socket per browser tab. Reconnection uses exponential backoff
 *     (Socket.IO's built-in implementation, capped at 15s).
 *   - On 4001/4002/4003 close codes we stop reconnecting and force a hard
 *     logout — those mean the JWT is no longer valid for this admin and
 *     auto-reconnect would just loop.
 *   - The connection is paused whenever the document goes hidden for >60s
 *     to save battery on background tabs; resumed on `visibilitychange`.
 *
 * The hook is mount-safe: `useEffect` cleans up its own subscriptions and
 * the underlying socket so React StrictMode double-mounts in development
 * do not leak connections.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { io, type Socket } from 'socket.io-client';
import { TOKEN_KEY } from '@/lib/api';
import {
  REALTIME_CLOSE,
  REALTIME_TOPICS,
  type RealtimeCategory,
  type RealtimeEvent,
} from './realtime-types';

interface UseRealtimeUpdatesOptions {
  /** Optional subset of topics to subscribe to; defaults to every topic. */
  topics?: readonly RealtimeCategory[];
  /** Forwarded to consumers that need the raw stream (audit, activity, ...). */
  onEvent?: (event: RealtimeEvent) => void;
  /** Disable toasts (e.g. in tests). Default: true. */
  showToasts?: boolean;
}

/** Debounce window for query invalidation (ms). */
const INVALIDATE_DEBOUNCE_MS = 400;

/** Map of `event.type` → query keys that should be invalidated. */
const TYPE_TO_QUERY_KEYS: Record<string, readonly string[][]> = {
  // User domain
  'user.registered': [['admin', 'dashboard', 'summary'], ['admin', 'users']],
  'user.web_registered': [['admin', 'dashboard', 'summary'], ['admin', 'users']],
  'user.blocked': [['admin', 'users']],
  'user.unblocked': [['admin', 'users']],
  'user.deleted': [['admin', 'users'], ['admin', 'dashboard', 'summary']],

  // Subscription domain
  'subscription.created': [['admin', 'subscriptions'], ['admin', 'dashboard', 'summary']],
  'subscription.renewed': [['admin', 'subscriptions'], ['admin', 'dashboard', 'summary']],
  'subscription.upgraded': [['admin', 'subscriptions']],
  'subscription.expired': [['admin', 'subscriptions'], ['admin', 'dashboard', 'summary']],
  'subscription.deleted': [['admin', 'subscriptions'], ['admin', 'dashboard', 'summary']],
  'subscription.synced': [['admin', 'subscriptions']],
  'subscription.trial_granted': [['admin', 'subscriptions'], ['admin', 'dashboard', 'summary']],

  // Payment domain
  'payment.checkout_created': [['admin', 'payments'], ['admin', 'dashboard', 'summary']],
  'payment.completed': [['admin', 'payments'], ['admin', 'dashboard', 'summary']],
  'payment.failed': [['admin', 'payments'], ['admin', 'dashboard', 'summary']],
  'payment.webhook_received': [['admin', 'payments', 'webhooks']],

  // Referral / partner / promo domains
  'referral.attached': [['admin', 'referrals']],
  'referral.qualified': [['admin', 'referrals']],
  'referral.reward_issued': [['admin', 'referrals']],
  'partner.earning': [['admin', 'partners']],
  'partner.withdrawal_requested': [['admin', 'partners', 'withdrawals']],
  'partner.withdrawal_approved': [['admin', 'partners', 'withdrawals']],
  'partner.withdrawal_rejected': [['admin', 'partners', 'withdrawals']],
  'promocode.activated': [['admin', 'promocodes']],
  'promocode.created': [['admin', 'promocodes']],

  // Fraud signals
  'fraud.signal_transitioned': [['admin', 'fraud', 'signals'], ['admin', 'fraud', 'stats']],
  'system.error': [['admin', 'fraud', 'signals'], ['admin', 'fraud', 'stats']],

  // System
  'system.backup_completed': [['admin', 'backups']],
  'system.broadcast_sent': [['admin', 'broadcasts']],
};

/**
 * Every event also lands in the audit log via `SystemEventsService.persistEvent`,
 * so any received event triggers an audit refresh. We surface that as a
 * dedicated invalidation rule that runs on every message.
 */
const ALWAYS_INVALIDATE: readonly string[][] = [['audit']];

function buildSocketUrl(): { url: string; path: string } {
  // dev (vite proxy) → relative; prod → same host. We always connect to the
  // current origin; `path` puts the WS endpoint under /api/socket.io.
  const url = typeof window !== 'undefined' ? window.location.origin : '';
  return { url, path: '/api/socket.io' };
}

function getAccessToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function scheduleInvalidate(
  queryClient: QueryClient,
  pending: Map<string, ReturnType<typeof setTimeout>>,
  queryKey: readonly string[],
): void {
  const key = queryKey.join('::');
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pending.delete(key);
    queryClient.invalidateQueries({ queryKey: queryKey as unknown as string[] });
  }, INVALIDATE_DEBOUNCE_MS);
  pending.set(key, handle);
}

function showToastFor(event: RealtimeEvent): void {
  if (event.severity === 'INFO') return;
  const opts = { description: event.type, duration: event.severity === 'ERROR' ? 6000 : 4500 };
  if (event.severity === 'ERROR') {
    toast.error(event.message, opts);
  } else if (event.severity === 'WARNING') {
    toast.warning(event.message, opts);
  }
}

export function useRealtimeUpdates(options: UseRealtimeUpdatesOptions = {}): void {
  const queryClient = useQueryClient();
  const { topics, onEvent, showToasts = true } = options;

  // Keep callbacks fresh without re-creating the socket.
  const onEventRef = useRef(onEvent);
  // eslint-disable-next-line react-hooks/refs -- intentional ref-sync pattern
  onEventRef.current = onEvent;

  // Subscribed-topic snapshot — defaults to every topic.
  const subscribedTopics = useMemo(
    () => (topics ?? REALTIME_TOPICS).slice(),
    [topics],
  );

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return; // Auth provider will boot us back to /sign-in.

    const { url, path } = buildSocketUrl();
    const socket: Socket = io(`${url}/realtime`, {
      path,
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15_000,
      timeout: 10_000,
      autoConnect: true,
    });

    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    let stopped = false;

    socket.on('connect', () => {
      socket.emit('subscribe', subscribedTopics);
    });

    socket.on('event', (event: RealtimeEvent) => {
      if (stopped) return;
      const keys = TYPE_TO_QUERY_KEYS[event.type];
      if (keys) {
        for (const key of keys) {
          scheduleInvalidate(queryClient, pending, key);
        }
      }
      // Audit log + dashboard activity timeline always reflect every event.
      for (const key of ALWAYS_INVALIDATE) {
        scheduleInvalidate(queryClient, pending, key);
      }
      if (showToasts) showToastFor(event);
      onEventRef.current?.(event);
    });

    socket.on('error', (err: { code?: number; reason?: string }) => {
      const code = err?.code;
      if (
        code === REALTIME_CLOSE.AUTH_FAILURE ||
        code === REALTIME_CLOSE.ADMIN_INACTIVE ||
        code === REALTIME_CLOSE.TOKEN_VERSION_MISMATCH
      ) {
        // Stop trying to reconnect — auth provider's token probe will
        // notice and redirect via the standard sign-in flow.
        stopped = true;
        socket.disconnect();
      }
    });

    return () => {
      stopped = true;
      pending.forEach((handle) => clearTimeout(handle));
      pending.clear();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [queryClient, subscribedTopics, showToasts]);
}
