import { Injectable } from '@nestjs/common';
import {
  BotButton,
  BotButtonAction,
  BotFlow,
  BotFlowButton,
  BotFlowButtonAction,
  BotFlowMediaType,
  BotFlowScreen,
  BotFlowStatus,
  NotificationTemplate,
} from '@prisma/client';

import { BotFlowService } from '../../bot-flow/services/bot-flow.service';
import { BotButtonsService } from '../../bot-config/services/bot-buttons.service';
import { NotificationTemplatesService } from '../../notifications/services/notification-templates.service';
import {
  readStoredButtons,
  validateStoredButton,
  type StoredNotificationButton,
} from '../../notifications/utils/notification-template-locale.util';

import {
  MINI_APP_TERMINALS,
  miniAppTerminalNodeId,
} from '../catalogs/mini-app-terminals.catalog';
import {
  MiniAppRoute,
  resolveNotificationCategory,
  resolveTerminalRouteFor,
} from './notification-target-resolver';
import type {
  BotMapEdge,
  BotMapNode,
  BotMapPayload,
  EdgeDestination,
  GraphScreenMapNode,
  MiniAppTerminalMapNode,
  NotificationMapNode,
  ReplyKeyboardMapNode,
} from '../interfaces/bot-map-payload.interface';

const REPLY_KEYBOARD_NODE_ID = '__reply_keyboard__';

const KNOWN_MINI_APP_ROUTES = new Set<string>(MINI_APP_TERMINALS.map((t) => t.route));

type FlowWithScreens = BotFlow & {
  readonly screens: ReadonlyArray<
    BotFlowScreen & { readonly buttons: ReadonlyArray<BotFlowButton> }
  >;
};

interface ComposeInput {
  readonly flow: FlowWithScreens | null;
  readonly replyButtons: ReadonlyArray<BotButton>;
  readonly templates: ReadonlyArray<NotificationTemplate>;
}

/**
 * BotMapComposerService
 * ─────────────────────
 * Pure synthesis of the read-only payload `GET /admin/bot-map` returns.
 *
 * Reads:
 *   • The active `BotFlow` (PUBLISHED → DRAFT, same as reiwa) +
 *     each screen's NAVIGATE/URL/WEBAPP/CALLBACK/BACK/START_OVER buttons.
 *   • The reply-keyboard `BotButton` rows.
 *   • Every `NotificationTemplate` row + its stored `buttons` JSON.
 *
 * Emits:
 *   • One node per graph screen, one for the reply keyboard pseudo-node,
 *     one per notification template, one per Mini App terminal that any
 *     edge actually points at (terminals not referenced by any edge are
 *     trimmed to keep the canvas readable).
 *   • One edge per button — including `URL` / `WEBAPP` / `CALLBACK` /
 *     `BACK` graph buttons that never produced edges before. Invalid
 *     destinations (dangling shortIds, unsafe URLs, empty webApp paths)
 *     are flagged with `valid: false` so the SPA renders them red.
 *
 * Invariant: `compose(input)` is pure — no DB, no logging, no time
 * source besides `meta.composedAt` (the only impure value). Property
 * tests assert `nodes` ids stay unique and every edge's `source` /
 * `target` exist in the same payload.
 */
@Injectable()
export class BotMapComposerService {
  public constructor(
    private readonly botFlowService: BotFlowService,
    private readonly botButtonsService: BotButtonsService,
    private readonly notificationTemplatesService: NotificationTemplatesService,
  ) {}

  /** Live read — used by the controller. */
  public async build(): Promise<BotMapPayload> {
    const [flow, replyButtons, templates] = await Promise.all([
      this.botFlowService.getActive('Main Flow'),
      this.botButtonsService.listAll(),
      this.notificationTemplatesService.listAll(),
    ]);
    return this.compose({ flow, replyButtons, templates });
  }

