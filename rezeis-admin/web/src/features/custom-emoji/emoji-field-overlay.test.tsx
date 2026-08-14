/**
 * The field itself must show the emoji — and must not start lying to do it.
 *
 * The operator inserts a custom emoji and the field answers
 * `:tg_ios_macos_icons_25:`, so they cannot see what they are writing. The
 * layer over the field fixes that, and every one of these specs guards a way
 * it could go wrong instead:
 *
 *   • a known token must be the pack picture, not the shortcode;
 *   • a token no pack defines must stay readable text — that IS what is sent;
 *   • a BUTTON caption's leading token must appear as the button's separate
 *     icon, because reiwa moves it to `icon_custom_emoji_id` and Telegram
 *     draws it before the caption, not inside it;
 *   • and the value that leaves for the server after an edit must be the same
 *     token text the operator typed. The last one is the important one: it is
 *     what stops a rendering from leaking into the data.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import {
  EMOJI_TIMESTAMP,
  LIVE_EMOJI,
  emojiStudioPayload,
  packsPayload,
  type PackEmojiFixture,
} from './emoji-catalog.fixtures'
import { useEmojiCatalog } from './emoji-catalog'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { BotTextsTab } from '@/features/bot-config/bot-texts-tab'
import { BotButtonEditDialog } from '@/features/bot-config/bot-button-dialogs'
import type { BotButton } from '@/features/bot-config/bot-config-api'
import BroadcastPage from '@/features/broadcast/broadcast-page'
import { EmojiTextInput } from '@/features/broadcast/emoji-text-input'
import { ReplyKeyboardEditorPanel } from '@/features/bot-config/reply-keyboard-editor-panel'
import { LocaleTextarea } from '@/features/bot-map/components/inspector/LocaleTextarea'
import { NotificationEditor } from '@/features/bot-map/components/inspector/NotificationEditor'
import type { NotificationMapNode } from '@/features/bot-map/types'
import NotificationsPage from '@/features/notifications/notifications-page'

// Catalog fixtures are shared with the bot-flow and copy-preview suites — see
// `./emoji-catalog.fixtures`. Local aliases keep the specs below reading the
// way they were written.
const TIMESTAMP = EMOJI_TIMESTAMP
const LIVE = LIVE_EMOJI

function mockApi(texts: readonly string[], emojis: readonly PackEmojiFixture[]): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/texts') {
      return {
        data: texts.map((value, index) => ({
          id: `text-${index + 1}`,
          key: 'menu.channel',
          value,
          visible: true,
          valueEn: null,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        })),
      }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload(emojis)
    if (path === '/admin/bot-config/emoji-studio') {
      return { data: { slots: [], ownerHasPremium: true } }
    }
    return { data: [] }
  })
}

function botButton(label: string): BotButton {
  return {
    id: 'button-1',
    buttonId: 'channel',
    label,
    style: 'DEFAULT',
    iconCustomEmojiId: null,
    visible: true,
    onePerRow: false,
    orderIndex: 0,
    actionType: 'CALLBACK',
    actionTarget: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  }
}

/**
 * A dialog autofocuses its first field, and the layer steps aside for a
 * focused field on purpose — the caret belongs to the field, so nothing may
 * cover it while it is being used. Moving focus off is what an operator does
 * by looking at the value instead of typing into it.
 */
async function leaveField(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('dialog'))
}

/**
 * The broadcast screens read the same shared catalog every other field reads,
 * plus their own draft list and one draft's detail. Anything unrecognised
 * answers an empty array so the page still mounts with the fetches this spec
 * does not care about.
 */
