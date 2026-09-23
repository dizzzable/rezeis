/**
 * «Список»'s own main-menu editor saves a button's caption.
 *
 * It sent `PUT /admin/bot-config/buttons/:id`, a route the server does not
 * have — the controller answers PATCH there (`AdminBotConfigController.updateButton`,
 * pinned in `test/mini-app-page-picker-saves.spec.ts`) — so every «Сохранить»
 * on that list ended in «не удалось сохранить».
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

import type { ReplyKeyboardMapNode } from '../types'
import { ReplyButtonEditor } from './inspector/ReplyButtonEditor'

beforeAll(async () => {
  await loadFeatureBundle('botMap')
})

afterEach(() => {
  vi.restoreAllMocks()
})

const MENU: ReplyKeyboardMapNode = {
  id: '__reply_keyboard__',
  kind: 'reply-keyboard',
  title: 'Главное меню',
  group: 'reply',
  buttons: [
    {
      id: 'row-1',
      buttonId: 'invite',
      label: 'Пригласить',
      visible: true,
      actionType: 'CALLBACK',
      actionTarget: null,
    },
  ],
}

describe('a main-menu button on «Список»', () => {
  it('saves its caption with the method the server routes', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    const put = vi.spyOn(api, 'put').mockRejectedValue(new Error('Cannot PUT'))
    const user = userEvent.setup()
    renderWithProviders(<ReplyButtonEditor node={MENU} />)

    const caption = screen.getByDisplayValue('Пригласить')
    await user.type(caption, '!')
    await user.click(screen.getByRole('button', { name: i18n.t('botMapPage.replyKeyboard.saveLabel') }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/admin/bot-config/buttons/row-1', { label: 'Пригласить!' }))
    expect(put).not.toHaveBeenCalled()
  })
})
