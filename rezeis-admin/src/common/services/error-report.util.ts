/**
 * Error-report formatting (pure)
 * ──────────────────────────────
 * Turns a persisted/emitted SYSTEM error event into two artifacts:
 *
 *   1. `formatErrorEventCardHtml()` — a richly-sectioned Telegram HTML card
 *      (the operator/dev sees it inline). Sections mirror the agreed layout:
 *        #EventError → ⚙️ Событие → Почему это важно → Контекст
 *        (Источник/Поверхность/Операция/Уровень) → Информация о сборке
 *        (Версия/Коммит/Ветка) → ⚠️ Ошибка (Тип/Сообщение) → Что проверить дальше.
 *      The stack trace is intentionally NOT inlined — it lives in the .txt.
 *
 *   2. `formatErrorReportTxt()` — a human-readable plain-text report with the
 *      full stack trace + raw payload. Attached as `error_*.txt` to the
 *      Telegram message and downloadable per-event from the Events page.
 *
 * Both are pure functions over a normalized `ErrorReportEvent` so the layout
 * is unit-testable and can't silently regress. Missing fields degrade
 * gracefully (`unknown` / `—` / omitted) — the panel never blocks on a
 * sparse error payload.
 */

export interface ErrorReportEvent {
  /** Audit row id when known (download path); undefined at emit time. */
  readonly id?: string;
  /** Event kind, e.g. `event.reiwa.error` / `event.system.error`. */
  readonly kind: string;
  readonly severity: string;
  readonly category: string;
  /** Raw event message (may carry a `[reiwa:bot]` prefix). */
  readonly message: string;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
  /** Actor id / ip for the audit trail (panel-origin events). */
  readonly actor?: string | null;
}

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
  readonly branch: string;
}

const UNKNOWN = 'unknown';

/** rezeis build info from the image env (baked by the Dockerfile). */
export function getRezeisBuildInfo(): BuildInfo {
  return {
    version:
      process.env.APP_VERSION ?? process.env.npm_package_version ?? UNKNOWN,
    commit: normalizeShortSha(process.env.REZEIS_GIT_SHA) ?? UNKNOWN,
    branch: (process.env.REZEIS_GIT_BRANCH ?? '').trim() || UNKNOWN,
  };
}

function normalizeShortSha(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === UNKNOWN) return null;
  return trimmed.slice(0, 12);
}

interface DerivedError {
  readonly source: string;
  readonly surface: string;
  readonly operation: string;
  readonly level: string;
  readonly errorType: string;
  readonly errorMessage: string;
  readonly filename: string | null;
  readonly lineno: number | null;
  readonly colno: number | null;
  readonly why: string;
  readonly nextSteps: string;
  readonly build: BuildInfo;
  readonly stack: string | null;
}

const SURFACE_LABELS: Record<string, string> = {
  api: 'API',
  bot: 'Bot',
  worker: 'Worker',
  panel: 'Panel',
  rezeis: 'Panel',
};

