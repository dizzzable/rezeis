/**
 * TypeScript shapes mirroring the backend `BotMapPayload` contract emitted
 * by `GET /admin/bot-map`. Kept in lockstep with the backend interface at
 * `src/modules/bot-map/interfaces/bot-map-payload.interface.ts`.
 *
 * The SPA renders directly off this shape — there is no client-side
 * recomputation of edges. When the backend grows the payload, only the
 * relevant editor + list view component needs updating.
 */

export type NodeKind =
  | 'graph-screen'
  | 'reply-keyboard'
  | 'notification'
  | 'mini-app-terminal'
  | 'system-screen'

export type NodeStatus = 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'DISABLED'

export type NotificationCategory =
  | 'expires'
  | 'referral'
  | 'partner'
  | 'promocode'
  | 'system'
  | 'other'

export interface BotMapBaseNode {
  readonly id: string
  readonly kind: NodeKind
  readonly title: string
  readonly group: string
  readonly status?: NodeStatus
}

export interface GraphScreenMapNode extends BotMapBaseNode {
  readonly kind: 'graph-screen'
  readonly shortId: string
  readonly isRoot: boolean
  readonly textRu: string
  readonly textEn: string
  readonly buttonCount: number
  /** Per-screen banner URL (photo media only); `null` when no photo banner. */
  readonly bannerUrl: string | null
}

export interface ReplyKeyboardMapNode extends BotMapBaseNode {
  readonly kind: 'reply-keyboard'
  readonly buttons: ReadonlyArray<{
    readonly id: string
    readonly buttonId: string
    readonly label: string
    readonly visible: boolean
    readonly actionType: string
    readonly actionTarget: string | null
  }>
}

export interface NotificationButtonShape {
  readonly labelRu: string
  readonly labelEn: string | null
  readonly kind: 'webApp' | 'url' | 'callback'
  readonly target: string
  /** Optional button color (premium-owner bots on Bot API 9.4+). */
  readonly style?: 'primary' | 'success' | 'danger' | 'default' | null
  /** Optional 0-based row index; buttons sharing a row render side-by-side. */
  readonly row?: number | null
}

export interface NotificationMapNode extends BotMapBaseNode {
  readonly kind: 'notification'
  readonly templateId: string
  readonly type: string
  readonly category: NotificationCategory
  readonly titleRu: string
  readonly titleEn: string | null
  readonly bodyRu: string
  readonly bodyEn: string | null
  readonly bannerUrl: string | null
  readonly buttons: ReadonlyArray<NotificationButtonShape>
  readonly isActive: boolean
}

export interface MiniAppTerminalMapNode extends BotMapBaseNode {
  readonly kind: 'mini-app-terminal'
  readonly route: string
  readonly descriptionRu: string
  readonly descriptionEn: string
}

/**
 * A bot screen with no flow block — the language picker, the channel gate's
 * prompt, the error message… (`SYSTEM_SCREENS` in
 * `features/bot-flow/system-screens.ts`). Never sent by the server: the SPA
 * adds these to the payload's nodes (`withBuiltInNodes`), so «Схема» and
 * «Список» list the same screens from one catalog. The id is the canvas
 * node's (`system:<id>`).
 */
export interface SystemScreenMapNode extends BotMapBaseNode {
  readonly kind: 'system-screen'
  /** `SystemScreen.id` of the catalog entry. */
  readonly screenId: string
}

export type BotMapNode =
  | GraphScreenMapNode
  | ReplyKeyboardMapNode
  | NotificationMapNode
  | MiniAppTerminalMapNode
  | SystemScreenMapNode

export type EdgeDestination =
  | { readonly kind: 'screen'; readonly shortId: string }
  | { readonly kind: 'webApp'; readonly route: string }
  | { readonly kind: 'url'; readonly host: string; readonly safe: boolean }
  /** A page of the cabinet website — a main-menu link typed as a path, or with none (reiwa `addressOn`). */
  | { readonly kind: 'site'; readonly path: string }
  /**
   * The support chat; `fallbackScreen` is the screen the tap opens instead
   * without a public support @username, set while the panel cannot tell
   * whether there is one (the composer's `routeEdge`).
   */
  | { readonly kind: 'chat'; readonly fallbackScreen?: string }
  | { readonly kind: 'callback'; readonly id: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'mainMenu' }

export interface BotMapEdge {
  readonly id: string
  readonly source: string
  readonly sourceLabel: string
  readonly target: string
  readonly destination: EdgeDestination
  readonly valid: boolean
  readonly reason?: string
}

/** A cabinet page a Mini App button can open — one row of the server's catalog. */
export interface MiniAppScreen {
  readonly route: string
  readonly nameRu: string
  readonly nameEn: string
  readonly descriptionRu: string
  readonly descriptionEn: string
}

export interface BotMapPayload {
  readonly nodes: ReadonlyArray<BotMapNode>
  readonly edges: ReadonlyArray<BotMapEdge>
  /**
   * Every page a Mini App button can open, whether or not a button reaches it
   * yet. Optional so a payload without it — one cached by a tab left open
   * across the upgrade — still renders; the screen field then falls back to a
   * typed path.
   */
  readonly miniAppScreens?: ReadonlyArray<MiniAppScreen>
  readonly meta: {
    readonly flowStatus: 'DRAFT' | 'PUBLISHED' | 'NONE'
    readonly composedAt: string
  }
}

/** Patch payload accepted by `PATCH /admin/notifications/templates/:id`. */
export interface UpdateNotificationTemplatePatch {
  readonly title?: string
  readonly body?: string
  readonly titleEn?: string | null
  readonly bodyEn?: string | null
  readonly buttons?: ReadonlyArray<NotificationButtonShape>
  readonly bannerUrl?: string | null
  readonly isActive?: boolean
}