async function mockBroadcastApi(
  detailText: string | null,
  emojis: readonly PackEmojiFixture[],
): Promise<void> {
  // `broadcastPage.*` ships as a lazy feature bundle, so the copy this spec
  // clicks on only exists once that bundle is in.
  await loadFeatureBundle('broadcast')
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/broadcast/drafts') {
      return {
        data: [
          {
            id: 'bc-1',
            audience: 'ALL',
            status: 'COMPLETED',
            successCount: 1,
            totalCount: 1,
            failedCount: 0,
            createdAt: TIMESTAMP,
          },
        ],
      }
    }
    if (path === '/admin/broadcast/bc-1') {
      return { data: { id: 'bc-1', payload: { text: detailText, parseMode: null } } }
    }
    if (path === '/admin/custom-emoji/packs') return packsPayload(emojis)
    if (path === '/admin/bot-config/emoji-studio') {
      return { data: { slots: [], ownerHasPremium: true } }
    }
    return { data: [] }
  })
}

/** One reply-keyboard button, plus the shared catalog the caption draws from. */
function mockReplyKeyboardApi(label: string, emojis: readonly PackEmojiFixture[]): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/bot-config/buttons') return { data: [botButton(label)] }
    if (path === '/admin/custom-emoji/packs') return packsPayload(emojis)
    if (path === '/admin/bot-config/emoji-studio') {
      return { data: { slots: [], ownerHasPremium: true } }
    }
    return { data: [] }
  })
}