/** Strips a `[reiwa:bot] ` style origin prefix from the event message. */
function stripOriginPrefix(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function readStr(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInteger(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Default "why it matters" / "what to check next" hints, derived from the
 * surface + operation when the reporter didn't supply explicit copy. Keeps
 * the card looking complete instead of showing empty sections.
 */
function defaultWhy(surface: string): string {
  switch (surface) {
    case 'Bot':
      return 'Сбой в обработке Telegram-апдейта — часть пользователей могла не получить ответ бота.';
    case 'API':
      return 'Необработанная ошибка в API — соответствующий запрос пользователя завершился ошибкой 500.';
    case 'Worker':
      return 'Сбой фоновой задачи — отложенная работа (рассылки/алёрты) могла не выполниться.';
    case 'Panel':
      return 'Необработанная ошибка в панели администратора.';
    default:
      return 'Зафиксирована необработанная ошибка в системе.';
  }
}

function defaultNextSteps(hasStack: boolean, txtAttached: boolean): string {
  if (txtAttached) {
    return 'Откройте приложенный .txt со stack trace и проверьте операцию, в которой возникла ошибка.';
  }
  if (hasStack) {
    return 'Полный stack trace доступен в .txt — скачайте его на странице «События» (вложение .txt в Telegram можно включить в настройках доставки).';
  }
  return 'Проверьте логи сервиса по указанному источнику и операции.';
}

export function deriveError(
  event: ErrorReportEvent,
  fallbackBuild: BuildInfo,
  txtAttached: boolean,
): DerivedError {
  const meta = event.metadata;
  const source = readStr(meta, 'source') ?? (event.kind.includes('reiwa') ? UNKNOWN : 'panel');
  const surface = SURFACE_LABELS[source.toLowerCase()] ?? capitalize(source);
  const operation =
    readStr(meta, 'scope') ?? readStr(meta, 'operation') ?? readStr(meta, 'path') ?? '—';
  const errorType = readStr(meta, 'errorName') ?? readStr(meta, 'errorType') ?? '—';
  const errorMessage = stripOriginPrefix(event.message) || '—';
  const filename = readStr(meta, 'filename');
  const lineno = readPositiveInteger(meta, 'lineno');
  const colno = readPositiveInteger(meta, 'colno');
  const stack = readStr(meta, 'stack');
  const build: BuildInfo = {
    version: readStr(meta, 'version') ?? fallbackBuild.version,
    commit: readStr(meta, 'commit') ?? fallbackBuild.commit,
    branch: readStr(meta, 'branch') ?? fallbackBuild.branch,
  };
  return {
    source,
    surface,
    operation,
    level: event.severity,
    errorType,
    errorMessage,
    filename,
    lineno,
    colno,
    why: readStr(meta, 'why') ?? defaultWhy(surface),
    nextSteps: readStr(meta, 'nextSteps') ?? defaultNextSteps(stack !== null, txtAttached),
    build,
    stack,
  };
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Pretty Telegram HTML card for an error event. No stack trace inline —
 * that lives in the attached .txt. Matches the agreed sectioned layout.
 */
export function formatErrorEventCardHtml(
  event: ErrorReportEvent,
  fallbackBuild: BuildInfo,
  txtAttached = false,
): string {
  const d = deriveError(event, fallbackBuild, txtAttached);
  const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;

  const lines: string[] = [
    '#EventError',
    '',
    '⚙️ <b>Событие: Произошла ошибка!</b>',
    '',
    '❗ <b>Почему это важно:</b>',
    `<blockquote>${escapeHtml(d.why)}</blockquote>`,
    '',
    '🌀 <b>Контекст:</b>',
    `<blockquote>🔎 Источник: ${code(d.source)}\n` +
      `🌫 Поверхность: ${escapeHtml(d.surface)}\n` +
      `❄️ Операция: ${code(d.operation)}\n` +
      (d.filename !== null ? `📄 Файл: ${code(d.filename)}\n` : '') +
      (d.lineno !== null
        ? `📍 Место: ${code(`строка ${d.lineno}${d.colno !== null ? `, столбец ${d.colno}` : ''}`)}\n`
        : '') +
      `🧮 Уровень: ${escapeHtml(d.level)}</blockquote>`,
    '',
    '🏗 <b>Сборка:</b>',
    `<blockquote>🎯 Версия: ${code(d.build.version)}\n` +
      `🔩 Коммит: ${code(d.build.commit)}\n` +
      `⚙️ Ветка: ${code(d.build.branch)}</blockquote>`,
    '',
    '⚠️ <b>Ошибка:</b>',
    `<blockquote>🧊 Тип: ${code(d.errorType)}\n` +
      `💬 Сообщение: ${escapeHtml(d.errorMessage)}</blockquote>`,
    '',
    '🧭 <b>Что проверить дальше:</b>',
    `<blockquote>${escapeHtml(d.nextSteps)}</blockquote>`,
  ];
  return lines.join('\n');
}

/**
 * Human-readable plain-text report for an error event. Includes the full
 * stack trace and the raw payload JSON. Used for the `.txt` attachment and
 * the per-event download endpoint.
 */
export function formatErrorReportTxt(
  event: ErrorReportEvent,
  fallbackBuild: BuildInfo,
): string {
  // The report IS the .txt, so its "next steps" reflect the attached-file copy.
  const d = deriveError(event, fallbackBuild, true);
  const actor = event.actor ?? 'system';
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(event.metadata, null, 2);
  } catch {
    payloadJson = '{}';
  }

  const lines: string[] = [
    '# Rezeis error report',
    `# generated: ${new Date().toISOString()}`,
    event.id !== undefined ? `# event id: ${event.id}` : '# event id: (pending persist)',
    '',
    `Время:      ${event.timestamp}`,
    `Severity:   ${d.level}`,
    `Категория:  ${event.category}`,
    `Событие:    ${event.kind}`,
    `Actor:      ${actor}`,
    '',
    '## Почему это важно',
    d.why,
    '',
    '## Контекст',
    `Источник:    ${d.source}`,
    `Поверхность: ${d.surface}`,
    `Операция:    ${d.operation}`,
    `Файл:        ${d.filename ?? '—'}`,
    `Строка:      ${d.lineno !== null ? `${d.lineno}${d.colno !== null ? `:${d.colno}` : ''}` : '—'}`,
    `Уровень:     ${d.level}`,
    '',
    '## Информация о сборке',
    `Версия: ${d.build.version}`,
    `Коммит: ${d.build.commit}`,
    `Ветка:  ${d.build.branch}`,
    '',
    '## Ошибка',
    `Тип:      ${d.errorType}`,
    `Сообщение: ${d.errorMessage}`,
    '',
    '## Что проверить дальше',
    d.nextSteps,
    '',
    '## Stack trace',
    d.stack ?? '(стек недоступен)',
    '',
    '## Полный payload (JSON)',
    payloadJson,
    '',
  ];
  return lines.join('\n');
}

/**
 * `true` when an event should be treated as an error report (drives the
 * pretty card, .txt attachment, and auto-archive). ERROR severity OR a
 * `*.error` event kind both qualify.
 */
export function isErrorEvent(event: { readonly severity: string; readonly kind: string }): boolean {
  return event.severity === 'ERROR' || /\.error$/.test(event.kind);
}

/** Stable, filesystem-safe filename for an error .txt artifact. */
export function buildErrorReportFilename(event: { readonly id?: string; readonly timestamp: string }): string {
  const stamp = (event.id ?? event.timestamp).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  return `error_${stamp}.txt`;
}
