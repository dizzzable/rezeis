import { describe, expect, it } from 'vitest'

import { groupNodes } from './group-nodes'
import type { BotMapNode } from '../types'

const SAMPLE: ReadonlyArray<BotMapNode> = [
  {
    id: 'screen-a',
    kind: 'graph-screen',
    title: 'apple',
    group: 'graph',
    status: 'DRAFT',
    shortId: 'sc_a',
    isRoot: false,
    textRu: '',
    textEn: '',
    buttonCount: 0,
    bannerUrl: null,
  },
  {
    id: 'screen-root',
    kind: 'graph-screen',
    title: 'zeta',
    group: 'graph',
    status: 'DRAFT',
    shortId: 'sc_z',
    isRoot: true,
    textRu: '',
    textEn: '',
    buttonCount: 0,
    bannerUrl: null,
  },
  {
    id: 'mini-app:/renew',
    kind: 'mini-app-terminal',
    title: 'Продление',
    group: 'terminal',
    route: '/renew',
    descriptionRu: '',
    descriptionEn: '',
  },
  {
    id: 'notif:partner.earning',
    kind: 'notification',
    title: 'Партнёрский баланс',
    group: 'notification:partner',
    status: 'ACTIVE',
    templateId: 'tpl-2',
    type: 'partner.earning',
    category: 'partner',
    titleRu: 'Партнёрский баланс',
    titleEn: null,
    bodyRu: '',
    bodyEn: null,
    bannerUrl: null,
    buttons: [],
    isActive: true,
  },
  {
    id: 'notif:expires_in_3_days',
    kind: 'notification',
    title: 'Подписка истекает',
    group: 'notification:expires',
    status: 'ACTIVE',
    templateId: 'tpl-1',
    type: 'expires_in_3_days',
    category: 'expires',
    titleRu: 'Подписка истекает',
    titleEn: null,
    bodyRu: '',
    bodyEn: null,
    bannerUrl: null,
    buttons: [],
    isActive: true,
  },
]

describe('groupNodes', () => {
  it('emits groups in the canonical order', () => {
    const groups = groupNodes(SAMPLE)
    expect(groups.map((g) => g.key)).toEqual([
      'graph',
      'notification:expires',
      'notification:partner',
      'terminal',
    ])
  })

  it('puts root graph screens first inside the graph group', () => {
    const groups = groupNodes(SAMPLE)
    const graphGroup = groups.find((g) => g.key === 'graph')!
    expect(graphGroup.nodes.map((n) => n.id)).toEqual(['screen-root', 'screen-a'])
  })

  it('sorts non-root nodes alphabetically by title within their group', () => {
    const groups = groupNodes([
      { ...SAMPLE[0], id: 'g1', title: 'zebra' } as BotMapNode,
      { ...SAMPLE[0], id: 'g2', title: 'aardvark' } as BotMapNode,
    ])
    const graphGroup = groups.find((g) => g.key === 'graph')!
    expect(graphGroup.nodes.map((n) => n.id)).toEqual(['g2', 'g1'])
  })
})