describe('a copy field draws its emoji', () => {
  it('shows the pack picture in the field instead of the shortcode', async () => {
    mockApi([':tg_ios_macos_icons_25: Go to channel'], [LIVE])
    renderWithProviders(<BotTextsTab />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await leaveField(user)

    const field = await screen.findByTestId('emoji-field-overlay')
    expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
      'src',
      '/uploads/emoji/tg_ios_macos_icons_25.webp',
    )
    // The words around the token are untouched; only the token is drawn.
    expect(field).toHaveTextContent('Go to channel')
    expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })

  it('leaves a shortcode no pack defines readable, and marks it', async () => {
    mockApi([':tg_ios_macos_icons_52: Go to channel'], [LIVE])
    renderWithProviders(<BotTextsTab />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await leaveField(user)

    const field = await screen.findByTestId('emoji-field-overlay')
    expect(within(field).queryByRole('img')).not.toBeInTheDocument()
    expect(
      within(field).getByTitle(':tg_ios_macos_icons_52: → unknown shortcode, sent as raw text'),
    ).toHaveTextContent(':tg_ios_macos_icons_52:')
  })
})

describe('a button caption draws its leading token where the button puts it', () => {
  it('shows the leading shortcode as the button icon, not inside the caption', async () => {
    mockApi([], [LIVE])
    renderWithProviders(
      <BotButtonEditDialog
        button={botButton(':tg_ios_macos_icons_25: Go to channel')}
        open
        onOpenChange={() => {}}
      />,
    )
    const user = userEvent.setup()
    await leaveField(user)

    // Drawn once, on its own, labelled as the button's icon.
    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
      'src',
      '/uploads/emoji/tg_ios_macos_icons_25.webp',
    )
    expect(screen.getByText('Button icon — not part of the caption')).toBeInTheDocument()

    const field = await screen.findByTestId('emoji-field-overlay')
    // …and NOT inside the caption: neither as a picture nor as its glyph.
    expect(within(field).queryByAltText(':tg_ios_macos_icons_25:')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('Go to channel')
    expect(field.textContent).not.toContain('📣')
    expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })

  it('draws a non-leading token as the glyph a caption can actually carry', async () => {
    mockApi([], [LIVE])
    renderWithProviders(
      <BotButtonEditDialog
        button={botButton('Go to channel :tg_ios_macos_icons_25:')}
        open
        onOpenChange={() => {}}
      />,
    )
    const user = userEvent.setup()
    await leaveField(user)

    const field = await screen.findByTestId('emoji-field-overlay')
    expect(within(field).queryByRole('img')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('Go to channel 📣')
    expect(screen.queryByText('Button icon — not part of the caption')).not.toBeInTheDocument()
  })
})

describe('the rendering never reaches the server', () => {
  it('saves the same token text the operator typed, not the drawn form', async () => {
    mockApi([':tg_ios_macos_icons_25: Go to channel'], [LIVE])
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({
      data: {
        id: 'text-1',
        key: 'menu.channel',
        value: ':tg_ios_macos_icons_25: Go to channel!',
        visible: true,
        valueEn: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    })

    renderWithProviders(<BotTextsTab />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await leaveField(user)

    // The field really is drawing the emoji before the edit…
    const field = await screen.findByTestId('emoji-field-overlay')
    expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()

    // …and the value it hands back is still the plain token string.
    const textarea = screen.getByLabelText('Value')
    await user.type(textarea, '!')
    expect(textarea).toHaveValue(':tg_ios_macos_icons_25: Go to channel!')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(patch).toHaveBeenCalledWith('/admin/bot-config/texts/text-1', {
      value: ':tg_ios_macos_icons_25: Go to channel!',
      visible: true,
      valueEn: null,
    })
  })
})

/**
 * The shared catalog every field reads, plus whatever else the screen under
 * test fetches (`routes`). Anything unlisted answers an empty list — the same
 * thing an unconfigured panel returns — so a screen still mounts when a fetch
 * this spec does not care about fires.
 */
function mockScreenApi(
  emojis: readonly PackEmojiFixture[],
  routes: Readonly<Record<string, unknown>> = {},
): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') return packsPayload(emojis)
    if (path === '/admin/bot-config/emoji-studio') {
      return { data: { slots: [], ownerHasPremium: true } }
    }
    if (Object.prototype.hasOwnProperty.call(routes, path)) return { data: routes[path] }
    return { data: [] }
  })
}

/**
 * `botMapPage.*` and `notificationsPage.*` ship as lazy feature bundles, so the
 * copy these specs click on only exists once the bundle is in. Pulled in here
 * rather than at the top of the file so this block stays self-contained.
 */
async function loadScreenCopy(feature: 'botMap' | 'notifications'): Promise<void> {
  const { loadFeatureBundle } = await import('@/i18n/i18n')
  await loadFeatureBundle(feature)
}

/**
 * A notification node whose COPY carries no token and whose BUTTON captions do
 * — the two go through different renderers, so keeping the copy plain leaves
 * exactly the captions to look at.
 */
function notificationNode(): NotificationMapNode {
  return {
    id: 'notification-1',
    kind: 'notification',
    title: 'Subscription expires',
    group: 'expires',
    status: 'ACTIVE',
    templateId: 'tpl-1',
    type: 'expires_in_3_days',
    category: 'expires',
    titleRu: 'Подписка истекает',
    titleEn: null,
    bodyRu: 'Осталось 3 дня',
    bodyEn: null,
    bannerUrl: null,
    buttons: [
      {
        labelRu: ':tg_ios_macos_icons_25: Renew',
        labelEn: 'Renew :tg_ios_macos_icons_25:',
        kind: 'webApp',
        target: '/renew',
        style: 'default',
        row: 0,
      },
    ],
    isActive: true,
  }
}

describe('the bot map draws both halves of a locale pair', () => {
  it('shows the pack picture in the RU and the EN copy alike', async () => {
    mockScreenApi([LIVE])
    renderWithProviders(
      <LocaleTextarea
        labelRu="Body (RU)"
        labelEn="Body (EN)"
        valueRu=":tg_ios_macos_icons_25: Go to channel"
        valueEn=":tg_ios_macos_icons_25: Go to channel"
        onSave={() => {}}
      />,
    )

    // Both copies, not just the one the operator happens to look at first.
    // The layer is up before the catalog lands (an unresolved token is drawn as
    // readable text meanwhile), so wait for the picture, not for the layer.
    expect(await screen.findAllByAltText(':tg_ios_macos_icons_25:')).toHaveLength(2)

    const fields = screen.getAllByTestId('emoji-field-overlay')
    expect(fields).toHaveLength(2)
    for (const field of fields) {
      expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
        'src',
        '/uploads/emoji/tg_ios_macos_icons_25.webp',
      )
      expect(field).toHaveTextContent('Go to channel')
      expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
    }
  })

  it('hands the edited copy back as token text, not as the drawn form', async () => {
    mockScreenApi([LIVE])
    const onSave = vi.fn()
    renderWithProviders(
      <LocaleTextarea
        labelRu="Body (RU)"
        labelEn="Body (EN)"
        valueRu=":tg_ios_macos_icons_25: Go to channel"
        valueEn=""
        onSave={onSave}
      />,
    )

    // The field really is drawing the emoji before the edit…
    await screen.findByAltText(':tg_ios_macos_icons_25:')
    const field = screen.getByTestId('emoji-field-overlay')
    expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()

    // …and what the blur-save hands upstream is still the plain token string.
    const user = userEvent.setup()
    const ru = screen.getByLabelText('Body (RU)')
    await user.type(ru, '!')
    expect(ru).toHaveValue(':tg_ios_macos_icons_25: Go to channel!')
    await user.tab()

    expect(onSave).toHaveBeenCalledWith({ ru: ':tg_ios_macos_icons_25: Go to channel!' })
  })
})

