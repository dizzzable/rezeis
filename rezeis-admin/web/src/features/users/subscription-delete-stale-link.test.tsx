/**
 * `DELETE /admin/users/subscriptions/:subscriptionId` answers HTTP 409 with
 * `code: 'SUBSCRIPTION_DELETE_STALE_PANEL_LINK'` when the row's stored panel
 * identity is a 2.x uuid on a panel that has been proven 3.x — because deleting
 * it would remove whatever the address fallback resolves to, which on an
 * unrepaired duplicate pair is a paying customer's live profile.
 *
 * The SPA rendered that as a generic conflict. In fact `deleteSubMutation` had
 * no `onError` at all, so an operator pressed delete, watched nothing happen,
 * and never learned that the backend had told them exactly what to do about it.
 *
 * FOUR THINGS THESE SPECS PIN, each a separate way for the repair to rot:
 *
 *   1. The CODE decides. Not the sentence. The backend ships a hand-written
 *      English paragraph beside the code, and matching it byte for byte is the
 *      fragility another agent just removed from the sync refusals a few
 *      hundred lines away — one copy-edit and the branch degrades to the
 *      generic failure, with a non-success toast still on screen so nothing
 *      looks broken. Asserted in BOTH directions: the code with a reworded
 *      message still branches, and the exact backend sentence under a
 *      DIFFERENT code does not.
 *   2. The remedy is one press away. The refusal is not "something went wrong",
 *      it is "do this specific thing and the delete will work" — so the notice
 *      carries the ordered sequence and a control that opens the surface that
 *      runs it. A sentence alone is a remedy nobody performs.
 *   3. Every word the operator READS comes from the dictionaries. The backend's
 *      prose is a diagnostic line, never operator copy — asserted by driving
 *      the whole thing in Russian.
 *   4. The literal in `subscription-delete-refusals.ts` is the backend's. The
 *      backend constant is imported across the package boundary and compared,
 *      so a rename there fails this file by name instead of silently costing
 *      the operator their guidance.
 *
 * ANTI-VACUITY DISCIPLINE. No spec waits on the text it is about to assert:
 * each waits for ANY toast to have fired, and then asserts which notice exists
 * and what it says. Waiting on the expected text turns a real regression into a
 * ten second timeout and makes every absence assertion unreachable.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'

// ACROSS THE PACKAGE BOUNDARY, from a test, deliberately — the same move
// `rbac-catalog-parity.test.ts` and `subscription-sync-outcome.test.tsx` make,
// and for the same reason: comparing the panel's literal against a second COPY
// of the backend's constant would reproduce the drift it is meant to catch.
// `tsconfig.app.json` excludes tests so the production build never follows this
// import, and `build-isolation.test.ts` pins that arrangement.
import {
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE as BACKEND_CODE,
  SUBSCRIPTION_DELETE_STALE_PANEL_LINK_MESSAGE as BACKEND_MESSAGE,
} from '../../../../src/modules/remnawave/services/stale-panel-link'

import { SUBSCRIPTION_DELETE_STALE_PANEL_LINK_CODE as PANEL_CODE } from './subscription-delete-refusals'
import UserDetailPanel from './user-detail-panel'

/** Read from the ACTIVE bundle so the Russian spec drives the same helpers. */
const subscriptionsTabLabel = (): string => i18n.t('userDetailPanel.tabs.subscriptions')
const deleteButtonLabel = (): string => i18n.t('userDetailPanel.subscriptions.deleteTitle')
/** The card's delete is behind a confirmation; see `subscription-delete-confirmation.test.tsx`. */
const confirmDeleteLabel = (): string =>
  i18n.t('userDetailPanel.subscriptions.deleteConfirm.action')

/**
 * Press delete and answer the confirmation.
 *
 * These specs are about what the ANSWER to the request looks like, so they go
 * THROUGH the guard rather than around it — driving the mutation directly would
 * leave them green on a build where the operator can no longer reach it.
 */
async function confirmDelete(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: confirmDeleteLabel(),
    }),
  )
}

