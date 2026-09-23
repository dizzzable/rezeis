/**
 * A main-menu button's address, as its forms take it.
 *
 * The server refused every «Внешняя ссылка» or «Mini App» target that did not
 * start with `http(s)://` — the page the Mini App page picker saves
 * (`/referrals`) among them — and the forms found out only after the request:
 * «Кнопки бота» showed the server's English sentence, the main-menu
 * constructor only «не удалось обновить». The server now takes a page of the
 * cabinet and refuses what the bot cannot open (`menuButtonTargetProblem`,
 * the same function in both builds); the forms say which before sending, keep
 * the button from being saved, and still show the server's own reason when it
 * refuses anyway.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { en } from '@/i18n/en'
import { i18n } from '@/i18n/i18n'
import { ru } from '@/i18n/ru'
import { emojiStudioPayload, packsPayload } from '@/features/custom-emoji/emoji-catalog.fixtures'
import { valueAt } from '@/test/i18n-key-paths'
import { renderWithProviders } from '@/test/test-utils'

import { ActionFields, BotButtonCreateDialog, BotButtonEditDialog } from './bot-button-dialogs'
import type { BotButton, BotButtonAction } from './bot-config-api'
import { ReplyKeyboardEditorPanel } from './reply-keyboard-editor-panel'

afterEach(() => {
  vi.restoreAllMocks()
})

const t = (key: string) => String(i18n.t(key))
const problem = (name: string) => t(`botConfigPage.buttons.fields.actionTarget.problems.${name}`)

function botButton(overrides: Partial<BotButton>): BotButton {
  return {
    id: 'button-1',
    buttonId: 'plans',
    label: 'Тарифы',
    style: 'DEFAULT',
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: false,
    orderIndex: 0,
    actionType: 'URL',
    actionTarget: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

function mockApi(buttons: readonly BotButton[] = []): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/buttons') return { data: buttons }
    if (path === '/admin/custom-emoji/packs') return packsPayload([])
    if (path === '/admin/bot-config/emoji-studio') return emojiStudioPayload()
    return { data: [] }
  })
}

describe('a main-menu button’s address in its form', () => {
  it('has the words for every reason, in both languages', () => {
    // A key missing from a dictionary renders as its own path — and would match the tests below.
    for (const dictionary of [ru, en]) {
      for (const reason of ['notAPage', 'badCharacters', 'notAnAddress', 'webAppNeedsHttps', 'upperCaseScheme', 'localAddress']) {
        const key = `botConfigPage.buttons.fields.actionTarget.problems.${reason}`
        expect(typeof valueAt(dictionary, key), key).toBe('string')
      }
    }
  })

  it.each([
    ['URL', 'plans', 'notAPage'],
    ['URL', '//evil.example', 'notAPage'],
    ['URL', '/pl ans', 'badCharacters'],
    ['URL', `/pro${String.fromCodePoint(0x200b)}mo`, 'badCharacters'],
    ['URL', 'https://exa mple.com', 'notAnAddress'],
    ['WEBAPP', 'https://', 'notAnAddress'],
    ['WEBAPP', 'http://example.com/app', 'webAppNeedsHttps'],
    // What a phone's auto-capital makes of it: reiwa leaves such a Mini App out.
    ['WEBAPP', 'Https://example.com/app', 'upperCaseScheme'],
    ['URL', 'https://localhost:5173/', 'localAddress'],
  ] as const)('%s %s: says why it cannot be saved (%s)', (actionType: BotButtonAction, target, reason) => {
    mockApi()
    renderWithProviders(
      <ActionFields
        idPrefix="t"
        actionType={actionType}
        actionTarget={target}
        onActionTypeChange={vi.fn()}
        onActionTargetChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(problem(reason))
  })

  it.each([
    ['URL', '/plans'],
    ['URL', 'http://example.com/a'],
    ['WEBAPP', '/referrals'],
    ['WEBAPP', '/promo?code=SALE'],
    ['URL', 'HTTPS://example.com/a'],
    // Local only by its host: a mention of one in the query is not.
    ['URL', 'https://example.com/?next=http://localhost/x'],
    ['URL', ''],
  ] as const)('%s %s: says nothing against it', (actionType: BotButtonAction, target) => {
    mockApi()
    renderWithProviders(
      <ActionFields
        idPrefix="t"
        actionType={actionType}
        actionTarget={target}
        onActionTypeChange={vi.fn()}
        onActionTargetChange={vi.fn()}
      />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('«Кнопки бота», edit: keeps «Сохранить» off until the address is one the bot can open, then saves the page', async () => {
    mockApi()
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: botButton({ actionTarget: '/plans' }) })
    const user = userEvent.setup()
    renderWithProviders(
      <BotButtonEditDialog button={botButton({ actionTarget: 'plans' })} open onOpenChange={() => undefined} />,
    )

    const save = screen.getByRole('button', { name: t('botConfigPage.buttons.save') })
    expect(save).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(problem('notAPage'))

    const target = screen.getByLabelText(t('botConfigPage.buttons.fields.actionTarget.label'))
    await user.clear(target)
    await user.type(target, '/plans')
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(save)

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/admin/bot-config/buttons/button-1',
        expect.objectContaining({ actionType: 'URL', actionTarget: '/plans' }),
      ),
    )
  })

  it('«Кнопки бота», create: will not create a button with an address the bot cannot open', async () => {
    mockApi()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: botButton({ actionTarget: '/plans' }) })
    const user = userEvent.setup()
    renderWithProviders(<BotButtonCreateDialog open onOpenChange={() => undefined} />)

    await user.type(screen.getByLabelText(t('botConfigPage.buttons.fields.buttonId')), 'plans')
    await user.type(screen.getByLabelText(t('botConfigPage.buttons.fields.label')), 'Тарифы')
    await user.click(screen.getByRole('combobox', { name: t('botConfigPage.buttons.fields.actionType.label') }))
    await user.click(await screen.findByRole('option', { name: t('botConfigPage.buttons.fields.actionType.options.URL') }))
    const target = screen.getByLabelText(t('botConfigPage.buttons.fields.actionTarget.label'))
    await user.type(target, 'plans')

    const create = screen.getByRole('button', { name: t('botConfigPage.buttons.create') })
    expect(create).toBeDisabled()
    await user.clear(target)
    await user.type(target, '/plans')
    expect(create).toBeEnabled()
    await user.click(create)

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/admin/bot-config/buttons',
        expect.objectContaining({ buttonId: 'plans', actionType: 'URL', actionTarget: '/plans' }),
      ),
    )
  })

  it('the main-menu constructor: keeps «Сохранить» off for a local address, and shows the server’s reason when it refuses', async () => {
    mockApi([botButton({ actionTarget: 'https://localhost:5173/' })])
    const reason = 'actionTarget must not point at localhost or 127.0.0.1: Telegram refuses such an address'
    vi.spyOn(api, 'patch').mockRejectedValue({ response: { status: 400, data: { message: reason } } })
    const failed = vi.spyOn(toast, 'error')
    const user = userEvent.setup()
    renderWithProviders(<ReplyKeyboardEditorPanel />)

    const caption = await screen.findByDisplayValue('Тарифы')
    await user.type(caption, '!')
    const save = screen.getByRole('button', { name: t('botConfigPage.buttons.save') })
    expect(save).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(problem('localAddress'))

    // An address the form takes, refused by the server all the same.
    const target = screen.getByDisplayValue('https://localhost:5173/')
    await user.clear(target)
    await user.type(target, 'https://example.com/plans')
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => expect(failed).toHaveBeenCalledWith(reason))
  })
})