describe('a notification button caption is drawn the way the button ships it', () => {
  it('lifts a leading token into the button icon and keeps it out of the caption', async () => {
    await loadScreenCopy('botMap')
    mockScreenApi([LIVE])
    renderWithProviders(<NotificationEditor node={notificationNode()} />)

    // The leading token of the RU caption belongs to the button, not the text.
    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
      'src',
      '/uploads/emoji/tg_ios_macos_icons_25.webp',
    )
    // Exactly one caption promotes: the EN one carries its token in the middle.
    expect(screen.getAllByText('Button icon — not part of the caption')).toHaveLength(1)

    const [ruCaption, enCaption] = screen.getAllByTestId('emoji-field-overlay')
    expect(ruCaption).toHaveTextContent('Renew')
    expect(ruCaption.textContent).not.toContain('📣')
    expect(ruCaption.textContent).not.toContain(':tg_ios_macos_icons_25:')
    // A caption carries no entities, so a non-leading token is the glyph the
    // user reads — never the pack picture, which would be a new lie.
    expect(within(enCaption).queryByRole('img')).not.toBeInTheDocument()
    expect(enCaption).toHaveTextContent('Renew 📣')
  })

  it('saves the caption exactly as typed, leading token included', async () => {
    await loadScreenCopy('botMap')
    mockScreenApi([LIVE])
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    renderWithProviders(<NotificationEditor node={notificationNode()} />)
    const user = userEvent.setup()

    // Drawing before the edit…
    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()

    // …and the caption the button stores still starts with the token the
    // rendering lifted out of it.
    const ru = screen.getByDisplayValue(':tg_ios_macos_icons_25: Renew')
    await user.type(ru, ' now')
    expect(ru).toHaveValue(':tg_ios_macos_icons_25: Renew now')

    await user.click(screen.getByRole('button', { name: 'Save template' }))
    expect(patch).toHaveBeenCalledWith('/admin/notifications/templates/tpl-1', {
      buttons: [
        {
          labelRu: ':tg_ios_macos_icons_25: Renew now',
          labelEn: 'Renew :tg_ios_macos_icons_25:',
          kind: 'webApp',
          target: '/renew',
          style: 'default',
          row: 0,
        },
      ],
    })
  })
})

