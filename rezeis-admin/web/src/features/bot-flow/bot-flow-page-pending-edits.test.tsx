/**
 * «Опубликовать» and «Сохранить позиции» after typing in the inspector.
 *
 * A screen's link is saved when its box is left (since 24.09.2026; it was
 * saved on every keystroke before). Clicking «Опубликовать» straight after
 * typing sent the blur's save and the publish together, ~100 ms apart: the
 * publish could snapshot the draft before the save landed, and the published
 * flow went out without the link while the draft had it. Safari and iOS give
 * no blur at all on a button click, so there the link was not saved even
 * then. The page now saves everything typed and waits for every save in
 * flight before it publishes or saves (`pending-edits.ts`), and asks before
 * the page is left while anything is unsaved.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

import type { BotMapPayload } from '@/features/bot-map/types'
import BotFlowPage from './bot-flow-page'
import type { BotFlow } from './types'

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
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Bottom: 'bottom', Left: 'left', Right: 'right', Top: 'top' },
    addEdge: (edge: unknown, edges: readonly unknown[]) => [...edges, edge],
    applyEdgeChanges: (_changes: unknown, edges: unknown[]) => edges,
    applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes,
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const PUBLISH = '/admin/bot-flows/flow-1/publish'

function flowFixture(): BotFlow {
  return {
    id: 'flow-1',
    name: 'Main Flow',
    version: 1,
    status: 'DRAFT',
    layoutData: null,
    publishedAt: null,
    screens: [
      {
        id: 'screen-1',
        shortId: 'A1',
        flowId: 'flow-1',
        name: 'Акция',
        textRu: 'Привет',
        textEn: 'Hello',
        parseMode: 'HTML',
        mediaType: null,
        mediaFileId: null,
        mediaUrl: null,
        positionX: 0,
        positionY: 0,
        isRoot: true,
        buttons: [
          {
            id: 'button-1',
            screenId: 'screen-1',
            labelRu: 'Сайт',
            labelEn: 'Site',
            row: 0,
            col: 0,
            actionType: 'URL',
            targetScreenId: null,
            url: null,
            webAppUrl: null,
            callbackAction: null,
            style: 'DEFAULT',
            iconCustomEmojiId: null,
          },
        ],
      },
    ],
  }
}

function botMapFixture(): BotMapPayload {
  return {
    nodes: [
      {
        id: 'screen-1',
        kind: 'graph-screen',
        title: 'Акция',
        group: 'graph',
        status: 'DRAFT',
        shortId: 'A1',
        isRoot: true,
        textRu: 'Привет',
        textEn: 'Hello',
        buttonCount: 1,
        bannerUrl: null,
      },
    ],
    edges: [],
    miniAppScreens: [],
    meta: { flowStatus: 'DRAFT', composedAt: '2026-09-24T00:00:00.000Z' },
  }
}

/** Every request the page sent, in order: `put <path>`, `post <path>`. */
function wire(options: { readonly put?: () => Promise<unknown> } = {}): string[] {
  const sent: string[] = []
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-flows/draft/Main%20Flow') return { data: flowFixture() }
    if (path === '/admin/bot-map') return { data: botMapFixture() }
    if (path === '/admin/bot-config/buttons') return { data: [] }
    if (path === '/admin/bot-config/texts') return { data: [] }
    return { data: {} }
  })
  vi.spyOn(api, 'put').mockImplementation(async (path: string, body?: unknown) => {
    sent.push(`put ${path} ${JSON.stringify(body)}`)
    if (path.startsWith('/admin/bot-flows/buttons/') && options.put !== undefined) await options.put()
    return { data: {} }
  })
  vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    sent.push(`post ${path}`)
    return { data: {} }
  })
  return sent
}

async function openScreenEditor(): Promise<HTMLElement> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Акция' }))
  return screen.findByRole('textbox', { name: i18n.t('botFlow.button.url') })
}

const publishButton = () => screen.getByRole('button', { name: i18n.t('botStudio.toolbar.publishFlow') })

describe('«Опубликовать» right after typing a link', () => {
  it('publishes only once the save the click’s blur started has landed', async () => {
    let land: () => void = () => undefined
    const saving = new Promise<void>((resolve) => {
      land = resolve
    })
    const sent = wire({ put: () => saving })
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)
    const box = await openScreenEditor()
    await user.type(box, 'https://example.com/a')
    // The click moves the focus: the blur starts the save, then the publish is asked.
    await user.click(publishButton())
    await waitFor(() => expect(sent).toContain('put /admin/bot-flows/buttons/button-1 {"url":"https://example.com/a"}'))
    expect(sent).not.toContain(`post ${PUBLISH}`)

    await act(async () => {
      land()
      await saving
    })
    await waitFor(() => expect(sent).toContain(`post ${PUBLISH}`))
    expect(sent.indexOf(`post ${PUBLISH}`)).toBeGreaterThan(
      sent.indexOf('put /admin/bot-flows/buttons/button-1 {"url":"https://example.com/a"}'),
    )
  })

  it('saves a link typed and never left — Safari gives the button no focus — before it publishes', async () => {
    const sent = wire()
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)
    const box = await openScreenEditor()
    await user.type(box, 'https://example.com/a')
    expect(box).toHaveFocus()
    // A click that moves no focus: no blur, no save from it.
    fireEvent.click(publishButton())
    await waitFor(() => expect(sent).toContain(`post ${PUBLISH}`))
    expect(sent).toEqual([
      'put /admin/bot-flows/buttons/button-1 {"url":"https://example.com/a"}',
      `post ${PUBLISH}`,
    ])
  })

  it('saves a typed link before «Сохранить позиции» too', async () => {
    const sent = wire()
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)
    const box = await openScreenEditor()
    await user.type(box, 'https://example.com/a')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('botStudio.toolbar.savePositions') }))
    await waitFor(() => expect(sent.some((line) => line.startsWith('put /admin/bot-flows/screens/positions'))).toBe(true))
    expect(sent[0]).toBe('put /admin/bot-flows/buttons/button-1 {"url":"https://example.com/a"}')
  })

  it('asks before the tab is reloaded or closed while a typed link is not saved, and not once it is', async () => {
    wire()
    const user = userEvent.setup()
    renderWithProviders(<BotFlowPage />)
    const box = await openScreenEditor()
    const leave = (): boolean => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(leave()).toBe(false)
    await user.type(box, 'https://example.com/a')
    await waitFor(() => expect(leave()).toBe(true))
    await user.tab()
    await waitFor(() => expect(leave()).toBe(false))
  })
})
