/**
 * Constants used by the realtime gateway and any module that wants to
 * publish events over the WebSocket channel.
 */

/** Path the Socket.IO server is mounted on. */
export const REALTIME_NAMESPACE = '/realtime';

/** Server → client event name carrying a SystemEventsService payload. */
export const REALTIME_EVENT = 'event';

/** Server → client event name used for connection-level acknowledgements. */
export const REALTIME_READY = 'ready';

/** Client → server message asking to subscribe to one or more topics. */
export const REALTIME_SUBSCRIBE = 'subscribe';

/** Client → server message asking to unsubscribe from one or more topics. */
export const REALTIME_UNSUBSCRIBE = 'unsubscribe';

/** Heartbeat ping interval (ms). Engine.IO already does its own ping; this
 * is an application-level heartbeat used purely for observability. */
export const REALTIME_HEARTBEAT_INTERVAL_MS = 30_000;

/** Custom WS close codes used for typed reasons on the wire. */
export const REALTIME_CLOSE = {
  AUTH_FAILURE: 4001,
  ADMIN_INACTIVE: 4002,
  TOKEN_VERSION_MISMATCH: 4003,
} as const;

export type RealtimeCloseCode = (typeof REALTIME_CLOSE)[keyof typeof REALTIME_CLOSE];