describe('the notifications page draws the template it will send', () => {
  it('draws the title and the body, and saves the token text of both', async () => {
    await loadScreenCopy('notifications')
    mockScreenApi([LIVE], {
      '/admin/settings': { userNotifications: {} },
      '/admin/notifications/templates': [
        {
          id: 'tpl-1',
          type: 'expires_in_3_days',
          title: ':tg_ios_macos_icons_25: Renewal',
          body: ':tg_ios_macos_icons_25: Your plan expires',
          isActive: true,
        },
      ],
    })
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await leaveField(user)

    // Both fields of the dialog, the one-line title and the multi-line body.
    expect(await screen.findAllByAltText(':tg_ios_macos_icons_25:')).toHaveLength(2)

    const fields = screen.getAllByTestId('emoji-field-overlay')
    expect(fields).toHaveLength(2)
    for (const field of fields) {
      expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
        'src',
        '/uploads/emoji/tg_ios_macos_icons_25.webp',
      )
      expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
    }

    const body = screen.getByDisplayValue(':tg_ios_macos_icons_25: Your plan expires')
    await user.type(body, '!')
    expect(body).toHaveValue(':tg_ios_macos_icons_25: Your plan expires!')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(patch).toHaveBeenCalledWith('/admin/notifications/templates/tpl-1', {
      title: ':tg_ios_macos_icons_25: Renewal',
      body: ':tg_ios_macos_icons_25: Your plan expires!',
    })
  })
})

describe('a broadcast field draws its emoji', () => {
  it('draws the title and the body of a new broadcast, each in its own field', async () => {
    await mockBroadcastApi(null, [LIVE])
    renderWithProviders(<BroadcastPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'New broadcast' }))

    // Pasting is what an operator does with copy written elsewhere, and it is
    // the path the field must survive: the value is set by the browser, not
    // by anything this layer runs.
    await user.click(await screen.findByLabelText('Title'))
    await user.paste(':tg_ios_macos_icons_25: Sale')
    await user.click(screen.getByLabelText('Message text'))
    await user.paste(':tg_ios_macos_icons_25: Two days left')
    await leaveField(user)

    // One single-line field, one multi-line field — both drawing, neither
    // showing the shortcode.
    const fields = await screen.findAllByTestId('emoji-field-overlay')
    expect(fields).toHaveLength(2)
    for (const field of fields) {
      expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
        'src',
        '/uploads/emoji/tg_ios_macos_icons_25.webp',
      )
      expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
    }
    expect(fields[0]).toHaveTextContent('Sale')
    expect(fields[1]).toHaveTextContent('Two days left')
  })

  it('shows the pack picture in the body of a sent broadcast instead of the shortcode', async () => {
    await mockBroadcastApi(':tg_ios_macos_icons_25: Go to channel', [LIVE])
    renderWithProviders(<BroadcastPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit broadcast' }))
    await leaveField(user)

    const field = await screen.findByTestId('emoji-field-overlay')
    expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
      'src',
      '/uploads/emoji/tg_ios_macos_icons_25.webp',
    )
    expect(field).toHaveTextContent('Go to channel')
    expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })

  it('sends Telegram the same token text the operator typed, not the drawn form', async () => {
    await mockBroadcastApi(':tg_ios_macos_icons_25: Go to channel', [LIVE])
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })

    renderWithProviders(<BroadcastPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Edit broadcast' }))
    await leaveField(user)

    // The field really is drawing the emoji before the edit…
    const field = await screen.findByTestId('emoji-field-overlay')
    expect(within(field).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()

    // …and the copy that leaves for Telegram is still the plain token string,
    // to the character. This is the one that stops the drawing from becoming
    // the data.
    const textarea = screen.getByLabelText('Message text')
    await user.type(textarea, '!')
    expect(textarea).toHaveValue(':tg_ios_macos_icons_25: Go to channel!')

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/broadcast/bc-1/edit', {
        text: ':tg_ios_macos_icons_25: Go to channel!',
        parseMode: null,
      }),
    )
  })
})