const SUBSCRIPTION = {
  id: 'subscription-1',
  status: 'ACTIVE',
  remnawaveId: '0f1f8a2e-1111-4c2b-9a3d-0b6b1f2c3d4e',
  remnawaveProfileName: 'rz_alice_sub_1',
  remnawaveSyncState: 'SYNCED',
  remnawaveSyncJob: null,
  expireAt: '2099-01-01T00:00:00.000Z',
  trafficLimit: 50,
  deviceLimit: 3,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

function userWithSubscription() {
  return {
    id: 'user-1',
    telegramId: '12345',
    username: 'alice',
    name: 'Alice',
    language: 'en',
    role: 'USER',
    isBlocked: false,
    isPartner: false,
    points: 0,
    personalDiscount: 0,
    purchaseDiscount: 0,
    maxSubscriptions: 1,
    createdAt: '2026-06-04T10:00:00.000Z',
    updatedAt: '2026-06-04T10:00:00.000Z',
    subscriptions: [SUBSCRIPTION],
    transactions: [],
    referralsGiven: [],
    partner: null,
    webAccount: null,
  }
}

/** An axios-shaped rejection carrying whatever body the spec wants to test. */
function conflict(body: Record<string, unknown>): Error {
  return Object.assign(new Error('Request failed with status code 409'), {
    isAxiosError: true,
    response: { status: 409, data: body },
  })
}

function toastSpies() {
  return {
    success: vi.spyOn(toast, 'success').mockReturnValue('t-ok'),
    warning: vi.spyOn(toast, 'warning').mockReturnValue('t-warn'),
    error: vi.spyOn(toast, 'error').mockReturnValue('t-err'),
    info: vi.spyOn(toast, 'info').mockReturnValue('t-info'),
  }
}

type ToastSpies = ReturnType<typeof toastSpies>

function firedToast(spies: ToastSpies): { channel: string; text: unknown } | null {
  for (const channel of ['success', 'warning', 'error', 'info'] as const) {
    const call = spies[channel].mock.calls[0]
    if (call !== undefined) return { channel, text: call[0] }
  }
  return null
}

function toastCount(spies: ToastSpies): number {
  return (
    spies.success.mock.calls.length +
    spies.warning.mock.calls.length +
    spies.error.mock.calls.length +
    spies.info.mock.calls.length
  )
}

/**
 * Press the card's delete button and wait for the answer to LAND — for any
 * toast at all. Deliberately not for any particular words, and deliberately not
 * for the notice either: whether a notice exists is the fact half these specs
 * are about.
 */
async function pressDelete(
  rejection: unknown,
): Promise<{ spies: ToastSpies; deleteSpy: ReturnType<typeof vi.spyOn> }> {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({ data: userWithSubscription() } as never)
  const deleteSpy = vi
    .spyOn(api, 'delete')
    .mockRejectedValue(rejection as never) as ReturnType<typeof vi.spyOn>
  const spies = toastSpies()

  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))
  const deleteButtons = await screen.findAllByRole('button', { name: deleteButtonLabel() })
  await user.click(deleteButtons[0] as HTMLElement)
  await confirmDelete(user)

  await waitFor(() => expect(toastCount(spies)).toBeGreaterThan(0))
  return { spies, deleteSpy }
}

/** The refusal notice on the card, or null when the card is not showing one. */
function refusalNotice(): HTMLElement | null {
  const notices = screen.queryAllByRole('status')
  return (
    notices.find((node) =>
      node.textContent?.includes(i18n.t('userDetailPanel.subscriptions.deleteRefusal.stalePanelLink.headline')),
    ) ?? null
  )
}

