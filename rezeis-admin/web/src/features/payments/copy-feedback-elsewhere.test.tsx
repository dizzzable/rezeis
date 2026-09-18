/**
 * The three copies that said nothing at all.
 *
 * The 2FA recovery codes («Копировать все»), a new webhook's signing secret and
 * the project's USDT address each ran `navigator.clipboard?.writeText(…)` and
 * dropped the answer: no word when the copy worked, none when the browser
 * refused — and the codes and the secret are shown exactly once. They now go
 * through the shared `copyTextToClipboard` and say which it was.
 *
 * Each case pins the clipboard's answer — a `writeText` that resolves, or one
 * that rejects with a fallback `execCommand` that refuses too — and asserts the
 * sentence that follows. Neither half alone could fail on "always success" or
 * "always failure".
 *
 * (It lives with the payments feature only because that is where this change
 * may add tests; it drives two-factor, webhooks and the top bar.)
 */
import type { ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { SupportDropdown } from '@/components/layout/admin-topbar/support-dropdown'
import { RecoveryCodesPanel } from '@/features/two-factor/two-factor-page'
import { SecretRevealCard } from '@/features/webhooks/webhooks-page'

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

let writeText: ReturnType<typeof vi.fn>

function clipboardAnswers(answer: 'accepts' | 'refuses'): void {
  writeText = vi.fn(async () => {
    if (answer === 'refuses') throw new DOMException('Document is not focused.', 'NotAllowedError')
  })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  // The fallback refuses as well: a browser that will not copy at all.
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
}

function renderEn(node: ReactNode) {
  const user = userEvent.setup()
  render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
  return user
}

async function verdict(): Promise<'success' | 'error'> {
  await waitFor(() =>
    expect(toastMock.success.mock.calls.length + toastMock.error.mock.calls.length).toBe(1),
  )
  return toastMock.success.mock.calls.length === 1 ? 'success' : 'error'
}

beforeAll(async () => {
  await i18nReady
  await i18n.changeLanguage('en')
  await loadFeatureBundle('twoFactor')
})

beforeEach(() => {
  vi.restoreAllMocks()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

describe('2FA recovery codes', () => {
  const CODES = ['aaaa-1111', 'bbbb-2222']

  it('says «Copied» once every code is on the clipboard', async () => {
    const user = renderEn(<RecoveryCodesPanel codes={CODES} />)
    clipboardAnswers('accepts')

    await user.click(screen.getByRole('button', { name: 'Copy all' }))

    expect(await verdict()).toBe('success')
    expect(writeText).toHaveBeenCalledWith('aaaa-1111\nbbbb-2222')
    expect(toastMock.success).toHaveBeenCalledWith('Copied')
  })

  it('says it failed when the browser refused', async () => {
    const user = renderEn(<RecoveryCodesPanel codes={CODES} />)
    clipboardAnswers('refuses')

    await user.click(screen.getByRole('button', { name: 'Copy all' }))

    expect(await verdict()).toBe('error')
    expect(toastMock.error).toHaveBeenCalledWith(
      'Could not copy: the browser did not allow access to the clipboard. Select the text on screen and copy it by hand.',
    )
  })
})

describe('a webhook signing secret', () => {
  it('says «Copied» once the secret is on the clipboard', async () => {
    const user = renderEn(<SecretRevealCard title="New secret" secret="whsec_abc123" onClose={() => undefined} />)
    clipboardAnswers('accepts')

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await verdict()).toBe('success')
    expect(writeText).toHaveBeenCalledWith('whsec_abc123')
  })

  it('says it failed when the browser refused', async () => {
    const user = renderEn(<SecretRevealCard title="New secret" secret="whsec_abc123" onClose={() => undefined} />)
    clipboardAnswers('refuses')

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await verdict()).toBe('error')
  })
})

describe('the USDT address in the top bar', () => {
  async function copyAddress(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Support project' }))
    await user.click(await screen.findByRole('menuitem', { name: /USDT \(TRC-20\)/ }))
  }

  it('says the address was copied once it was', async () => {
    const user = renderEn(<SupportDropdown />)
    clipboardAnswers('accepts')

    await copyAddress(user)

    expect(await verdict()).toBe('success')
    expect(toastMock.success).toHaveBeenCalledWith('USDT (TRC-20) copied')
  })

  it('says it failed and hands over the address, since the menu closes on the click', async () => {
    const user = renderEn(<SupportDropdown />)
    clipboardAnswers('refuses')

    await copyAddress(user)

    expect(await verdict()).toBe('error')
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Could not copy USDT (TRC-20)'), {
      description: 'TNmxGN8iL5p2yfreNF1DtCEzpQCLuVZjeR',
    })
  })
})
