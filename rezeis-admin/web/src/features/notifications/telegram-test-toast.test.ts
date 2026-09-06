import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { reportTelegramTest, type TelegramTestResult } from './telegram-test-toast'

/**
 * What the operator reads after pressing «Отправить тест».
 *
 * The handler used to toast success on any 200, and the endpoint answered 200
 * for a revoked token, a bot kicked from the group and a wrong topic id
 * alike. This button is the ONLY verification surface for the whole operator
 * alerting pipeline, so a lying one is worse than none: whoever presses it
 * and reads "отправлено" stops looking.
 *
 * Three outcomes, three different next steps — that is why they must not be
 * folded together.
 */

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const t = (key: string, opts?: Record<string, unknown>) =>
  opts === undefined ? key : `${key}:${JSON.stringify(opts)}`

function result(patch: Partial<TelegramTestResult>): TelegramTestResult {
  return { delivered: false, via: 'primary', outcome: 'failed', reason: null, ...patch }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the delivery-probe toast', () => {
  it('celebrates only an actual delivery', () => {
    reportTelegramTest(result({ delivered: true, outcome: 'sent' }), t)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('does not celebrate a card merely handed to the relay', () => {
    // The split deployment: the panel gave it to the reiwa bot and does not
    // yet know. Saying "delivered" is the same lie in a quieter voice.
    reportTelegramTest(result({ outcome: 'relayed' }), t)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith('notificationsPage.toasts.testHandedOn')
  })

  it('does not celebrate a queued card either', () => {
    reportTelegramTest(result({ outcome: 'queued' }), t)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalled()
  })

  it("repeats Telegram's own words on a refusal", () => {
    // "Request failed with status code 400" names nothing an operator can
    // fix; "message thread not found" names the field to correct.
    reportTelegramTest(result({ reason: 'message thread not found' }), t)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain('message thread not found')
  })

  it('translates the refusals it has words for', () => {
    reportTelegramTest(result({ reason: 'TELEGRAM_TEST_EVENT_NOT_SELECTED' }), t)
    expect(toast.error).toHaveBeenCalledWith('notificationsPage.toasts.testNotSelected')
  })

  it('still says something when no reason came back', () => {
    reportTelegramTest(result({ reason: null }), t)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.success).not.toHaveBeenCalled()
  })
})