  /** Pure synthesis — exposed for property tests. */
  public compose(input: ComposeInput): BotMapPayload {
    const nodes: BotMapNode[] = [];
    const edges: BotMapEdge[] = [];
    const referencedTerminals = new Set<string>();

    // ── Graph screens ────────────────────────────────────────────────
    const screensByShortId = new Map<string, FlowWithScreens['screens'][number]>();
    if (input.flow) {
      for (const screen of input.flow.screens) {
        screensByShortId.set(screen.shortId, screen);
      }
      for (const screen of input.flow.screens) {
        nodes.push(toGraphScreenNode(screen, input.flow));
      }
      for (const screen of input.flow.screens) {
        for (const button of screen.buttons) {
          const synthesized = composeGraphButtonEdge(
            screen,
            button,
            screensByShortId,
            referencedTerminals,
          );
          if (synthesized) edges.push(synthesized);
        }
      }
    }

    // ── Reply keyboard ───────────────────────────────────────────────
    nodes.push(toReplyKeyboardNode(input.replyButtons));
    for (const button of input.replyButtons) {
      if (!button.visible) continue;
      const synthesized = composeReplyButtonEdge(
        button,
        screensByShortId,
        referencedTerminals,
      );
      if (synthesized) edges.push(synthesized);
    }

    // ── Notification templates ───────────────────────────────────────
    for (const template of input.templates) {
      const node = toNotificationNode(template);
      nodes.push(node);
      // Synthesise edges for every stored button (even invalid ones —
      // we want the operator to see the broken edge in red).
      const stored = readStoredButtons((template as { buttons?: unknown }).buttons ?? null);
      let edgeIndex = 0;
      for (const button of stored) {
        const synthesized = composeNotificationButtonEdge(
          node.id,
          edgeIndex++,
          button,
          referencedTerminals,
          screensByShortId,
        );
        edges.push(synthesized);
      }
      // Implicit click-through edge: when no buttons are configured, the
      // notification's primary destination is still a Mini App route
      // (per `resolveNotificationPushUrl`). We record that as a virtual
      // dashed edge with no source label so the canvas tells the
      // operator where the deep-link goes by default.
      if (stored.length === 0) {
        const route = resolveTerminalRouteFor(template.type);
        referencedTerminals.add(route);
        edges.push({
          id: `notif-default-${template.id}`,
          source: node.id,
          sourceLabel: '',
          target: miniAppTerminalNodeId(route),
          destination: { kind: 'webApp', route },
          valid: true,
        });
      }
    }

    // ── Mini App terminals (only those that any edge targets) ────────
    for (const terminal of MINI_APP_TERMINALS) {
      if (!referencedTerminals.has(terminal.route)) continue;
      nodes.push(toTerminalNode(terminal));
    }

    return {
      nodes,
      edges,
      meta: {
        flowStatus: input.flow
          ? input.flow.status === BotFlowStatus.PUBLISHED
            ? 'PUBLISHED'
            : 'DRAFT'
          : 'NONE',
        composedAt: new Date().toISOString(),
      },
    };
  }
}

// ── Node factories ─────────────────────────────────────────────────────

function toGraphScreenNode(
  screen: FlowWithScreens['screens'][number],
  flow: FlowWithScreens,
): GraphScreenMapNode {
  return {
    id: screen.id,
    kind: 'graph-screen',
    title: screen.name,
    group: 'graph',
    status: flow.status === BotFlowStatus.PUBLISHED ? 'PUBLISHED' : 'DRAFT',
    shortId: screen.shortId,
    isRoot: screen.isRoot,
    textRu: screen.textRu,
    textEn: screen.textEn,
    buttonCount: screen.buttons.length,
    // Only a PHOTO counts as a per-screen banner (reiwa's `resolveScreenBannerRef`
    // renders `mediaType==='photo'` + `mediaUrl`). Video/document/animation media
    // isn't a banner, so it's not surfaced to the banner field.
    bannerUrl: screen.mediaType === BotFlowMediaType.PHOTO ? screen.mediaUrl : null,
  };
}

function toReplyKeyboardNode(buttons: ReadonlyArray<BotButton>): ReplyKeyboardMapNode {
  return {
    id: REPLY_KEYBOARD_NODE_ID,
    kind: 'reply-keyboard',
    title: 'Reply-клавиатура',
    group: 'reply',
    buttons: buttons.map((b) => ({
      id: b.id,
      buttonId: b.buttonId,
      label: b.label,
      visible: b.visible,
      actionType: String(b.actionType).toLowerCase(),
      actionTarget: b.actionTarget ?? null,
    })),
  };
}

function toNotificationNode(template: NotificationTemplate): NotificationMapNode {
  const stored = readStoredButtons((template as { buttons?: unknown }).buttons ?? null);
  return {
    id: `notif:${template.type}`,
    kind: 'notification',
    title: template.title,
    group: `notification:${resolveNotificationCategory(template.type)}`,
    status: template.isActive ? 'ACTIVE' : 'DISABLED',
    templateId: template.id,
    type: template.type,
    category: resolveNotificationCategory(template.type),
    titleRu: template.title,
    titleEn: (template as { titleEn?: string | null }).titleEn ?? null,
    bodyRu: template.body,
    bodyEn: (template as { bodyEn?: string | null }).bodyEn ?? null,
    bannerUrl: (template as { bannerUrl?: string | null }).bannerUrl ?? null,
    isActive: template.isActive,
    buttons: stored.map((b: StoredNotificationButton) => ({
      labelRu: b.labelRu,
      labelEn: b.labelEn ?? null,
      kind: b.kind,
      target: b.target,
      style: b.style ?? null,
      row: b.row ?? null,
    })),
  };
}

