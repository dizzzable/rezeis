import {
  ConsoleLogger,
  Injectable,
  LoggerService as NestLoggerService,
  LogLevel,
} from '@nestjs/common';

const RING_BUFFER_SIZE = 5_000;
const VALID_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

export interface SystemLogEntryInterface {
  readonly id: number;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly context: string | null;
  readonly message: string;
  readonly stack?: string | null;
}

export interface SystemLogsQueryInterface {
  readonly limit?: number;
  readonly afterId?: number;
  readonly level?: LogLevel;
  readonly context?: string;
  readonly search?: string;
}

/**
 * In-memory ring buffer plus Nest `LoggerService` adapter.
 *
 * Two responsibilities:
 *
 * 1. **Capture** every log line emitted via Nest's `Logger`. The service
 *    is installed as the global logger by `main.ts` (`app.useLogger`),
 *    so `Logger.log/warn/error/...` calls everywhere in the codebase
 *    flow through `record()`.
 * 2. **Serve** recent logs to the admin UI via `getLogs()` — supports
 *    cursor-style pagination (`afterId`) for live tailing, plus
 *    level/context/search filters.
 *
 * The ring buffer holds the last `RING_BUFFER_SIZE` entries (≈ a few
 * minutes of busy traffic). We deliberately keep this in-memory only —
 * adding a DB table would amplify write volume, and the existing audit
 * log already captures domain-level events.
 */
@Injectable()
export class SystemLogsService implements NestLoggerService {
  private readonly buffer: SystemLogEntryInterface[] = [];
  private nextId = 1;
  private currentLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'log' : 'debug';
  /// Levels considered "enabled" right now. Mutating `currentLevel`
  /// rebuilds the set so callers can change verbosity at runtime.
  private enabledSet: Set<LogLevel> = computeEnabledSet(this.currentLevel);
  /// Underlying console logger so we keep mirroring lines to stdout.
  private readonly consoleLogger = new ConsoleLogger();

  // ── NestLoggerService — invoked by Logger / main.ts ──────────────────────

  public log(message: unknown, context?: string): void {
    this.dispatch('log', message, context);
  }

  public error(message: unknown, stackOrContext?: unknown, context?: string): void {
    let stack: string | null = null;
    let resolvedContext = context;
    if (typeof stackOrContext === 'string') {
      // Nest passes either the stack (when available) or the context.
      // Heuristic: multiline strings are stacks.
      if (stackOrContext.includes('\n')) {
        stack = stackOrContext;
      } else if (resolvedContext === undefined) {
        resolvedContext = stackOrContext;
      }
    }
    this.dispatch('error', message, resolvedContext, stack);
  }

  public warn(message: unknown, context?: string): void {
    this.dispatch('warn', message, context);
  }

  public debug(message: unknown, context?: string): void {
    if (!this.enabledSet.has('debug')) return;
    this.dispatch('debug', message, context);
  }

  public verbose(message: unknown, context?: string): void {
    if (!this.enabledSet.has('verbose')) return;
    this.dispatch('verbose', message, context);
  }

  public fatal?(message: unknown, context?: string): void {
    this.dispatch('fatal', message, context);
  }

  public setLogLevels?(levels: LogLevel[]): void {
    if (levels.length > 0) {
      // Take the most-verbose level supplied as the new floor.
      const ordered = [...VALID_LEVELS].reverse();
      const floor = ordered.find((l) => levels.includes(l)) ?? this.currentLevel;
      this.setLogLevel(floor);
    }
  }

  // ── Public API used by the admin UI / controller ──────────────────────────

  public setLogLevel(level: LogLevel): void {
    if (!VALID_LEVELS.includes(level)) return;
    this.currentLevel = level;
    this.enabledSet = computeEnabledSet(level);
    this.consoleLogger.setLogLevels(Array.from(this.enabledSet));
  }

  public getLogLevel(): LogLevel {
    return this.currentLevel;
  }

  public getLogs(query: SystemLogsQueryInterface = {}): {
    readonly entries: readonly SystemLogEntryInterface[];
    readonly latestId: number;
  } {
    const limit = clamp(query.limit ?? 200, 1, 1_000);
    const afterId = query.afterId ?? 0;
    const level = query.level;
    const ctx = query.context?.toLowerCase();
    const search = query.search?.toLowerCase();

    const filtered: SystemLogEntryInterface[] = [];
    for (let i = this.buffer.length - 1; i >= 0 && filtered.length < limit; i--) {
      const entry = this.buffer[i]!;
      if (entry.id <= afterId) break;
      if (level && entry.level !== level) continue;
      if (ctx && (entry.context ?? '').toLowerCase() !== ctx) continue;
      if (search && !entry.message.toLowerCase().includes(search)) continue;
      filtered.push(entry);
    }
    return {
      entries: filtered,
      latestId: this.buffer.length === 0 ? 0 : this.buffer[this.buffer.length - 1]!.id,
    };
  }

  public clearLogs(): void {
    this.buffer.length = 0;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private dispatch(
    level: LogLevel,
    rawMessage: unknown,
    context?: unknown,
    stack: string | null = null,
  ): void {
    const message = typeof rawMessage === 'string' ? rawMessage : safeStringify(rawMessage);
    const ctx = typeof context === 'string' ? context : null;
    const entry: SystemLogEntryInterface = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      level,
      context: ctx,
      message,
      stack,
    };
    this.buffer.push(entry);
    if (this.buffer.length > RING_BUFFER_SIZE) {
      this.buffer.shift();
    }
    // Mirror to console for container log aggregation.
    switch (level) {
      case 'error':
      case 'fatal':
        if (stack) this.consoleLogger.error(message, stack, ctx ?? undefined);
        else this.consoleLogger.error(message, ctx ?? undefined);
        break;
      case 'warn':
        this.consoleLogger.warn(message, ctx ?? undefined);
        break;
      case 'debug':
        this.consoleLogger.debug?.(message, ctx ?? undefined);
        break;
      case 'verbose':
        this.consoleLogger.verbose?.(message, ctx ?? undefined);
        break;
      default:
        this.consoleLogger.log(message, ctx ?? undefined);
    }
  }
}

function computeEnabledSet(level: LogLevel): Set<LogLevel> {
  // Order from least to most verbose. `fatal` is always on; each higher
  // level adds the levels above it.
  const order: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];
  const idx = order.indexOf(level);
  if (idx === -1) return new Set(order);
  return new Set(order.slice(0, idx + 1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
