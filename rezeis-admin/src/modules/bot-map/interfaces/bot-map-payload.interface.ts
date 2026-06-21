/**
 * bot-map-payload.interface
 * ─────────────────────────
 * Wire shape returned by `GET /admin/bot-map`. Same data the SPA list view
 * and the React Flow canvas tab consume — composed server-side once so
 * both views agree on every node and every edge. The bot-config payload
 * to reiwa is unchanged; this module is a denormalised admin-only view.
 */

import type {
  NotificationCategory,
  MiniAppRoute,
} from '../services/notification-target-resolver';

export type NodeKind =
  | 'graph-screen'
  | 'reply-keyboard'
  | 'notification'
  | 'mini-app-terminal';

export type NodeStatus = 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'DISABLED';

export interface BotMapBaseNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly title: string;
  readonly group: string;
  readonly status?: NodeStatus;
}

export interface GraphScreenMapNode extends BotMapBaseNode {
  readonly kind: 'graph-screen';
  readonly shortId: string;
  readonly isRoot: boolean;
  readonly textRu: string;
  readonly textEn: string;
  readonly buttonCount: number;
}

export interface ReplyKeyboardMapNode extends BotMapBaseNode {
  readonly kind: 'reply-keyboard';
  readonly buttons: ReadonlyArray<{
    readonly id: string;
    readonly buttonId: string;
    readonly label: string;
    readonly visible: boolean;
    readonly actionType: string;
    readonly actionTarget: string | null;
  }>;
}

export interface NotificationMapNode extends BotMapBaseNode {
  readonly kind: 'notification';
  /** `NotificationTemplate.id` (CUID). Used by the SPA inspector to PATCH the row. */
  readonly templateId: string;
  readonly type: string;
  readonly category: NotificationCategory;
  readonly titleRu: string;
  readonly titleEn: string | null;
  readonly bodyRu: string;
  readonly bodyEn: string | null;
  /** Optional banner image delivered with the notification (`null` = none). */
  readonly bannerUrl: string | null;
  readonly buttons: ReadonlyArray<{
    readonly labelRu: string;
    readonly labelEn: string | null;
    readonly kind: 'webApp' | 'url' | 'callback';
    readonly target: string;
  }>;
  readonly isActive: boolean;
}

export interface MiniAppTerminalMapNode extends BotMapBaseNode {
  readonly kind: 'mini-app-terminal';
  readonly route: MiniAppRoute;
  readonly descriptionRu: string;
  readonly descriptionEn: string;
}

export type BotMapNode =
  | GraphScreenMapNode
  | ReplyKeyboardMapNode
  | NotificationMapNode
  | MiniAppTerminalMapNode;

export type EdgeDestination =
  | { readonly kind: 'screen'; readonly shortId: string }
  | { readonly kind: 'webApp'; readonly route: string }
  | { readonly kind: 'url'; readonly host: string; readonly safe: boolean }
  | { readonly kind: 'chat' }
  | { readonly kind: 'callback'; readonly id: string }
  | { readonly kind: 'back' };

/** A single button → destination edge synthesised by the composer. */
export interface BotMapEdge {
  readonly id: string;
  readonly source: string;
  readonly sourceLabel: string;
  readonly target: string;
  readonly destination: EdgeDestination;
  /** False when the destination is unresolvable (dangling / unsafe). */
  readonly valid: boolean;
  readonly reason?: string;
}

export interface BotMapPayload {
  readonly nodes: ReadonlyArray<BotMapNode>;
  readonly edges: ReadonlyArray<BotMapEdge>;
  readonly meta: {
    /** Active flow status for the graph screens, when one is published. */
    readonly flowStatus: 'DRAFT' | 'PUBLISHED' | 'NONE';
    /** ISO timestamp of composition — used as a cheap freshness marker. */
    readonly composedAt: string;
  };
}