function toTerminalNode(terminal: (typeof MINI_APP_TERMINALS)[number]): MiniAppTerminalMapNode {
  return {
    id: miniAppTerminalNodeId(terminal.route),
    kind: 'mini-app-terminal',
    title: terminal.nameRu,
    group: 'terminal',
    route: terminal.route as MiniAppRoute,
    descriptionRu: terminal.descriptionRu,
    descriptionEn: terminal.descriptionEn,
  };
}

// ── Edge composers ────────────────────────────────────────────────────

function composeGraphButtonEdge(
  screen: FlowWithScreens['screens'][number],
  button: BotFlowButton,
  screensByShortId: Map<string, FlowWithScreens['screens'][number]>,
  referencedTerminals: Set<string>,
): BotMapEdge | null {
  const id = `flow-btn:${button.id}`;
  const label = button.labelRu || button.labelEn || '';
  const source = screen.id;
  switch (button.actionType) {
    case BotFlowButtonAction.NAVIGATE: {
      const targetShortId = button.targetScreenId;
      if (!targetShortId) {
        return invalidEdge(id, source, label, 'unset-navigate-target');
      }
      const target = screensByShortId.get(targetShortId);
      if (!target) {
        return invalidEdge(id, source, label, 'unknown-shortid');
      }
      return {
        id,
        source,
        sourceLabel: label,
        target: target.id,
        destination: { kind: 'screen', shortId: targetShortId },
        valid: true,
      };
    }
    case BotFlowButtonAction.URL: {
      const trimmed = (button.url ?? '').trim();
      const safe = isTelegramSafeUrl(trimmed);
      const host = safeHost(trimmed);
      return {
        id,
        source,
        sourceLabel: label,
        target: `url:${host}`,
        destination: { kind: 'url', host, safe },
        valid: safe,
        reason: safe ? undefined : 'unsafe-url',
      };
    }
    case BotFlowButtonAction.WEBAPP: {
      const trimmed = (button.webAppUrl ?? '').trim();
      const route = relativeRoute(trimmed);
      if (route !== null && KNOWN_MINI_APP_ROUTES.has(route)) {
        referencedTerminals.add(route);
        return {
          id,
          source,
          sourceLabel: label,
          target: miniAppTerminalNodeId(route),
          destination: { kind: 'webApp', route },
          valid: true,
        };
      }
      // Absolute (operator-supplied) Mini App URL — surface as a url edge.
      const safe = isTelegramSafeUrl(trimmed);
      return {
        id,
        source,
        sourceLabel: label,
        target: `url:${safeHost(trimmed)}`,
        destination: { kind: 'url', host: safeHost(trimmed), safe },
        valid: safe,
        reason: safe ? undefined : 'unsafe-webapp',
      };
    }
    case BotFlowButtonAction.CALLBACK: {
      const id_ = (button.callbackAction ?? '').trim();
      return {
        id,
        source,
        sourceLabel: label,
        target: `callback:${id_ || '∅'}`,
        destination: { kind: 'callback', id: id_ },
        valid: id_.length > 0,
        reason: id_.length > 0 ? undefined : 'empty-callback',
      };
    }
    case BotFlowButtonAction.BACK:
    case BotFlowButtonAction.START_OVER:
      return {
        id,
        source,
        sourceLabel: label,
        target: 'back',
        destination: { kind: 'back' },
        valid: true,
      };
    case BotFlowButtonAction.SUPPORT_URL:
      return {
        id,
        source,
        sourceLabel: label,
        target: 'chat',
        destination: { kind: 'chat' },
        valid: true,
      };
    default:
      return null;
  }
}

