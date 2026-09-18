/**
 * What «Запустить» puts on the wire (contract §1).
 *
 * `showAgain` travels BESIDE `triggerData`, never inside it — the server reads
 * it from the body alone, so no event payload can carry it — and only when the
 * caller decided it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { runRuleManually } from './automations-api'

const ANSWER = { executionId: 'e1', status: 'SUCCEEDED', actionResults: [], errorMessage: null }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runRuleManually', () => {
  it('sends only the trigger when nothing was decided about showing again', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: ANSWER } as never)

    await runRuleManually('rule-1', { userId: 'cm-1' })

    expect(post).toHaveBeenCalledWith(
      '/admin/automations/rules/rule-1/run',
      { triggerData: { userId: 'cm-1' } },
      expect.anything(),
    )
    expect(Object.keys(post.mock.calls[0]![1] as object)).toEqual(['triggerData'])
  })

  it('waits two minutes for the answer, not the client’s thirty seconds', async () => {
    // A run executes every action inside the request, and the panel gives this
    // route two minutes. A browser that gave up at thirty seconds reported as
    // failed a run that was still going.
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: ANSWER } as never)

    await runRuleManually('rule-1', { userId: 'cm-1' }, { showAgain: true })

    expect(post.mock.calls[0]![2]).toEqual({ timeout: 120_000 })
    expect(api.defaults.timeout).toBeLessThan(120_000)
  })

  it('sends showAgain beside the trigger, true or false, when it was decided', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: ANSWER } as never)

    await runRuleManually('rule-1', { userId: 'cm-1' }, { showAgain: true })
    await runRuleManually('rule-1', { userId: 'cm-1' }, { showAgain: false })

    expect(post.mock.calls[0]![1]).toEqual({ triggerData: { userId: 'cm-1' }, showAgain: true })
    expect(post.mock.calls[1]![1]).toEqual({ triggerData: { userId: 'cm-1' }, showAgain: false })
    // Never inside the trigger, where an event payload could put it too.
    expect((post.mock.calls[0]![1] as { triggerData: object }).triggerData).not.toHaveProperty('showAgain')
  })

  it('hands back the answer with codes intact', async () => {
    const withCodes = {
      ...ANSWER,
      actionResults: [
        { index: 0, type: 'show_hint', status: 'success', code: 'hint_queued', details: { hintKey: 'k', userId: 'u' } },
      ],
    }
    vi.spyOn(api, 'post').mockResolvedValue({ data: withCodes } as never)

    await expect(runRuleManually('rule-1')).resolves.toEqual(withCodes)
  })
})
