import { ArgumentsHost, Catch, Logger, type WsExceptionFilter } from '@nestjs/common';

/**
 * Logs every exception a realtime gateway handler raises, with the event name
 * and the stack.
 *
 * Why it exists: Nest's default WS exception handler is
 * `WsExceptionsHandler.handle()`, which does `logger.error(exception)`. The
 * logger serialises a non-string through `JSON.stringify`, and an `Error` has
 * no enumerable own properties — so the operator's log said
 * `ERROR [WsExceptionsHandler] {}` every minute, with the message and the stack
 * lost. Installing this filter on `RealtimeGateway` replaces that one blind
 * spot with `event=… socket=… <name>: <message>` and the stack beneath it, while
 * behaving the same otherwise (log, do not close the socket).
 */
@Catch()
export class LoggingWsExceptionFilter implements WsExceptionFilter {
  private readonly logger = new Logger('RealtimeWsFilter');

  public catch(exception: unknown, host: ArgumentsHost): void {
    let event = 'unknown';
    let socketId = 'unknown';
    try {
      const ws = host.switchToWs();
      const pattern = ws.getPattern();
      if (typeof pattern === 'string' || typeof pattern === 'number') {
        event = String(pattern);
      }
      const client = ws.getClient<{ readonly id?: unknown } | undefined>();
      if (typeof client?.id === 'string') socketId = client.id;
    } catch {
      // The host shape differs (a connection event carries no pattern): the
      // log line is still worth writing without them.
    }
    this.logger.error(`Realtime WS exception (event=${event}, socket=${socketId}): ${describe(exception)}`);
  }
}

/** An error rendered so a nested cause is not lost. */
function describe(exception: unknown): string {
  if (exception instanceof Error) {
    // `Error.cause` is ES2022; this project's lib target predates it, and the
    // property is still there at runtime.
    const cause = (exception as { readonly cause?: unknown }).cause;
    const causeText =
      cause instanceof Error ? `\nCaused by: ${cause.name}: ${cause.message}\n${cause.stack ?? ''}` : '';
    return `${exception.name}: ${exception.message}${causeText}${exception.stack ? `\n${exception.stack}` : ''}`;
  }
  try {
    return JSON.stringify(exception);
  } catch {
    return String(exception);
  }
}
