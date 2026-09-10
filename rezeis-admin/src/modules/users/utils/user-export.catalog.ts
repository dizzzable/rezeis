/**
 * user-export.catalog
 * ───────────────────
 * Which columns a user export can carry, and what each one costs.
 *
 * ── Why a catalogue and not a `select` ───────────────────────────────────────
 *
 * The operator picks the columns, so both halves have to agree on the same
 * list: the panel draws a checkbox per entry and the server projects a value
 * per entry. Two lists would drift the moment either side gained a column, and
 * the drift is silent in the worst direction — a checkbox that exports an empty
 * column reads as "there is no data", which is a conclusion an operator would
 * act on.
 *
 * So this file is the single list. The SPA imports nothing from it (packages
 * are separate) but reads it from the endpoint, so the checkboxes ARE the
 * server's columns rather than a copy of them.
 *
 * ── Three things a column can cost ───────────────────────────────────────────
 *
 * `source` is not decoration; it is what the caller pays for asking:
 *
 *   `user`         — a column on the row already being read. Free.
 *   `subscription` — needs the user's current subscription joined. One include.
 *   `panel`        — needs Remnawave's device inventory, which is a paged walk
 *                    of the operator's panel. Charged ONCE for the whole export
 *                    rather than per user, and skipped entirely when no column
 *                    from this group is picked.
 *
 * ── `elevated` is a permission, not a hint ───────────────────────────────────
 *
 * The registration snapshot — IP, user agent, referer, UTM — is raw PII behind
 * `users:export_registration`, deliberately separate from `users:view` so that
 * the day-to-day job never carries it. This export must not become the back
 * door to it: an elevated column asked for without that permission is refused,
 * not silently dropped, because a silently missing column is indistinguishable
 * from an empty one.
 */

export type UserExportSource = 'user' | 'subscription' | 'panel';

export interface UserExportColumn {
  /** Stable id: what the panel sends and the CSV header carries. */
  readonly id: string;
  /** Which group of work this column belongs to. */
  readonly source: UserExportSource;
  /** Needs `users:export_registration` on top of `users:export`. */
  readonly elevated?: true;
  /** The group an operator sees it under. */
  readonly group: UserExportGroup;
}

export type UserExportGroup =
  | 'identity'
  | 'status'
  | 'usage'
  | 'subscription'
  | 'devices'
  | 'acquisition'
  | 'registration';

/**
 * The catalogue, in the order the CSV writes its columns.
 *
 * The order is the file's, not the operator's: a spreadsheet whose columns move
 * about between two exports cannot be diffed against itself, and diffing two
 * exports a week apart is most of what this is for.
 */
