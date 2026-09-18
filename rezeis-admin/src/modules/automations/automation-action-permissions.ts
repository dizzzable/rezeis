import type { RbacAction } from '../rbac/rbac.resources';
import type { AutomationActionType } from './automations.constants';

/**
 * What an action needs on top of the route's own `automations:*` permission.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 *
 * A rule runs as the system, so whatever its actions do they do with every
 * permission there is. The routes that write a rule asked for `automations:create`
 * or `automations:edit` and for nothing else — so an operator trusted with rules
 * and nothing more could save one that blocks an IP address (an admin's
 * included), posts event data to a URL of their choosing, or bans a customer:
 * three things the panel refuses them on the screens built for exactly that.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * An action needs the permission of the manual screen whose EFFECT it
 * reproduces, read off that screen's controller:
 *
 *   block_ip      `blocked_ips:create` — `BlockedIpsController.create`,
 *                 `POST /admin/blocked-ips`.
 *   block_user    `users:edit` — `AdminUserManagementController.blockUser`,
 *                 `POST /admin/users/:telegramId/block`. One customer per
 *                 firing, which is that route, not the bulk toolbar.
 *   webhook_post  `webhooks:create` — `AdminWebhooksController.createSubscription`,
 *                 `POST /admin/webhooks/subscriptions`: the one screen that
 *                 points event data at an address somebody typed. Asked on
 *                 every save, not only the first: a PUT replaces the whole
 *                 action list, so each save names the destination again.
 *
 * The other four reproduce no screen's effect, and so need nothing more:
 *
 *   notify_telegram, system_event
 *                 raise an event into the panel's own stream. Whether it
 *                 reaches the Telegram chat is decided by the delivery settings
 *                 (`settings:edit`): the event must be ticked there, or the
 *                 action FAILS "not ticked" (`describeTelegramDelivery`), so a
 *                 rule author cannot put anything into that chat that its
 *                 owners did not route there. Outgoing webhooks deliver it only
 *                 to subscriptions `webhooks:*` holders created. The one manual
 *                 path into the chat, the delivery probe
 *                 (`SettingsController.sendTelegramDeliveryTest`), bypasses that
 *                 routing — which is the difference, and why it is not the
 *                 counterpart. No admin route raises a custom event at all:
 *                 `POST /api/internal/events` is the cabinet's, behind the
 *                 internal secret.
 *   show_hint, show_hint_to_audience
 *                 queue a hint that already exists. What it says and whether it
 *                 may be shown at all (its switch, its surfaces) are the Hints
 *                 screen's, under `user_hints:*`; nothing outside automations
 *                 puts a hint in front of a chosen customer. The pop-up
 *                 templates already treat the two halves as two grants
 *                 (`automations-page.tsx`, "A POP-UP NEEDS TWO GRANTS").
 *
 * TOTAL over `AutomationActionType`, so an action type added to the catalogue
 * without an entry here does not compile — an empty list has to be typed out,
 * which is a decision rather than an omission. The same map is served to the
 * SPA by `GET /admin/automations/catalog`, so the editor greys out exactly what
 * this refuses.
 */
export const AUTOMATION_ACTION_PERMISSIONS: Readonly<
  Record<AutomationActionType, readonly AutomationActionPermission[]>
> = {
  notify_telegram: [],
  webhook_post: [{ resource: 'webhooks', action: 'create' }],
  block_ip: [{ resource: 'blocked_ips', action: 'create' }],
  system_event: [],
  block_user: [{ resource: 'users', action: 'edit' }],
  show_hint: [],
  show_hint_to_audience: [],
};

/** One permission, the way `@RequirePermission` names it. */
export interface AutomationActionPermission {
  readonly resource: string;
  readonly action: RbacAction;
}

/** A permission a set of actions needs, and which of those actions need it. */
export interface RequiredActionPermission extends AutomationActionPermission {
  /** `resource:action`, the token `RbacGuard` and the role editor use. */
  readonly token: string;
  /** The action types that need it, in the order they first appear. */
  readonly actionTypes: readonly string[];
}

/**
 * Every permission `actions` needs, once each, in the order first needed.
 *
 * Reads whatever it is handed: a stored rule's `actions` column is JSON, and an
 * import can put anything there. Anything that is not a list — or an element
 * that is not an object with a known `type` — needs nothing here, because it
 * does nothing either: the executor runs only a list, and the registry skips a
 * type it does not know.
 */
export function requiredActionPermissions(actions: unknown): readonly RequiredActionPermission[] {
  if (!Array.isArray(actions)) return [];
  const byToken = new Map<string, { permission: AutomationActionPermission; types: string[] }>();
  for (const action of actions) {
    const type = readActionType(action);
    if (type === null) continue;
    for (const permission of AUTOMATION_ACTION_PERMISSIONS[type]) {
      const token = `${permission.resource}:${permission.action}`;
      const entry = byToken.get(token) ?? { permission, types: [] };
      if (!entry.types.includes(type)) entry.types.push(type);
      byToken.set(token, entry);
    }
  }
  return Array.from(byToken.entries()).map(([token, entry]) => ({
    token,
    resource: entry.permission.resource,
    action: entry.permission.action,
    actionTypes: entry.types,
  }));
}

/**
 * The refusal, one sentence per missing permission.
 *
 * Starts the way `RbacGuard` words a missing route permission, so every client
 * that already recognises "Missing permission: x:y" still does, and names the
 * action that needs it — without that, an operator holding `automations:create`
 * is told they lack something the page never mentioned.
 */
export function describeMissingActionPermission(entry: RequiredActionPermission): string {
  const noun = entry.actionTypes.length === 1 ? 'action' : 'actions';
  return `Missing permission: ${entry.token} (needed by the ${entry.actionTypes.join(', ')} ${noun})`;
}

function readActionType(action: unknown): AutomationActionType | null {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return null;
  const type = (action as Record<string, unknown>)['type'];
  if (typeof type !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(AUTOMATION_ACTION_PERMISSIONS, type)
    ? (type as AutomationActionType)
    : null;
}
