export type OlcrtcAgentLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface OlcrtcAgentLogSink {
  write(line: string): void;
}

export interface OlcrtcAgentLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export class JsonOlcrtcAgentLogger implements OlcrtcAgentLogger {
  public constructor(
    private readonly sink: OlcrtcAgentLogSink = process.stdout,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', message, fields);
  }

  public info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }

  public warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', message, fields);
  }

  public error(message: string, fields: Record<string, unknown> = {}): void {
    this.write('error', message, fields);
  }

  private write(level: OlcrtcAgentLogLevel, message: string, fields: Record<string, unknown>): void {
    const sanitizedFields = sanitizeLogValue(fields) as Record<string, unknown>;
    this.sink.write(`${JSON.stringify({
      ts: this.now().toISOString(),
      component: 'rezeis-olc-agent',
      level,
      message,
      ...sanitizedFields,
    })}\n`);
  }
}

export function sanitizeLogValue(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    sanitized[key] = isSensitiveLogKey(key) ? '[redacted]' : sanitizeLogValue(nested);
  }
  return sanitized;
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isSensitiveLogKey(key: string): boolean {
  return /token|secret|password|credential|cryptokey|crypto_key|authorization|cookie/iu.test(key);
}