describe('a refused subscription delete points at the repair', () => {
  beforeAll(async () => {
    await loadFeatureBundle('userDetail')
  })

  beforeEach(() => {
    usePermissionStore.setState({ loaded: true, role: 'DEV' })
  })

  afterEach(() => {
    cleanup()
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('surfaces the stale-link refusal as guidance, with the ordered remedy', async () => {
    const { spies } = await pressDelete(conflict({ code: BACKEND_CODE, message: BACKEND_MESSAGE }))

    expect(spies.success).not.toHaveBeenCalled()
    expect(firedToast(spies)?.channel).toBe('error')

    const notice = refusalNotice()
    expect(notice).not.toBeNull()
    expect(notice).toHaveTextContent('Not deleted — the stored panel link is stale')
    // The REASON, in the panel's own words.
    expect(notice).toHaveTextContent('Nothing was deleted.')
    // The REMEDY, as a sequence: preview, real run, delete again. An operator
    // handed only "repair the link" does not know that a preview comes first.
    const steps = within(notice as HTMLElement).getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    expect(steps[0]).toHaveTextContent(
      'Open the panel link repair on the Subscriptions page and run the preview.',
    )
    expect(steps[1]).toHaveTextContent('Repair for real once the preview looks right.')
    expect(steps[2]).toHaveTextContent('Come back here and delete this subscription again.')
  })

  it('puts the reconciliation surface one press away, not one sentence away', async () => {
    // A pointer an operator has to act on by memory across two screens is a
    // pointer nobody follows. The control is a real link to the page that owns
    // the write.
    await pressDelete(conflict({ code: BACKEND_CODE, message: BACKEND_MESSAGE }))

    const notice = refusalNotice()
    expect(notice).not.toBeNull()
    const link = within(notice as HTMLElement).getByRole('link', {
      name: 'Open the panel link repair',
    })
    expect(link).toHaveAttribute('href', '/subscriptions')
  })

  it('branches on the code even when the backend reworded its sentence', async () => {
    // THE WHOLE POINT. A copy-edit on the backend's prose must not cost the
    // operator their guidance — which is exactly what a message-matching branch
    // would do, silently, with a non-success toast still on screen.
    const { spies } = await pressDelete(
      conflict({
        code: BACKEND_CODE,
        message: 'Totally different wording that no table here has ever seen.',
      }),
    )

    expect(firedToast(spies)?.channel).toBe('error')
    const notice = refusalNotice()
    expect(notice).not.toBeNull()
    expect(notice).toHaveTextContent('Not deleted — the stored panel link is stale')
    // The server's own sentence is nowhere on screen: this refusal is one the
    // build recognises, so the dictionary answers in full.
    expect(notice).not.toHaveTextContent('Totally different wording')
  })

  it('branches on errorCode alone, which is the field the filter always sets', async () => {
    // `AdminSafeExceptionFilter` writes the product code into `errorCode`
    // unconditionally and adds `code` only when the thrown body carried one.
    const { spies } = await pressDelete(
      conflict({ errorCode: BACKEND_CODE, message: BACKEND_MESSAGE }),
    )

    expect(firedToast(spies)?.channel).toBe('error')
    expect(refusalNotice()).not.toBeNull()
  })

  it('does NOT branch on the backend sentence when the code says something else', async () => {
    // The direction-complete half. Without this spec an implementation that
    // matched the message as well would pass every one above, and would then
    // send an operator to run a bulk repair for a refusal that has nothing to
    // do with panel links.
    const { spies } = await pressDelete(
      conflict({ code: 'SOME_OTHER_CONFLICT', message: BACKEND_MESSAGE }),
    )

    expect(firedToast(spies)?.channel).toBe('error')
    expect(refusalNotice()).toBeNull()
    // The generic path still tells the operator something, and it is the
    // server's own sentence rather than silence.
    expect(firedToast(spies)?.text).toBe(BACKEND_MESSAGE)
  })

  it('leaves an untyped conflict on the generic path', async () => {
    const { spies } = await pressDelete(
      conflict({ statusCode: 409, message: 'Subscription is protected by history' }),
    )

    expect(firedToast(spies)?.channel).toBe('error')
    expect(refusalNotice()).toBeNull()
    expect(firedToast(spies)?.text).toBe('Subscription is protected by history')
  })

  it('falls back to its own copy when the failure carried no sentence at all', async () => {
    const { spies } = await pressDelete(
      Object.assign(new Error(''), { isAxiosError: true, response: { status: 500, data: {} } }),
    )

    expect(firedToast(spies)?.channel).toBe('error')
    expect(refusalNotice()).toBeNull()
    expect(firedToast(spies)?.text).toBe('The subscription was not deleted')
  })

  it('shows no refusal notice on a delete that succeeded', async () => {
    // The control for every spec above. A card that rendered the notice
    // unconditionally would pass all of them.
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: userWithSubscription() } as never)
    vi.spyOn(api, 'delete').mockResolvedValue({ data: { ok: true } } as never)
    const spies = toastSpies()

    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(await screen.findByRole('tab', { name: new RegExp(subscriptionsTabLabel()) }))
    const deleteButtons = await screen.findAllByRole('button', { name: deleteButtonLabel() })
    await user.click(deleteButtons[0] as HTMLElement)
    await confirmDelete(user)

    await waitFor(() => expect(toastCount(spies)).toBeGreaterThan(0))
    expect(firedToast(spies)?.channel).toBe('success')
    expect(refusalNotice()).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open the panel link repair' })).not.toBeInTheDocument()
  })

  it('refuses in Russian for a Russian operator', async () => {
    // The backend's `message` is English prose. If any of it were being
    // rendered as operator copy rather than looked up as a key, this spec is
    // where it shows: the whole notice is asserted in Russian.
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('userDetail')
    try {
      const { spies } = await pressDelete(
        conflict({ code: BACKEND_CODE, message: BACKEND_MESSAGE }),
      )

      expect(firedToast(spies)?.text).toBe(
        'Не удалена — сохранённая привязка к панели устарела. Сначала почините привязку.',
      )
      const notice = refusalNotice()
      expect(notice).not.toBeNull()
      expect(notice).toHaveTextContent('Не удалена — сохранённая привязка к панели устарела')
      expect(notice).toHaveTextContent('Ничего не удалено.')
      const steps = within(notice as HTMLElement).getAllByRole('listitem')
      expect(steps[0]).toHaveTextContent(
        'Откройте починку привязки на странице «Подписки» и запустите предпросмотр.',
      )
      expect(steps[2]).toHaveTextContent('Вернитесь сюда и удалите подписку ещё раз.')
      expect(
        within(notice as HTMLElement).getByRole('link', { name: 'Открыть починку привязки' }),
      ).toHaveAttribute('href', '/subscriptions')
      // Not one word of the backend's English paragraph is on screen.
      expect(notice).not.toHaveTextContent('Run the panel link reconciliation')
    } finally {
      await i18n.changeLanguage('en')
      await loadFeatureBundle('userDetail')
    }
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
  })
})