export const USER_EXPORT_COLUMNS: readonly UserExportColumn[] = [
  // ── Кто это ───────────────────────────────────────────────────────────────
  { id: 'reiwa_id', source: 'user', group: 'identity' },
  { id: 'telegram_id', source: 'user', group: 'identity' },
  { id: 'username', source: 'user', group: 'identity' },
  { id: 'name', source: 'user', group: 'identity' },
  { id: 'email', source: 'user', group: 'identity' },
  { id: 'language', source: 'user', group: 'identity' },
  { id: 'role', source: 'user', group: 'identity' },
  { id: 'referral_code', source: 'user', group: 'identity' },

  // ── Состояние ─────────────────────────────────────────────────────────────
  { id: 'is_blocked', source: 'user', group: 'status' },
  { id: 'is_bot_blocked', source: 'user', group: 'status' },
  { id: 'created_at', source: 'user', group: 'status' },
  { id: 'last_seen_at', source: 'user', group: 'status' },
  { id: 'points', source: 'user', group: 'status' },
  { id: 'personal_discount', source: 'user', group: 'status' },

  // ── Чем пользуется ────────────────────────────────────────────────────────
  { id: 'pwa_installed', source: 'user', group: 'usage' },
  { id: 'pwa_installed_at', source: 'user', group: 'usage' },
  { id: 'last_surface', source: 'user', group: 'usage' },
  { id: 'last_form_factor', source: 'user', group: 'usage' },
  { id: 'last_os', source: 'user', group: 'usage' },
  { id: 'onboarding_completed_at', source: 'user', group: 'usage' },
  { id: 'first_traffic_at', source: 'user', group: 'usage' },

  // ── Подписка ──────────────────────────────────────────────────────────────
  { id: 'subscription_status', source: 'subscription', group: 'subscription' },
  { id: 'subscription_plan', source: 'subscription', group: 'subscription' },
  { id: 'subscription_expires_at', source: 'subscription', group: 'subscription' },
  { id: 'subscription_is_trial', source: 'subscription', group: 'subscription' },
  { id: 'subscription_traffic_limit_gb', source: 'subscription', group: 'subscription' },
  { id: 'subscription_device_limit', source: 'subscription', group: 'subscription' },
  { id: 'subscriptions_total', source: 'subscription', group: 'subscription' },

  // ── Устройства и приложения ───────────────────────────────────────────────
  { id: 'device_count', source: 'panel', group: 'devices' },
  { id: 'device_hwids', source: 'panel', group: 'devices' },
  // THE CLIENT, which is what an operator groups by — Happ, INCY, FlClash.
  // Remnawave reports it in the User-Agent column of its HWID table and nowhere
  // else, so this column is parsed out of that string rather than read off a
  // field of its own.
  { id: 'device_apps', source: 'panel', group: 'devices' },
  { id: 'device_user_agents', source: 'panel', group: 'devices' },
  { id: 'device_platforms', source: 'panel', group: 'devices' },
  { id: 'device_models', source: 'panel', group: 'devices' },
  { id: 'device_last_seen_at', source: 'panel', group: 'devices' },

  // ── Откуда пришёл ─────────────────────────────────────────────────────────
  { id: 'registration_channel', source: 'user', group: 'acquisition' },
  { id: 'acquisition_placement_id', source: 'user', group: 'acquisition' },
  { id: 'acquisition_at', source: 'user', group: 'acquisition' },

  // ── Снимок регистрации (нужно отдельное право) ────────────────────────────
  { id: 'registration_ip', source: 'user', elevated: true, group: 'registration' },
  { id: 'registration_user_agent', source: 'user', elevated: true, group: 'registration' },
  { id: 'registration_referer', source: 'user', elevated: true, group: 'registration' },
  { id: 'registration_utm', source: 'user', elevated: true, group: 'registration' },
];

export const USER_EXPORT_COLUMN_IDS: readonly string[] = USER_EXPORT_COLUMNS.map(
  (column) => column.id,
);

const BY_ID = new Map(USER_EXPORT_COLUMNS.map((column) => [column.id, column]));

/**
 * The columns an export will actually write, in catalogue order.
 *
 * An unknown id is DROPPED rather than refused: the panel and the server ship
 * in one image, so an id this build does not know came from a stale tab or a
 * hand-written URL, and neither is worth a 400 that loses the whole export.
 * An id this build knows but the caller may not have — an elevated one — is a
 * different matter and is refused by the caller; see `elevatedAmong`.
 *
 * Empty means "everything the caller may have", which is what an operator who
 * opened the dialog and pressed export without touching anything means.
 */
export function resolveExportColumns(
  requested: readonly string[] | undefined,
  options: { readonly allowElevated: boolean },
): readonly UserExportColumn[] {
  const permitted = USER_EXPORT_COLUMNS.filter(
    (column) => options.allowElevated || column.elevated !== true,
  );
  if (requested === undefined || requested.length === 0) return permitted;
  const wanted = new Set(requested);
  return permitted.filter((column) => wanted.has(column.id));
}

/** The elevated ids among a request, for the caller to refuse on. */
export function elevatedAmong(requested: readonly string[] | undefined): readonly string[] {
  if (requested === undefined) return [];
  return requested.filter((id) => BY_ID.get(id)?.elevated === true);
}

/** True when any picked column needs the panel's device inventory. */
export function needsPanelDevices(columns: readonly UserExportColumn[]): boolean {
  return columns.some((column) => column.source === 'panel');
}

/** True when any picked column needs the subscription join. */
export function needsSubscription(columns: readonly UserExportColumn[]): boolean {
  return columns.some((column) => column.source === 'subscription');
}
