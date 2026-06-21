import { describe, expect, it } from 'vitest'

import type { BotMapPayload } from '../../types'
import { buildCanvasGraph } from './build-canvas-graph'

function makePayload(overrides: Partial<BotMapPayload> = {}): BotMapPayload {
  return {
    nodes: [
      {
        id: 'graph:root',
        kind: 'graph-screen',
        title: 'Главное',
        group: 'graph',
        shortId: 'root',
        isRoot: true,
        textRu: 'Привет',
        textEn: 'Hi',
        buttonCount: 2,
      },
      {
        id: 'reply:menu',
        kind: 'reply-keyboard',
        title: 'Меню',
        group: 'reply',
        buttons: [],
      },
      {
        id: 'notification:expiry',
        kind: 'notification',
        title: 'Истекает',
        group: 'notification:expires',
        templateId: 'tpl-1',
        type: 'EXPIRY',
        category: 'expires',
        titleRu: 'Истекает',
        titleEn: null,
        bodyRu: 'Скоро истечёт',
        bodyEn: null,
        buttons: [],
        isActive: true,
      },
      {
        id: 'terminal:/renew',
        kind: 'mini-app-terminal',
        title: 'Продление',
        group: 'terminal',
        route: '/renew',
        descriptionRu: 'Страница продления',
        descriptionEn: 'Renew page',
      },
    ],
    edges: [
      {
        id: 'e-real',
        source: 'notification:expiry',
        sourceLabel: 'Продлить',
        target: 'terminal:/renew',
        destination: { kind: 'webApp', route: '/renew' },
        valid: true,
      },
      {
        id: 'e-synthetic',
        source: 'graph:root',
        sourceLabel: 'Поддержка',
        target: 'chat',
        destination: { kind: 'chat' },
        valid: true,
      },
      {
        id: 'e-invalid',
        source: 'notification:expiry',
        sourceLabel: 'Битая',
        target: 'callback:nowhere',
        destination: { kind: 'callback', id: 'nowhere' },
        valid: false,
        reason: 'unknown-target',
      },
    ],
    meta: { flowStatus: 'PUBLISHED', composedAt: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  }
}

describe('buildCanvasGraph', () => {
  it('keeps only edges whose source and target are both real nodes', () => {
    const { edges } = buildCanvasGraph(makePayload())
    expect(edges.map((e) => e.id)).toEqual(['e-real'])
  })

  it('marks each real-node edge as the destination type', () => {
    const { edges } = buildCanvasGraph(makePayload())
    expect(edges[0]?.type).toBe('destination')
    expect(edges[0]?.animated).toBe(true)
  })

  it('lays out nodes into deterministic columns by kind', () => {
    const { nodes } = buildCanvasGraph(makePayload())
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // reply + graph share the left column
    expect(byId.get('graph:root')?.position.x).toBe(0)
    expect(byId.get('reply:menu')?.position.x).toBe(0)
    // notifications middle, terminals right
    expect(byId.get('notification:expiry')?.position.x).toBe(380)
    expect(byId.get('terminal:/renew')?.position.x).toBe(760)
  })

  it('stacks nodes within a column without overlapping y', () => {
    const { nodes } = buildCanvasGraph(makePayload())
    const left = nodes
      .filter((n) => n.position.x === 0)
      .map((n) => n.position.y)
    expect(new Set(left).size).toBe(left.length)
  })

  it('passes the React Flow node type through from the node kind', () => {
    const { nodes } = buildCanvasGraph(makePayload())
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(byId.get('graph:root')?.type).toBe('graph-screen')
    expect(byId.get('terminal:/renew')?.type).toBe('mini-app-terminal')
  })
})