/**
 * THE DRIFT GUARD: the backend's constant against the panel's literal.
 *
 * Nothing the PRODUCTION frontend project compiles may reach into the backend
 * tree — the Docker frontend stage is `COPY web/ .` and nothing else — so
 * `subscription-delete-refusals.ts` carries a hand-written copy of the code and
 * imports nothing at all. That copy only stays true if something watches it,
 * and the failure of an unwatched copy is exactly the one this whole change
 * removes: a generic conflict with the specific guidance quietly missing, and
 * every other spec in this file still green, because every other spec writes
 * both sides of the wire itself.
 */
describe('the panel spells the refusal code the way the backend does', () => {
  it('is comparing two real, non-empty values', () => {
    // The anchor. Two empty strings satisfy a `toBe` between them.
    expect(BACKEND_CODE.length).toBeGreaterThan(10)
    expect(PANEL_CODE.length).toBeGreaterThan(10)
  })

  it('matches the backend constant exactly', () => {
    expect(PANEL_CODE).toBe(BACKEND_CODE)
  })

  it('is allowlisted, so the filter lets it reach the wire at all', () => {
    // Stripped of its code by `AdminSafeExceptionFilter` the refusal arrives as
    // an untyped 409 and every branch above is dead. The allowlist is therefore
    // part of this contract, not an implementation detail of the backend.
    const filter = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../src/common/filters/admin-safe-exception.filter.ts',
    )
    const source: string = readFileSync(filter, 'utf8')
    expect(source).toContain(`'${BACKEND_CODE}'`)
  })
})
