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
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { io, type Socket } from 'socket.io-client';
import { forceEndAdminSession } from '@/lib/admin-session';
import { authStorage } from '@/lib/auth-storage';
import { getRealtimeInvalidationKeys } from './realtime-invalidation';
import { i18n } from '@/i18n/i18n';
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

function buildSocketUrl(): { url: string; path: string } {
  // dev (vite proxy) → relative; prod → same host. We always connect to the
  // current origin; `path` puts the WS endpoint under /api/socket.io.
  const url = typeof window !== 'undefined' ? window.location.origin : '';
  return { url, path: '/api/socket.io' };
}

function getAccessToken(): string | null {
  return authStorage.getToken() || null;
}

function scheduleInvalidate(
  queryClient: QueryClient,
  pending: Map<string, ReturnType<typeof setTimeout>>,
  queryKey: QueryKey,
): void {
  const key = JSON.stringify(queryKey);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pending.delete(key);
    queryClient.invalidateQueries({ queryKey });
  }, INVALIDATE_DEBOUNCE_MS);
  pending.set(key, handle);
}

/**
 * Compose a localized toast title + description from a realtime event.
 *
 * The wire `event.type` is a dotted system-event code (`remnawave.user.expired`)
 * and `event.message` is a server-composed English string — neither is shown
 * raw. We localize the event via `realtime.events.<flatType>` and the lane via
 * `realtime.categories.<category>`; unknown events degrade to a humanized
 * "<Category>: action" label, never the raw dotted key.
 */
function composeRealtimeToast(event: RealtimeEvent): { title: string; description?: string } {
  const flatType = event.type.replace(/\./g, '_');
  const eventKey = `realtime.events.${flatType}`;
  const translatedEvent = i18n.t(eventKey);
  const categoryLabel = String(
    i18n.t(`realtime.categories.${event.category}`, { defaultValue: event.category }),
  );
  if (translatedEvent !== eventKey) {
    return { title: String(translatedEvent), description: categoryLabel };
  }
  // Unknown event → humanized action, never the raw dotted code.
  const action = event.type.split('.').slice(1).join(' ').replace(/_/g, ' ').trim();
  return { title: action ? `${categoryLabel}: ${action}` : categoryLabel };
}

function showToastFor(event: RealtimeEvent): void {
  if (event.severity === 'INFO') return;
  const { title, description } = composeRealtimeToast(event);
  const opts = { description, duration: event.severity === 'ERROR' ? 6000 : 4500 };
  if (event.severity === 'ERROR') {
    toast.error(title, opts);
  } else if (event.severity === 'WARNING') {
    toast.warning(title, opts);
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
      for (const key of getRealtimeInvalidationKeys(event)) {
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
        // Stop trying to reconnect and clear the same client state as HTTP 401.
        stopped = true;
        forceEndAdminSession(queryClient);
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