function composeReplyButtonEdge(
  button: BotButton,
  screensByShortId: Map<string, FlowWithScreens['screens'][number]>,
  referencedTerminals: Set<string>,
): BotMapEdge | null {
  const id = `reply-btn:${button.id}`;
  const source = REPLY_KEYBOARD_NODE_ID;
  const label = button.label;
  const target = (button.actionTarget ?? '').trim();
  switch (button.actionType) {
    case BotButtonAction.SCREEN: {
      if (target.length === 0) return invalidEdge(id, source, label, 'unset-screen-target');
      const screen = screensByShortId.get(target);
      if (!screen) return invalidEdge(id, source, label, 'unknown-shortid');
      return {
        id,
        source,
        sourceLabel: label,
        target: screen.id,
        destination: { kind: 'screen', shortId: target },
        valid: true,
      };
    }
    case BotButtonAction.URL: {
      const safe = isTelegramSafeUrl(target);
      return {
        id,
        source,
        sourceLabel: label,
        target: `url:${safeHost(target)}`,
        destination: { kind: 'url', host: safeHost(target), safe },
        valid: safe,
        reason: safe ? undefined : 'unsafe-url',
      };
    }
    case BotButtonAction.WEBAPP: {
      const route = relativeRoute(target);
      if (route !== null && KNOWN_MINI_APP_ROUTES.has(route)) {
        referencedTerminals.add(route);
        return {
          id,
          source,
          sourceLabel: label,
          target: miniAppTerminalNodeId(route),
          destination: { kind: 'webApp', route },
          valid: true,
        };
      }
      const safe = isTelegramSafeUrl(target);
      return {
        id,
        source,
        sourceLabel: label,
        target: `url:${safeHost(target)}`,
        destination: { kind: 'url', host: safeHost(target), safe },
        valid: safe,
        reason: safe ? undefined : 'unsafe-webapp',
      };
    }
    case BotButtonAction.SUPPORT_URL:
      return {
        id,
        source,
        sourceLabel: label,
        target: 'chat',
        destination: { kind: 'chat' },
        valid: true,
      };
    case BotButtonAction.CALLBACK:
    default:
      return {
        id,
        source,
        sourceLabel: label,
        target: `callback:${button.buttonId}`,
        destination: { kind: 'callback', id: button.buttonId },
        valid: true,
      };
  }
}

function composeNotificationButtonEdge(
  source: string,
  index: number,
  button: StoredNotificationButton,
  referencedTerminals: Set<string>,
  screensByShortId: Map<string, FlowWithScreens['screens'][number]>,
): BotMapEdge {
  const id = `notif-btn:${source}:${index}`;
  const label = button.labelRu;
  const target = button.target.trim();
  if (button.kind === 'webApp') {
    if (target.length === 0) return invalidEdge(id, source, label, 'empty-webapp');
    if (KNOWN_MINI_APP_ROUTES.has(target)) {
      referencedTerminals.add(target);
      return {
        id,
        source,
        sourceLabel: label,
        target: miniAppTerminalNodeId(target),
        destination: { kind: 'webApp', route: target },
        valid: true,
      };
    }
    // Relative-but-unknown route — flag as invalid so the operator
    // sees the typo (`/promoo` vs `/promo`).
    return {
      id,
      source,
      sourceLabel: label,
      target: `url:unknown-route`,
      destination: { kind: 'webApp', route: target },
      valid: false,
      reason: 'unknown-mini-app-route',
    };
  }
  if (button.kind === 'url') {
    const safe = validateStoredButton(button);
    return {
      id,
      source,
      sourceLabel: label,
      target: `url:${safeHost(target)}`,
      destination: { kind: 'url', host: safeHost(target), safe },
      valid: safe,
      reason: safe ? undefined : 'unsafe-url',
    };
  }
  // callback
  if (target.length === 0) {
    return {
      id,
      source,
      sourceLabel: label,
      target: `callback:∅`,
      destination: { kind: 'callback', id: target },
      valid: false,
      reason: 'empty-callback',
    };
  }
  // Resolve callbacks that open a graph screen so the canvas draws an arrow
  // to it: the well-known "main menu" callback → the always-present reply
  // keyboard (the bot's main menu, shown even when no root graph screen is
  // configured), and any callback whose id matches a screen shortId → that
  // screen. Other callbacks (handled by the bot at runtime) keep a synthetic
  // target with no node.
  if (target === 'menu:main' || target === 'menu') {
    return {
      id,
      source,
      sourceLabel: label,
      target: REPLY_KEYBOARD_NODE_ID,
      destination: { kind: 'mainMenu' },
      valid: true,
    };
  }
  const callbackScreenNode = screensByShortId.get(target) ?? null;
  if (callbackScreenNode !== null) {
    return {
      id,
      source,
      sourceLabel: label,
      target: callbackScreenNode.id,
      destination: { kind: 'screen', shortId: callbackScreenNode.shortId },
      valid: true,
    };
  }
  return {
    id,
    source,
    sourceLabel: label,
    target: `callback:${target}`,
    destination: { kind: 'callback', id: target },
    valid: true,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function invalidEdge(
  id: string,
  source: string,
  label: string,
  reason: string,
): BotMapEdge {
  return {
    id,
    source,
    sourceLabel: label,
    target: `invalid:${reason}`,
    destination: { kind: 'callback', id: '' },
    valid: false,
    reason,
  };
}

function isTelegramSafeUrl(url: string): boolean {
  if (url.length === 0) return false;
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  if (lower.includes('://localhost') || lower.includes('://127.0.0.1')) return false;
  return true;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || 'unknown';
  }
}

/** Detect a relative path like `/renew` (no scheme); returns null for absolute URLs. */
function relativeRoute(value: string): string | null {
  if (value.length === 0) return null;
  if (value.includes('://')) return null;
  return value.startsWith('/') ? value : null;
}
