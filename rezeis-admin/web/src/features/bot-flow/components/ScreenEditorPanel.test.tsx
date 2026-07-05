import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import { ScreenEditorPanel } from './ScreenEditorPanel'
import type { BotFlowScreen } from '../types'

describe('ScreenEditorPanel accessibility', () => {
  it('makes the banner upload control keyboard-operable and named', () => {
    renderWithProviders(<ScreenEditorPanel screen={screenFixture()} flowName="default" />)

    expect(screen.getByRole('button', { name: 'Choose screen banner' })).toBeInTheDocument()
    expect(screen.getByLabelText('Choose screen banner', { selector: 'input' })).toBeInTheDocument()
  })

  it('names the icon-only banner remove action', () => {
    renderWithProviders(
      <ScreenEditorPanel
        screen={screenFixture({ mediaType: 'PHOTO', mediaUrl: 'https://cdn.example.com/screen.png' })}
        flowName="default"
      />,
    )

    expect(screen.getByRole('button', { name: 'Remove screen banner' })).toBeInTheDocument()
  })

  it('names compact button editor controls', () => {
    renderWithProviders(
      <ScreenEditorPanel
        screen={screenFixture({ buttons: [buttonFixture()] })}
        flowName="default"
      />,
    )

    expect(screen.getByRole('spinbutton', { name: 'Row' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Pos' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Action' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Style' })).toBeInTheDocument()
  })
})

function buttonFixture(): BotFlowScreen['buttons'][number] {
  return {
    id: 'button-1',
    screenId: 'screen-1',
    labelRu: 'Кнопка',
    labelEn: 'Button',
    row: 0,
    col: 0,
    actionType: 'NAVIGATE',
    targetScreenId: null,
    url: null,
    webAppUrl: null,
    callbackAction: null,
    style: 'DEFAULT',
    iconCustomEmojiId: null,
  }
}

function screenFixture(overrides: Partial<BotFlowScreen> = {}): BotFlowScreen {
  return {
    id: 'screen-1',
    shortId: 'A1',
    flowId: 'flow-1',
    name: 'start',
    textRu: 'Privet',
    textEn: 'Hello',
    parseMode: 'HTML',
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    positionX: 0,
    positionY: 0,
    isRoot: true,
    buttons: [],
    ...overrides,
  }
}