describe('a reply-keyboard caption draws its leading token where the bot puts it', () => {
  it('shows the leading shortcode as the button icon, not inside the caption', async () => {
    mockReplyKeyboardApi(':tg_ios_macos_icons_25: Go to channel', [LIVE])
    renderWithProviders(<ReplyKeyboardEditorPanel />)

    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toHaveAttribute(
      'src',
      '/uploads/emoji/tg_ios_macos_icons_25.webp',
    )

    const field = await screen.findByTestId('emoji-field-overlay')
    // Not inside the caption — neither as a picture nor as its carrier glyph,
    // because reiwa lifts it out of the caption entirely.
    expect(within(field).queryByAltText(':tg_ios_macos_icons_25:')).not.toBeInTheDocument()
    expect(field).toHaveTextContent('Go to channel')
    expect(field.textContent).not.toContain('📣')
    expect(field.textContent).not.toContain(':tg_ios_macos_icons_25:')
  })

  it('saves the leading token inside the caption even though it is drawn outside it', async () => {
    mockReplyKeyboardApi(':tg_ios_macos_icons_25: Go to channel', [LIVE])
    const patch = vi
      .spyOn(api, 'patch')
      .mockResolvedValue({ data: botButton(':tg_ios_macos_icons_25: Go to channel!') })

    renderWithProviders(<ReplyKeyboardEditorPanel />)

    // The caption really is drawing the leading token outside itself…
    expect(await screen.findByText('Button icon — not part of the caption')).toBeInTheDocument()

    // …and the caption it saves still carries that very token at its start.
    // Lifting the token out of the DRAWING must not lift it out of the VALUE.
    const caption = screen.getByDisplayValue(':tg_ios_macos_icons_25: Go to channel')
    const user = userEvent.setup()
    await user.type(caption, '!')
    expect(caption).toHaveValue(':tg_ios_macos_icons_25: Go to channel!')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/admin/bot-config/buttons/button-1', {
        label: ':tg_ios_macos_icons_25: Go to channel!',
        style: 'DEFAULT',
        iconCustomEmojiId: null,
        onePerRow: false,
        actionType: 'CALLBACK',
        actionTarget: null,
      }),
    )
  })
})

