import { describe, expect, it } from 'vitest'

import { filterNodesByQuery } from './filter-nodes-by-query'
import type { BotMapNode } from '../types'

const NODES: ReadonlyArray<BotMapNode> = [
  {
    id: 'screen-help',
    kind: 'graph-screen',
    title: 'help',
    group: 'graph',
    status: 'PUBLISHED',
    shortId: 'sc_help',
    isRoot: false,
    textRu: 'Поддержка',
    textEn: 'Support',
    buttonCount: 2,
  },
  {
    id: '__reply_keyboard__',
    kind: 'reply-keyboard',
    title: 'Reply',
    group: 'reply',
    buttons: [
      {
        id: 'btn-1',
        buttonId: 'cabinet',
        label: 'Кабинет',
        visible: true,
        actionType: 'url',
        actionTarget: null,
      },
    ],
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
    titleEn: 'Expires soon',
    bodyRu: 'Срок действия истекает',
    bodyEn: null,
    bannerUrl: null,
    buttons: [],
    isActive: true,
  },
  {
    id: 'mini-app:/renew',
    kind: 'mini-app-terminal',
    title: 'Продление',
    group: 'terminal',
    route: '/renew',
    descriptionRu: 'Страница продления',
    descriptionEn: 'Renewal page',
  },
]

describe('filterNodesByQuery', () => {
  it('returns the input unchanged for empty / whitespace queries', () => {
    expect(filterNodesByQuery(NODES, '')).toBe(NODES)
    expect(filterNodesByQuery(NODES, '   ')).toBe(NODES)
  })

  it('matches by title', () => {
    expect(filterNodesByQuery(NODES, 'help').map((n) => n.id)).toEqual(['screen-help'])
  })

  it('matches by graph-screen shortId and copy', () => {
    expect(filterNodesByQuery(NODES, 'sc_help').map((n) => n.id)).toEqual(['screen-help'])
    expect(filterNodesByQuery(NODES, 'support').map((n) => n.id)).toEqual(['screen-help'])
    expect(filterNodesByQuery(NODES, 'поддерж').map((n) => n.id)).toEqual(['screen-help'])
  })

  it('matches a reply button by buttonId or label', () => {
    expect(filterNodesByQuery(NODES, 'cabinet').map((n) => n.id)).toEqual([
      '__reply_keyboard__',
    ])
    expect(filterNodesByQuery(NODES, 'каби').map((n) => n.id)).toEqual([
      '__reply_keyboard__',
    ])
  })

  it('matches a notification by type and copy', () => {
    expect(filterNodesByQuery(NODES, 'expires_in_3').map((n) => n.id)).toEqual([
      'notif:expires_in_3_days',
    ])
    expect(filterNodesByQuery(NODES, 'expires soon').map((n) => n.id)).toEqual([
      'notif:expires_in_3_days',
    ])
  })

  it('matches a Mini App terminal by route or description', () => {
    expect(filterNodesByQuery(NODES, '/renew').map((n) => n.id)).toEqual(['mini-app:/renew'])
    expect(filterNodesByQuery(NODES, 'renewal').map((n) => n.id)).toEqual(['mini-app:/renew'])
  })

  it('is case-insensitive', () => {
    expect(filterNodesByQuery(NODES, 'HELP').map((n) => n.id)).toEqual(['screen-help'])
    expect(filterNodesByQuery(NODES, 'sc_HELP').map((n) => n.id)).toEqual(['screen-help'])
  })

  it('returns an empty array for a no-match query', () => {
    expect(filterNodesByQuery(NODES, 'xyzdoesnotmatch')).toEqual([])
  })
})
