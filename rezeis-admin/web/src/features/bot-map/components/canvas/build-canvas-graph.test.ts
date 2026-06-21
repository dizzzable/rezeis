import { describe, expect, it } from 'vitest'

import type { BotMapPayload } from '../../types'
import { buildCanvasGraph, INVALID_EDGE_COLOR, pickEdgeColor } from './build-canvas-graph'

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
        id: 'e-reply',
        source: 'reply:menu',
        sourceLabel: 'Меню',
        target: 'graph:root',
        destination: { kind: 'screen', shortId: 'root' },
        valid: true,
      },
      {
        id: 'e-real-invalid',
        source: 'graph:root',
        sourceLabel: 'Битая',
        target: 'terminal:/renew',
        destination: { kind: 'webApp', route: '/renew' },
        valid: false,
        reason: 'unsafe-webapp',
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
    expect(edges.map((e) => e.id)).toEqual(['e-real', 'e-reply', 'e-real-invalid'])
  })

  it('marks each real-node edge as the destination type', () => {
    const { edges } = buildCanvasGraph(makePayload())
    expect(edges[0]?.type).toBe('destination')
    expect(edges[0]?.animated).toBe(true)
  })

  it('assigns a palette color + arrow marker to every edge', () => {
    const { edges } = buildCanvasGraph(makePayload())
    for (const edge of edges) {
      expect(typeof (edge.data as { color?: string }).color).toBe('string')
      expect((edge.data as { color?: string }).color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(edge.markerEnd).toBeDefined()
    }
  })

  it('paints invalid edges red and dashed regardless of palette slot', () => {
    const { edges } = buildCanvasGraph(makePayload())
    const invalid = edges.find((e) => e.id === 'e-real-invalid')
    expect((invalid?.data as { color?: string }).color).toBe(INVALID_EDGE_COLOR)
    expect((invalid?.data as { dashed?: boolean }).dashed).toBe(true)
    expect(invalid?.animated).toBe(false)
  })

  it('dashes reply-keyboard edges but keeps them palette-colored', () => {
    const { edges } = buildCanvasGraph(makePayload())
    const reply = edges.find((e) => e.id === 'e-reply')
    expect((reply?.data as { dashed?: boolean }).dashed).toBe(true)
    expect((reply?.data as { color?: string }).color).not.toBe(INVALID_EDGE_COLOR)
  })

  it('keeps a plain valid edge solid', () => {
    const { edges } = buildCanvasGraph(makePayload())
    const real = edges.find((e) => e.id === 'e-real')
    expect((real?.data as { dashed?: boolean }).dashed).toBe(false)
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

describe('pickEdgeColor', () => {
  it('wraps around the palette and never throws', () => {
    const first = pickEdgeColor(0)
    expect(first).toMatch(/^#[0-9a-f]{6}$/i)
    // wraps: index 8 (palette length) returns the same as index 0
    expect(pickEdgeColor(8)).toBe(first)
    expect(pickEdgeColor(16)).toBe(first)
  })

  it('gives adjacent indices distinct colors', () => {
    expect(pickEdgeColor(0)).not.toBe(pickEdgeColor(1))
  })
})