describe('the layer says nothing until it has something to say', () => {
  /**
   * An empty catalog is not a neutral starting state: with no packs loaded,
   * every `:slug:` resolves to "no pack defines this", which the layer paints
   * as a red pill reading "unknown shortcode, sent as raw text". So until the
   * fetch landed, every field on every screen accused its own correct content
   * of being broken, then quietly corrected itself.
   *
   * That is worse than showing nothing. A warning that fires on good content is
   * how operators learn to read past the red — and the red here is the same
   * marking that flags a genuinely dead token.
   */
  it('draws no layer at all while the pack catalog is still loading', async () => {
    let releasePacks: (() => void) | undefined
    const packsArrived = new Promise<void>((resolve) => {
      releasePacks = resolve
    })
    expect(releasePacks).toBeDefined()

    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/bot-config/texts') {
        return {
          data: [
            {
              id: 'text-1',
              key: 'menu.channel',
              value: ':tg_ios_macos_icons_25: Go to channel',
              visible: true,
              valueEn: null,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            },
          ],
        }
      }
      if (path === '/admin/custom-emoji/packs') {
        await packsArrived
        return packsPayload([LIVE])
      }
      if (path === '/admin/bot-config/emoji-studio') {
        return { data: { slots: [], ownerHasPremium: true } }
      }
      return { data: [] }
    })

    const user = userEvent.setup()
    renderWithProviders(<BotTextsTab />)
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await leaveField(user)

    // The field is idle and holds a token, so the layer would be up if it were
    // willing to speak. It must not be: the red "unknown shortcode" pill is
    // drawn INSIDE this layer, so its absence is what keeps the accusation off
    // the screen.
    //
    // Asserted on the layer rather than on the pill anywhere in the document,
    // because the dialog's delivery preview is a different component with its
    // own fetch and marks unknown tokens the same way while IT loads — a real
    // sibling defect, not this one, and a document-wide assertion here would
    // silently start guarding that instead.
    expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument()

    releasePacks?.()

    // And once it knows, it speaks: the same token becomes the pack picture.
    // Scoped to the layer for the same reason as above — the delivery preview
    // draws its own copy of that picture under the same alt text.
    const layer = await screen.findByTestId('emoji-field-overlay')
    expect(within(layer).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()
  })

  /**
   * The catalog is three separate fetches and they do not land together, so
   * "still loading" is not one state but several half-loaded ones. This probe
   * reads the very catalog the fields read — same provider tree, same query
   * cache, no second fetch — and lets the spec below pin one exact half: packs
   * in, premium still on the wire.
   *
   * Without it the spec would assert an absence that also holds before anything
   * has loaded at all, and would pass on the very code it is meant to fail on:
   * the row it forbids can only appear ONCE the packs are in.
   */
  function CatalogProbe() {
    const catalog = useEmojiCatalog()
    return (
      <span data-testid="catalog-probe">
        {`packs=${catalog.slugs.size} ready=${catalog.ready}`}
      </span>
    )
  }

  /**
   * The layer's gate covers what the layer draws. The button icon row is drawn
   * OUTSIDE it, above the field, and fails through a different query.
   *
   * Promotion asks for two things: a leading token with an id behind it, and
   * `ownerHasPremium`. The second falls back to `true` while its own fetch is
   * in flight — which is right for a value that has to degrade somehow, and
   * wrong to draw a conclusion from. So a field whose packs arrived first
   * announces "this token becomes the button's own icon" on the strength of an
   * answer nobody has given yet, and for an owner without Premium the answer is
   * no: reiwa sends no `icon_custom_emoji_id` for them at all. The row retracts
   * itself a moment later, having told the operator something false about where
   * their emoji goes.
   */
  it('draws no button icon row while the premium flag is still in flight', async () => {
    let releasePremium: (() => void) | undefined
    const premiumArrived = new Promise<void>((resolve) => {
      releasePremium = resolve
    })
    expect(releasePremium).toBeDefined()

    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/custom-emoji/packs') return packsPayload([LIVE])
      if (path === '/admin/bot-config/emoji-studio') {
        await premiumArrived
        return emojiStudioPayload(true)
      }
      return { data: [] }
    })

    renderWithProviders(
      <>
        <CatalogProbe />
        <BotButtonEditDialog
          button={botButton(':tg_ios_macos_icons_25: Go to channel')}
          open
          onOpenChange={() => {}}
        />
      </>,
    )
    const user = userEvent.setup()
    await leaveField(user)

    // The half-loaded moment itself, and the whole point of the probe: the pack
    // is in, so the promotion rule already matches and `ownerHasPremium` is
    // sitting on its default — and the catalog still has nothing to say.
    await screen.findByText('packs=1 ready=false')

    // Neither surface may speak from that default. The layer already knows not
    // to; the row is asserted next to it because they answer the same question
    // and must answer it at the same time.
    expect(screen.queryByText('Button icon — not part of the caption')).not.toBeInTheDocument()
    expect(screen.queryByTestId('emoji-field-overlay')).not.toBeInTheDocument()

    releasePremium?.()

    // The gate delays the row, it does not swallow it: with the answer in, the
    // leading token is drawn as the button's icon exactly as before.
    await screen.findByText('packs=1 ready=true')
    const iconRow = await screen.findByTitle(
      /:tg_ios_macos_icons_25: leads the caption, so the bot moves it into the button's own icon/,
    )
    expect(within(iconRow).getByAltText(':tg_ios_macos_icons_25:')).toBeInTheDocument()
    expect(screen.getByText('Button icon — not part of the caption')).toBeInTheDocument()
  })
})

/**
 * A disabled field dims itself through `disabled:opacity-50` — and the layer is
 * an OPAQUE `bg-background` box drawn on top of it, so a layer that does not dim
 * with it hides the dimming entirely and the control reads as fully enabled.
 *
 * Not a cosmetic edge case: the fields that disable themselves do it mid-save,
 * which is exactly when the operator is watching to see whether their edit took.
 * And `LocaleTextarea` saves ON BLUR — the layer is up at the very moment the
 * save it is hiding is in flight.
 */
