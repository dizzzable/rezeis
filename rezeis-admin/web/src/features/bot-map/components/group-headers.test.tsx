import { beforeAll, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import type { BotMapNode, BotMapPayload } from '../types'
import { ListView } from './ListView'
import { NodeRail } from './NodeRail'

/**
 * The group headers of «Карта бота», in the rail and in the list.
 *
 * The notification groups are keyed `notification:expires`,
 * `notification:referral`, … and i18next reads a ':' as the boundary between a
 * namespace and a key — so `botMapPage.rail.groups.notification:expires` was
 * looked up in a namespace called `botMapPage.rail.groups.notification` that
 * does not exist, and the header showed its own raw key. Both components now
 * look the key up with `nsSeparator: false`.
 */

const EXPIRY_NODE: BotMapNode = {
  id: 'notif:expires_in_3_days',
  kind: 'notification',
  title: 'expires_in_3_days',
  group: 'notification:expires',
  templateId: 'tpl-expires-3',
  type: 'expires_in_3_days',
  category: 'expires',
  titleRu: 'Подписка истекает',
  titleEn: null,
  bodyRu: 'Срок действия истекает',
  bodyEn: null,
  bannerUrl: null,
  buttons: [],
  isActive: true,
}

const PAYLOAD: BotMapPayload = {
  nodes: [EXPIRY_NODE],
  edges: [],
  meta: { flowStatus: 'PUBLISHED', composedAt: new Date().toISOString() },
}

/** The header the bundle has for the group — looked up the way the fix does, so a missing entry fails loudly. */
function header(group: string): string {
  const text = String(i18n.t(`botMapPage.rail.groups.${group}`, { nsSeparator: false }))
  expect(text, `the bundle has no header for ${group}`).not.toContain('botMapPage.')
  expect(text).not.toBe(group)
  return text
}

describe('«Карта бота» group headers', () => {
  beforeAll(async () => {
    await loadFeatureBundle('botMap')
  })

  it('shows the translated notification group in the rail, not its raw key', () => {
    renderWithProviders(
      <NodeRail
        nodes={[EXPIRY_NODE]}
        selectedId={null}
        onSelect={() => undefined}
        query=""
        onQueryChange={() => undefined}
      />,
    )

    expect(screen.getByText(header('notification:expires'))).toBeInTheDocument()
    expect(screen.queryByText('notification:expires')).not.toBeInTheDocument()
  })

  it('shows the translated notification group in the list, not its raw key', () => {
    renderWithProviders(
      <ListView payload={PAYLOAD} visibleNodes={[EXPIRY_NODE]} selectedId={null} onSelect={() => undefined} />,
    )

    expect(screen.getByRole('heading', { name: header('notification:expires') })).toBeInTheDocument()
    expect(screen.queryByText('notification:expires')).not.toBeInTheDocument()
  })
})
