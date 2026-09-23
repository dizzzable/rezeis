import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import BotFlowPage from './bot-flow-page'
import type { BotFlow, BotFlowScreen } from './types'

// What the route loads with the page: part of its words live in it.
beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

vi.mock('@xyflow/react', async () => {
  const React = await import('react')

  return {
    ReactFlowProvider: ({ children }: { readonly children?: import('react').ReactNode }) =>
      React.createElement('div', null, children),
    ReactFlow: ({ children }: { readonly children?: import('react').ReactNode }) =>
      React.createElement('div', { 'data-testid': 'flow-canvas' }, children),
    Background: () => React.createElement('div', { 'data-testid': 'flow-background' }),
    Controls: () => React.createElement('div', { 'data-testid': 'flow-controls' }),
    MiniMap: () => React.createElement('div', { 'data-testid': 'flow-minimap' }),
    Handle: () => React.createElement('span', { 'data-testid': 'flow-handle' }),
    Position: {
      Bottom: 'bottom',
      Left: 'left',
      Right: 'right',
      Top: 'top',
    },
    addEdge: (edge: unknown, edges: readonly unknown[]) => [...edges, edge],
    applyEdgeChanges: (_changes: unknown, edges: unknown[]) => edges,
    applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
  }
})

describe('BotFlowPage accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('makes the new-screen palette item keyboard-operable and named', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/bot-flows/draft/Main%20Flow') return { data: flowFixture() }
      if (path === '/admin/bot-config/buttons') return { data: [] }
      if (path === '/admin/bot-config/texts') return { data: [] }
      return { data: {} }
    })
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: screenFixture() })

    renderWithProviders(<BotFlowPage />)

    const createButton = await screen.findByRole('button', { name: 'Create bot screen' })
    expect(createButton).toHaveAttribute('draggable', 'true')

    createButton.focus()
    expect(createButton).toHaveFocus()
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/admin/bot-flows/screens', {
        flowId: 'flow-1',
        positionX: 120,
        positionY: 120,
        isRoot: true,
      })
    })
  })
})

function flowFixture(): BotFlow {
  return {
    id: 'flow-1',
    name: 'Main Flow',
    version: 1,
    status: 'DRAFT',
    layoutData: null,
    publishedAt: null,
    screens: [],
  }
}

function screenFixture(): BotFlowScreen {
  return {
    id: 'screen-1',
    shortId: 'A1',
    flowId: 'flow-1',
    name: 'screen-1',
    textRu: '',
    textEn: '',
    parseMode: 'HTML',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    positionX: 120,
    positionY: 120,
    isRoot: true,
    buttons: [],
  }
}