describe('a disabled field dims together with the layer over it', () => {
  it('dims both halves of a locale pair while the save is in flight', async () => {
    mockScreenApi([LIVE])
    renderWithProviders(
      <LocaleTextarea
        labelRu="Body (RU)"
        labelEn="Body (EN)"
        valueRu=":tg_ios_macos_icons_25: Go to channel"
        valueEn=":tg_ios_macos_icons_25: Go to channel"
        onSave={() => {}}
        disabled
      />,
    )

    // Wait for the picture, not for the layer: the layer goes up before the
    // catalog lands, and it is the drawn state we need underneath.
    expect(await screen.findAllByAltText(':tg_ios_macos_icons_25:')).toHaveLength(2)

    const textareas = screen.getAllByRole('textbox')
    expect(textareas).toHaveLength(2)
    for (const textarea of textareas) expect(textarea).toBeDisabled()

    // Both halves, because `disabled` reaching one of them and not the other is
    // the shape this defect actually had.
    const fields = screen.getAllByTestId('emoji-field-overlay')
    expect(fields).toHaveLength(2)
    for (const field of fields) expect(field).toHaveClass('opacity-50')
  })

  it('dims the layer over a disabled single-line field', async () => {
    mockScreenApi([LIVE])
    renderWithProviders(
      <EmojiTextInput
        value=":tg_ios_macos_icons_25: Go to channel"
        onChange={() => {}}
        emojiAriaLabel="Insert emoji"
        disabled
      />,
    )

    await screen.findByAltText(':tg_ios_macos_icons_25:')
    // The input dims on its own — `disabled` used to ride in on the prop spread
    // and stop there, which is why the field below can pass this line while the
    // box painted over it stays at full strength.
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByTestId('emoji-field-overlay')).toHaveClass('opacity-50')
  })
})

/**
 * The layer draws from the top of the content. The field underneath does not
 * have to be there.
 *
 * Leave a long caption scrolled halfway down, click away, and the layer went up
 * showing line one where the field had been showing line ten — the text
 * appeared to jump on blur, on precisely the fields long enough to scroll and
 * therefore on precisely the copy worth reading before sending.
 *
 * The second spec is the one that is easy to miss: the layer is
 * `pointer-events-none`, so a wheel over it reaches the FIELD. The field
 * scrolls, and without a listener the layer stays where it was — the two drift
 * apart under the operator's own scrolling, with no blur involved at all.
 */
describe('the layer follows the field it covers', () => {
  const LONG = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')

  it('takes the offset the field was left at, instead of snapping to the top', async () => {
    mockScreenApi([LIVE])
    renderWithProviders(
      <LocaleTextarea
        labelRu="Body (RU)"
        labelEn="Body (EN)"
        valueRu={`:tg_ios_macos_icons_25: ${LONG}`}
        valueEn=""
        onSave={() => {}}
      />,
    )

    await screen.findByAltText(':tg_ios_macos_icons_25:')
    const textarea = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement

    await userEvent.click(textarea)
    textarea.scrollTop = 96
    await userEvent.tab()

    await waitFor(() => {
      const layer = screen.getAllByTestId('emoji-field-overlay')[0]
      expect(layer.scrollTop).toBe(96)
    })
  })

  it('keeps up when the field is scrolled underneath the layer', async () => {
    mockScreenApi([LIVE])
    renderWithProviders(
      <LocaleTextarea
        labelRu="Body (RU)"
        labelEn="Body (EN)"
        valueRu={`:tg_ios_macos_icons_25: ${LONG}`}
        valueEn=""
        onSave={() => {}}
      />,
    )

    await screen.findByAltText(':tg_ios_macos_icons_25:')
    const textarea = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement
    const layer = screen.getAllByTestId('emoji-field-overlay')[0]

    // No focus anywhere: this is the wheel-over-an-idle-field case.
    textarea.scrollTop = 144
    textarea.dispatchEvent(new Event('scroll'))

    await waitFor(() => expect(layer.scrollTop).toBe(144))
  })
})
