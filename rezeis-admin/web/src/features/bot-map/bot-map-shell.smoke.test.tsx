import { beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import { BotMapShell } from './components/BotMapShell'
import type { BotMapPayload } from './types'

const PAYLOAD: BotMapPayload = {
  nodes: [
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
      buttonCount: 0,
      bannerUrl: null,
    },
    {
      id: '__reply_keyboard__',
      kind: 'reply-keyboard',
      title: 'Reply',
      group: 'reply',
      buttons: [],
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
  ],
  edges: [],
  meta: { flowStatus: 'PUBLISHED', composedAt: new Date().toISOString() },
}

describe('BotMapShell', () => {
  beforeAll(async () => {
    await loadFeatureBundle('botMap')
  })

  it('renders the page title and the visible nodes from the payload', () => {
    renderWithProviders(
      <BotMapShell
        payload={PAYLOAD}
        isFetching={false}
        onRefresh={() => undefined}
      />,
    )

    // Title is keyed by the bundle that was just loaded — exact text varies
    // by active locale (EN by default in tests, but production traffic is
    // RU-first), so accept either rendering.
    expect(
      screen.getByRole('heading', { name: /Карта бота|Bot map/i }),
    ).toBeInTheDocument()
    // List view shows every node card title (also rendered in the rail,
    // so multiple matches are expected — assert presence rather than uniqueness).
    expect(screen.getAllByText('help').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Reply').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Продление').length).toBeGreaterThan(0)
  })
})
