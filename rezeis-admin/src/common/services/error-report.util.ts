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
  readonly service?: string;
  readonly version: string;
  readonly commit: string;
  readonly branch: string;
}

const UNKNOWN = 'unknown';

/** rezeis build info from the image env (baked by the Dockerfile). */
export function getRezeisBuildInfo(): BuildInfo {
  return {
    service: 'rezeis',
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

/**
 * "Why it matters" for the few scopes where the surface default would lie.
 *
 * `api.upstream-unreachable` is the cabinet's own name for a request that
 * failed because something it depends on — in practice the panel — did not
 * answer in time or could not be reached (`EAI_AGAIN`, `ECONNREFUSED`,
 * `ETIMEDOUT`, …; see `reiwa/src/api/transient-upstream.ts`). The cabinet
 * answers those with `503` and `Retry-After`, deliberately NOT `500`, and says
 * so in that file. The `API` default below reads «необработанная ошибка… 500»,
 * which sent the operator hunting for a crash in the cabinet when the thing to
 * check was whether the panel was reachable from it.
 */
function scopeWhy(scope: string | null, meta: Record<string, unknown>): string | null {
  if (scope === 'api.upstream-unreachable') {
    const code = readStr(meta, 'code');
    return (
      `Панель (или другой сервис, от которого зависит запрос) не ответила кабинету вовремя ` +
      `или была недоступна${code !== null ? ` (${code})` : ''}. Пользователь получил ответ 503 ` +
      'с предложением повторить запрос — это сбой связи, а не ошибка 500 в кабинете.'
    );
  }
  return null;
}

/**
 * There is no page called «События», and no per-event download: this used to
 * send the operator to both. The stack is in the payload of the bulk export on
 * the «Системные события» tab, and the attachment switch lives on
 * «Уведомления» (it does nothing while report generation is «Выключено»).
 */
function defaultNextSteps(hasStack: boolean, txtAttached: boolean): string {
  if (txtAttached) {
    return 'Откройте приложенный .txt со stack trace и проверьте операцию, в которой возникла ошибка.';
  }
  if (hasStack) {
    return (
      'Полный stack trace есть в выгрузке: «Журнал аудита» → «Системные события» → «Скачать .txt» ' +
      '(в файле все события подряд, это ищите по времени). Чтобы отчёт приходил сюда файлом: ' +
      '«Уведомления» → вкладка «Настройки доставки» → «Отчёты об ошибках» → «Прикреплять .txt-отчёт ' +
      'к сообщениям об ошибках в Telegram», при «Формирование отчётов» не «Выключено».'
    );
  }
  return 'Проверьте логи сервиса по указанному источнику и операции.';
}

/**
 * «👤 Пользователь» — whom the event is about, from the keys
 * `enrichUserIdentity` fills in before either card is formatted.
 *
 * Shared by both cards. The incident card used to print no metadata at all, so
 * a sync that failed for good or a refund owed to a partner reached the
 * operator without saying whose it was. `null` when the event names nobody.
 */
export function formatUserBlockLines(meta: Record<string, unknown>): readonly string[] | null {
  if (!meta['userId'] && !meta['telegramId']) return null;
  const text = (value: unknown): string => escapeHtml(String(value));
  const userLines: string[] = [];
  if (meta['telegramId']) userLines.push(`🪪 Telegram ID: <code>${text(meta['telegramId'])}</code>`);
  if (meta['userId']) userLines.push(`👾 Reiwa ID: <code>${text(meta['userId'])}</code>`);
  const displayName = meta['userName'] ?? meta['firstName'];
  if (displayName) {
    const handle = meta['username'] ? ` (@${text(meta['username'])})` : '';
    userLines.push(`👤 Имя: ${text(displayName)}${handle}`);
  } else if (meta['username']) {
    userLines.push(`👤 Username: @${text(meta['username'])}`);
  }
  if (meta['login']) userLines.push(`🔑 Login: <code>${text(meta['login'])}</code>`);
  if (meta['email'] && !meta['fraudUserEmail']) userLines.push(`📧 Email: ${text(meta['email'])}`);
  return ['👤 <b>Пользователь:</b>', `<blockquote>${userLines.join('\n')}</blockquote>`];
}

/**
 * What a field reads when the event did not carry it.
 *
 * Named because the card now asks: an em dash is a placeholder, and a line
 * whose whole content is a placeholder is worth less than the space it takes
 * on a phone. `deriveError` still fills every field, so the .txt report and
 * the panel's own reader keep a value for each.
 */
const ABSENT = '—';

export function deriveError(
  event: ErrorReportEvent,
  fallbackBuild: BuildInfo,
  txtAttached: boolean,
): DerivedError {
  const meta = event.metadata;
  const source = readStr(meta, 'source') ?? (event.kind.includes('reiwa') ? UNKNOWN : 'panel');
  const surface = SURFACE_LABELS[source.toLowerCase()] ?? capitalize(source);
  const operation =
    readStr(meta, 'scope') ?? readStr(meta, 'operation') ?? readStr(meta, 'path') ?? ABSENT;
  const errorType = readStr(meta, 'errorName') ?? readStr(meta, 'errorType') ?? ABSENT;
  const errorMessage = stripOriginPrefix(event.message) || ABSENT;
  const filename = readStr(meta, 'filename');
  const lineno = readPositiveInteger(meta, 'lineno');
  const colno = readPositiveInteger(meta, 'colno');
  const stack = readStr(meta, 'stack');
  const build: BuildInfo = {
    service:
      readStr(meta, 'service') ??
      (event.kind.includes('reiwa') ? 'reiwa' : fallbackBuild.service ?? 'rezeis'),
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
    why: readStr(meta, 'why') ?? scopeWhy(readStr(meta, 'scope'), meta) ?? defaultWhy(surface),
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
  /**
   * The event type's own header, when the registry has one.
   *
   * Passed in rather than looked up here: the registry lives in
   * `system-events.service.ts`, which imports this file. Absent — an
   * unregistered type, or a caller that has no registry — and the card keeps
   * the wording it always had.
   */
  header?: { readonly emoji: string; readonly title: string },
): string {
  const d = deriveError(event, fallbackBuild, txtAttached);
  const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;
  const userBlock = formatUserBlockLines(event.metadata);

  // «💬 Сообщение», unless it only repeats «Почему это важно». The «Подключение
  // VPN» refusals log «Рассылка не отправлена. <reason>» and explain themselves
  // with that same <reason>, so one phone screen printed it twice. A block
  // left with nothing in it goes together with its heading.
  const repeatsWhy = d.why.length > 0 && d.errorMessage.includes(d.why);
  const errorLines = [
    ...(d.errorType !== ABSENT ? [`🧊 Тип: ${code(d.errorType)}`] : []),
    ...(repeatsWhy ? [] : [`💬 Сообщение: ${escapeHtml(d.errorMessage)}`]),
  ];

  const lines: string[] = [
    '#EventError',
    '',
    // EVERY error-severity event arrives here, including the ones that are a
    // refusal rather than a fault — six of the broadcast ones are — and
    // «Произошла ошибка!» over a caption 156 characters too long is the wrong
    // first line to read on a phone.
    `${header?.emoji ?? '⚙️'} <b>Событие: ${escapeHtml(header?.title ?? 'Произошла ошибка!')}</b>`,
    '',
    '❗ <b>Почему это важно:</b>',
    `<blockquote>${escapeHtml(d.why)}</blockquote>`,
    ...(userBlock !== null ? ['', ...userBlock] : []),
    // What to do comes before the technical blocks, not last. Sent as a
    // document caption (the .txt attached, on the relay and dev routes) the
    // card is clipped to 1024 characters FROM THE END — and the end used to be
    // this block, the one the operator acts on. Now the clip takes the build
    // and the context, which the attached .txt carries in full anyway.
    '',
    '🧭 <b>Что проверить дальше:</b>',
    `<blockquote>${escapeHtml(d.nextSteps)}</blockquote>`,
    ...(errorLines.length > 0
      ? ['', '⚠️ <b>Ошибка:</b>', `<blockquote>${errorLines.join('\n')}</blockquote>`]
      : []),
    '',
    '🌀 <b>Контекст:</b>',
    `<blockquote>🔎 Источник: ${code(d.source)}\n` +
      `🌫 Поверхность: ${escapeHtml(d.surface)}\n` +
      (d.operation !== ABSENT ? `❄️ Операция: ${code(d.operation)}\n` : '') +
      (d.filename !== null ? `📄 Файл: ${code(d.filename)}\n` : '') +
      (d.lineno !== null
        ? `📍 Место: ${code(`строка ${d.lineno}${d.colno !== null ? `, столбец ${d.colno}` : ''}`)}\n`
        : '') +
      `🧮 Уровень: ${escapeHtml(d.level)}</blockquote>`,
    '',
    '🏗 <b>Сборка:</b>',
    `<blockquote>🧩 Сервис: ${code(d.build.service ?? 'rezeis')}\n` +
      `🎯 Версия: ${code(d.build.version)}\n` +
      `🔩 Коммит: ${code(d.build.commit)}\n` +
      `⚙️ Ветка: ${code(d.build.branch)}</blockquote>`,
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
    `Сервис: ${d.build.service ?? 'rezeis'}`,
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
 * THE rule for "this event is an incident report" — the one both halves of
 * Telegram delivery have to agree on.
 *
 * ERROR severity qualifies, and so does a type named `*.error` at any
 * severity: `client.error` is always WARNING (`ClientErrorsController`) and
 * `reiwa.error` is WARNING whenever the cabinet reports at level `warning`,
 * and both are still incidents with a stack trace worth a `.txt`.
 *
 * It used to exist twice. The card renderer asked this question; the topic
 * router asked `severity === 'ERROR'` instead. So a WARNING `client.error` was
 * drawn as an incident card with its `.txt` attached — and then filed in the
 * category topic, «Система», instead of the error topic the operator set up
 * for exactly those cards. `resolveTelegramDeliveryTarget` now calls this
 * function rather than restating it.
 *
 * `type` is the bare event type (`client.error`), not the audit `kind`
 * (`event.client.error`); `(^|\.)` keeps the two spellings answering alike.
 */
export function isErrorReportEvent(event: {
  readonly severity?: string;
  readonly type: string;
}): boolean {
  return event.severity === 'ERROR' || /(^|\.)error$/.test(event.type);
}

/**
 * `true` when an event should be treated as an error report (drives the
 * pretty card, .txt attachment, and auto-archive). The same answer as
 * {@link isErrorReportEvent}, asked of the normalized report shape.
 */
export function isErrorEvent(event: { readonly severity: string; readonly kind: string }): boolean {
  return isErrorReportEvent({
    severity: event.severity,
    type: event.kind.replace(/^event\./, ''),
  });
}

/** Stable, filesystem-safe filename for an error .txt artifact. */
export function buildErrorReportFilename(event: { readonly id?: string; readonly timestamp: string }): string {
  const stamp = (event.id ?? event.timestamp).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  return `error_${stamp}.txt`;
}
