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

export type BotMapNode =
  | GraphScreenMapNode
  | ReplyKeyboardMapNode
  | NotificationMapNode
  | MiniAppTerminalMapNode

export type EdgeDestination =
  | { readonly kind: 'screen'; readonly shortId: string }
  | { readonly kind: 'webApp'; readonly route: string }
  | { readonly kind: 'url'; readonly host: string; readonly safe: boolean }
  | { readonly kind: 'chat' }
  | { readonly kind: 'callback'; readonly id: string }
  | { readonly kind: 'back' }

export interface BotMapEdge {
  readonly id: string
  readonly source: string
  readonly sourceLabel: string
  readonly target: string
  readonly destination: EdgeDestination
  readonly valid: boolean
  readonly reason?: string
}

export interface BotMapPayload {
  readonly nodes: ReadonlyArray<BotMapNode>
  readonly edges: ReadonlyArray<BotMapEdge>
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
