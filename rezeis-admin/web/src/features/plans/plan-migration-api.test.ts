/**
 * THE MIGRATION BODIES ARE READ, NOT CAST (spec §4).
 *
 * Each reader is fed the RAW wire shape — a plain object literal, never one
 * typed as the interface the reader produces — so a reader that stopped
 * checking a field cannot hide behind a fixture built from its own output.
 * For every shape the dialog makes a decision on, a malformed variant must
 * THROW: an unreadable list read as empty deletes a plan without moving anyone,
 * and an unreadable status read as finished deletes it mid-move.
 */
import type { AxiosResponse } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import { plansQueryKeys } from './plans-api'
import { wireWarningCounts } from './plan-migration-wire.fixtures'
import {
  fetchPlanMigrationCurrent,
  fetchPlanMigrationRunStatus,
  fetchPlanSubscriptionsPage,
  planMigrationQueryKeys,
  PLAN_MIGRATION_LOOKUP_TIMEOUT_MS,
  PLAN_MIGRATION_WRITE_TIMEOUT_MS,
  previewPlanMigration,
  startPlanMigration,
  readPlanMigrationCurrent,
  readPlanMigrationPreview,
  readPlanMigrationRetry,
  readPlanMigrationRunStatus,
  readPlanMigrationStarted,
  readPlanSubscriptionsPage,
  readSquadOptions,
  retryPlanMigration,
} from './plan-migration-api'

const MALFORMED = 'errors.unexpectedResponsePayload'

function wireItem(): Record<string, unknown> {
  return {
    subscriptionId: 'sub-1',
    user: { id: 'user-1', name: 'Alice', username: null, telegramId: '4242', email: null },
    status: 'ACTIVE',
    isTrial: false,
    expiresAt: '2030-01-01T00:00:00.000Z',
    remnawaveLinked: true,
    limits: { trafficLimit: 0, deviceLimit: -1, internalSquads: ['sq-1'], externalSquad: null },
    ownership: {
      trafficLimit: 'INHERITED',
      deviceLimit: 'INDIVIDUAL',
      squads: 'UNKNOWN',
      internalSquads: 'UNKNOWN',
      externalSquad: 'INHERITED',
    },
    flags: { pendingRenewalForPlan: false, scheduledTermOnPlan: true, sharedPanelProfile: false },
  }
}

function wirePage(item: Record<string, unknown> = wireItem()): Record<string, unknown> {
  return { total: 3, matched: 1, items: [item], nextCursor: 'cursor-2' }
}

function wireSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null, isTrial: true, ...overrides }
}

function wirePreview(row: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: [{ targetPlanId: 'plan-a', count: 1, skipped: 0, warnings: wireWarningCounts({ FEWER_DEVICES: 1 }) }],
    rows: [
      {
        subscriptionId: 'sub-1',
        user: { id: 'user-1', name: null, username: 'alice', telegramId: null, email: null },
        targetPlanId: 'plan-a',
        before: wireSnapshot(),
        after: wireSnapshot({ trafficLimit: 0, deviceLimit: 2, isTrial: false }),
        kept: ['squads'],
        warnings: ['FEWER_DEVICES', 'SOMETHING_NEW'],
        willSkip: null,
        pushesToRemnawave: true,
        ...row,
      },
    ],
    nextCursor: null,
  }
}

function wireStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-1',
    status: 'RUNNING',
    totals: { total: 3, pending: 1, moved: 1, skipped: 0, failed: 1, skippedByReason: {} },
    sync: { total: 1, pending: 1, completed: 0, failed: 0 },
    problems: [
      {
        subscriptionId: 'sub-2',
        user: null,
        targetPlanId: 'plan-a',
        kind: 'MOVE_FAILED',
        reason: 'INTERNAL_ERROR',
        detail: 'deadlock',
      },
    ],
    problemsCursor: null,
    finished: false,
    ...overrides,
  }
}

describe('the query keys', () => {
  it('sit outside plansQueryKeys.all, so a delete’s invalidation never refetches them', () => {
    const root = plansQueryKeys.all
    const keys = [
      planMigrationQueryKeys.subscriptionsOfPlan('p'),
      planMigrationQueryKeys.subscriptions('p', ''),
      planMigrationQueryKeys.subscriptions('p', 'alice'),
      planMigrationQueryKeys.preview('p', '{}'),
      planMigrationQueryKeys.run('p', 'r'),
      planMigrationQueryKeys.current('p'),
      planMigrationQueryKeys.squadOptions('internal'),
      planMigrationQueryKeys.squadOptions('external'),
    ]
    for (const key of keys) {
      expect(key.slice(0, root.length)).not.toEqual([...root])
    }
    // Anti-vacuity: the comparison can fail — the plans list key IS under the root.
    expect(plansQueryKeys.lists().slice(0, root.length)).toEqual([...root])
    // The search key lives under its plan's subscriptions, so the plan's keys can be dropped together.
    expect(planMigrationQueryKeys.subscriptions('p', 'alice').slice(0, 4)).toEqual([
      ...planMigrationQueryKeys.subscriptionsOfPlan('p'),
    ])
  })
})

describe('readPlanSubscriptionsPage', () => {
  it('keeps every field as sent, both unlimited encodings included', () => {
    expect(readPlanSubscriptionsPage(wirePage())).toEqual({
      total: 3,
      matched: 1,
      items: [
        {
          subscriptionId: 'sub-1',
          user: { id: 'user-1', name: 'Alice', username: null, telegramId: '4242', email: null },
          status: 'ACTIVE',
          isTrial: false,
          expiresAt: '2030-01-01T00:00:00.000Z',
          remnawaveLinked: true,
          limits: { trafficLimit: 0, deviceLimit: -1, internalSquads: ['sq-1'], externalSquad: null },
          ownership: {
            trafficLimit: 'INHERITED',
            deviceLimit: 'INDIVIDUAL',
            squads: 'UNKNOWN',
            internalSquads: 'UNKNOWN',
            externalSquad: 'INHERITED',
          },
          flags: { pendingRenewalForPlan: false, scheduledTermOnPlan: true, sharedPanelProfile: false },
        },
      ],
      nextCursor: 'cursor-2',
    })
    const unlimited = wireItem()
    unlimited.limits = { trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: 'sq-x' }
    unlimited.user = null
    const [item] = readPlanSubscriptionsPage(wirePage(unlimited)).items
    expect(item.limits.trafficLimit).toBeNull()
    expect(item.limits.deviceLimit).toBe(0)
    expect(item.user).toBeNull()
  })

  it('keeps a status this build has no words for', () => {
    const item = wireItem()
    item.status = 'SUSPENDED_BY_PANEL'
    expect(readPlanSubscriptionsPage(wirePage(item)).items[0].status).toBe('SUSPENDED_BY_PANEL')
  })

  it.each<[string, (page: Record<string, unknown>, item: Record<string, unknown>) => void]>([
    ['a page without items', (page) => Object.assign(page, { items: undefined })],
    ['a total that is a string', (page) => Object.assign(page, { total: '3' })],
    ['a negative matched count', (page) => Object.assign(page, { matched: -1 })],
    ['an empty cursor', (page) => Object.assign(page, { nextCursor: '' })],
    ['an item without an id', (_page, item) => Object.assign(item, { subscriptionId: '' })],
    ['a traffic limit below zero', (_page, item) => Object.assign(item, { limits: { ...(item.limits as object), trafficLimit: -5 } })],
    ['a fractional device limit', (_page, item) => Object.assign(item, { limits: { ...(item.limits as object), deviceLimit: 1.5 } })],
    ['a squad list that is a string', (_page, item) => Object.assign(item, { limits: { ...(item.limits as object), internalSquads: 'sq-1' } })],
    ['flags without the shared-profile flag', (_page, item) => Object.assign(item, { flags: { pendingRenewalForPlan: false, scheduledTermOnPlan: false } })],
    ['an ownership value that is not a string', (_page, item) => Object.assign(item, { ownership: { squads: 1 } })],
    ['a user without an id', (_page, item) => Object.assign(item, { user: { name: 'Alice' } })],
    ['a telegram id sent as a number', (_page, item) => Object.assign(item, { user: { id: 'u', name: null, username: null, telegramId: 4242, email: null } })],
    ['isTrial as a string', (_page, item) => Object.assign(item, { isTrial: 'false' })],
  ])('throws on %s', (_label, corrupt) => {
    const item = wireItem()
    const page = wirePage(item)
    corrupt(page, item)
    expect(() => readPlanSubscriptionsPage(page)).toThrow(MALFORMED)
  })

  it('throws on a body that is not a page at all', () => {
    for (const body of [null, [], 'soon', { items: [] }]) {
      expect(() => readPlanSubscriptionsPage(body)).toThrow(MALFORMED)
    }
  })
})

describe('readPlanMigrationPreview', () => {
  it('reads the summary, both snapshots, the kept fields and unknown warning codes as sent', () => {
    const preview = readPlanMigrationPreview(wirePreview())
    expect(preview.summary).toEqual([
      { targetPlanId: 'plan-a', count: 1, skipped: 0, warnings: wireWarningCounts({ FEWER_DEVICES: 1 }) },
    ])
    expect(preview.rows[0]).toEqual({
      subscriptionId: 'sub-1',
      targetPlanId: 'plan-a',
      user: { id: 'user-1', name: null, username: 'alice', telegramId: null, email: null },
      before: { trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null, isTrial: true },
      after: { trafficLimit: 0, deviceLimit: 2, internalSquads: [], externalSquad: null, isTrial: false },
      kept: ['squads'],
      warnings: ['FEWER_DEVICES', 'SOMETHING_NEW'],
      willSkip: null,
      pushesToRemnawave: true,
    })
  })

  it('reads a later page’s summary as null (§9 A3), and throws on a summary that is neither', () => {
    expect(readPlanMigrationPreview({ ...wirePreview(), summary: null, nextCursor: 'rows-3' })).toMatchObject({
      summary: null,
      nextCursor: 'rows-3',
    })
    expect(() => readPlanMigrationPreview({ ...wirePreview(), summary: undefined })).toThrow(MALFORMED)
    expect(() => readPlanMigrationPreview({ ...wirePreview(), summary: {} })).toThrow(MALFORMED)
  })

  // §9 A3: every row names its user — null for an id that names no subscription.
  it('reads the user every row carries, and throws on a row that carries none', () => {
    expect(readPlanMigrationPreview(wirePreview({ user: null })).rows[0].user).toBeNull()
    expect(
      readPlanMigrationPreview(
        wirePreview({ user: { id: 'u', name: 'Bob', username: 'bob', telegramId: null, email: null } }),
      ).rows[0].user,
    ).toEqual({ id: 'u', name: 'Bob', username: 'bob', telegramId: null, email: null })
    const { user: _user, ...withoutUser } = (wirePreview().rows as Record<string, unknown>[])[0]
    expect(() => readPlanMigrationPreview({ ...wirePreview(), rows: [withoutUser] })).toThrow(MALFORMED)
  })

  it('does not let a warning count keyed "__proto__" replace the prototype', () => {
    const body = JSON.parse(
      '{"summary":[{"targetPlanId":"plan-a","count":1,"skipped":0,"warnings":{"__proto__":2}}],"rows":[],"nextCursor":null}',
    )
    const [entry] = readPlanMigrationPreview(body).summary ?? []
    expect(Object.getPrototypeOf(entry.warnings)).toBe(Object.prototype)
    expect(Object.entries(entry.warnings)).toEqual([['__proto__', 2]])
  })

  it.each<[string, Record<string, unknown>]>([
    ['rows that are not a list', { rows: 'soon' }],
    ['a summary warning count that is not a number', { summary: [{ targetPlanId: 'a', count: 1, skipped: 0, warnings: { FEWER_DEVICES: '1' } }] }],
    ['a summary without a target', { summary: [{ count: 1, skipped: 0, warnings: {} }] }],
    ['a summary without its skipped count', { summary: [{ targetPlanId: 'a', count: 1, warnings: {} }] }],
  ])('throws on %s', (_label, overrides) => {
    expect(() => readPlanMigrationPreview({ ...wirePreview(), ...overrides })).toThrow(MALFORMED)
  })

  it.each<[string, Record<string, unknown>]>([
    ['a snapshot without isTrial', { before: { trafficLimit: null, deviceLimit: 0, internalSquads: [], externalSquad: null } }],
    ['an empty skip reason', { willSkip: '' }],
    ['kept as a string', { kept: 'squads' }],
    ['pushesToRemnawave missing', { pushesToRemnawave: undefined }],
  ])('throws on a row with %s', (_label, row) => {
    expect(() => readPlanMigrationPreview(wirePreview(row))).toThrow(MALFORMED)
  })
})

describe('readPlanMigrationRunStatus', () => {
  it('reads the totals, the sync totals, the problems and whether it finished', () => {
    expect(readPlanMigrationRunStatus(wireStatus())).toEqual({
      runId: 'run-1',
      status: 'RUNNING',
      totals: { total: 3, pending: 1, moved: 1, skipped: 0, failed: 1, skippedByReason: {} },
      sync: { total: 1, pending: 1, completed: 0, failed: 0 },
      problems: [
        {
          subscriptionId: 'sub-2',
          user: null,
          targetPlanId: 'plan-a',
          kind: 'MOVE_FAILED',
          reason: 'INTERNAL_ERROR',
          detail: 'deadlock',
        },
      ],
      problemsCursor: null,
      finished: false,
    })
  })

  it('reads the skips by reason as sent (§9 A2)', () => {
    const status = readPlanMigrationRunStatus(
      wireStatus({
        totals: {
          total: 5,
          pending: 0,
          moved: 2,
          skipped: 3,
          failed: 0,
          skippedByReason: { NOT_ON_SOURCE_PLAN: 2, SHARED_PROFILE_TWIN_BLOCKED: 1 },
        },
      }),
    )
    expect(status.totals.skippedByReason).toEqual({ NOT_ON_SOURCE_PLAN: 2, SHARED_PROFILE_TWIN_BLOCKED: 1 })
  })

  it.each<[string, Record<string, unknown>]>([
    ['finished as a string', { finished: 'true' }],
    ['finished missing', { finished: undefined }],
    ['totals without pending', { totals: { total: 3, moved: 1, skipped: 0, failed: 1, skippedByReason: {} } }],
    ['totals without skippedByReason', { totals: { total: 3, pending: 0, moved: 1, skipped: 0, failed: 1 } }],
    [
      'a skip count by reason that is not a number',
      { totals: { total: 3, pending: 0, moved: 1, skipped: 1, failed: 1, skippedByReason: { SCHEDULED_TERM: '1' } } },
    ],
    ['a negative sync count', { sync: { total: 1, pending: -1, completed: 0, failed: 0 } }],
    ['problems that are not a list', { problems: {} }],
    ['a problem without a reason', { problems: [{ subscriptionId: 's', user: null, targetPlanId: 'p', kind: 'MOVE_FAILED', detail: null }] }],
    ['an empty problems cursor', { problemsCursor: '' }],
    ['no run id', { runId: undefined }],
  ])('throws on %s', (_label, overrides) => {
    expect(() => readPlanMigrationRunStatus(wireStatus(overrides))).toThrow(MALFORMED)
  })
})

describe('the small bodies', () => {
  it('reads the current run, telling "no run" from an answer that says nothing', () => {
    expect(readPlanMigrationCurrent({ runId: 'run-7' })).toEqual({ runId: 'run-7' })
    expect(readPlanMigrationCurrent({ runId: null })).toEqual({ runId: null })
    for (const body of [{}, { runId: '' }, { runId: 7 }, null, []]) {
      expect(() => readPlanMigrationCurrent(body)).toThrow(MALFORMED)
    }
  })

  it('reads the 202 of a start and of a retry, and throws without a run id', () => {
    expect(readPlanMigrationStarted({ runId: 'run-1', totalItems: 12 })).toEqual({ runId: 'run-1', totalItems: 12 })
    expect(() => readPlanMigrationStarted({ runId: 'run-1' })).toThrow(MALFORMED)
    expect(() => readPlanMigrationStarted({ totalItems: 1 })).toThrow(MALFORMED)
    expect(readPlanMigrationRetry({ runId: 'run-1' })).toEqual({ runId: 'run-1' })
    expect(() => readPlanMigrationRetry({})).toThrow(MALFORMED)
  })

  it('reads squad options, and throws on one without a name', () => {
    expect(readSquadOptions([{ uuid: 'sq-1', name: 'Europe' }])).toEqual([{ uuid: 'sq-1', name: 'Europe' }])
    expect(() => readSquadOptions([{ uuid: 'sq-1' }])).toThrow(MALFORMED)
    expect(() => readSquadOptions({ items: [] })).toThrow(MALFORMED)
  })
})

describe('what the fetchers send', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const ok = (data: unknown): AxiosResponse => ({ data, status: 200, statusText: 'OK', headers: {}, config: {} as never })

  it('asks for the first page with the limit alone, and adds search and cursor only when they carry something', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(ok(wirePage()))
    await fetchPlanSubscriptionsPage('plan/1', { search: '', cursor: null, limit: 50 })
    await fetchPlanSubscriptionsPage('plan/1', { search: 'alice', cursor: 'cursor-2' })
    expect(get.mock.calls.map(([url, config]) => [url, (config as { params?: unknown }).params])).toEqual([
      ['/admin/plans/plan%2F1/subscriptions', { limit: 50 }],
      ['/admin/plans/plan%2F1/subscriptions', { limit: 50, search: 'alice', cursor: 'cursor-2' }],
    ])
    // No timeout of its own unless asked: the client-wide one applies.
    expect(get.mock.calls.map(([, config]) => 'timeout' in (config as object))).toEqual([false, false])
  })

  // Delete waits for these two as the dialog opens; the references next door get 10 s too.
  it('gives the lookups the dialog opens with 10 seconds when asked, and only then', async () => {
    expect(PLAN_MIGRATION_LOOKUP_TIMEOUT_MS).toBe(10_000)
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(ok(wirePage())).mockResolvedValue(ok({ runId: null }))
    await fetchPlanSubscriptionsPage('plan-1', { limit: 50, timeout: PLAN_MIGRATION_LOOKUP_TIMEOUT_MS })
    await fetchPlanMigrationCurrent('plan-1', undefined, PLAN_MIGRATION_LOOKUP_TIMEOUT_MS)
    // After a start that got no verdict, the answer is worth the client-wide wait.
    await fetchPlanMigrationCurrent('plan-1')
    expect(get.mock.calls.map(([url, config]) => [url, (config as { timeout?: unknown }).timeout])).toEqual([
      ['/admin/plans/plan-1/subscriptions', 10_000],
      ['/admin/plans/plan-1/migrations/current', 10_000],
      ['/admin/plans/plan-1/migrations/current', undefined],
    ])
  })

  // A start or a retry the client gave up on at 30 s can still commit on a large plan (§9 A6.2).
  it('gives the preview, the start and the retry 120 seconds, not the client-wide 30', async () => {
    expect(PLAN_MIGRATION_WRITE_TIMEOUT_MS).toBe(120_000)
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(ok(wirePreview()))
      .mockResolvedValueOnce(ok({ runId: 'run-1', totalItems: 1 }))
      .mockResolvedValueOnce(ok({ runId: 'run-1' }))
    const request = { groups: [{ targetPlanId: 'plan-a', subscriptionIds: ['sub-1'] }] }
    await previewPlanMigration('plan-1', request, { cursor: null, limit: 50 })
    await startPlanMigration('plan-1', request)
    await retryPlanMigration('plan-1', 'run-1', 'failed')
    expect(post.mock.calls.map(([url, body, config]) => [url, body, (config as { timeout?: unknown }).timeout])).toEqual([
      ['/admin/plans/plan-1/migrations/preview', { ...request, limit: 50 }, 120_000],
      ['/admin/plans/plan-1/migrations', request, 120_000],
      ['/admin/plans/plan-1/migrations/run-1/retry', { scope: 'failed' }, 120_000],
    ])
  })

  it('pages the preview through the body and the problems through the query', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok(wirePreview()))
    const request = { groups: [{ targetPlanId: 'plan-a', subscriptionIds: ['sub-1'] }], restTargetPlanId: 'plan-b' }
    await previewPlanMigration('plan-1', request, { cursor: null, limit: 50 })
    await previewPlanMigration('plan-1', request, { cursor: 'rows-2', limit: 50 })
    expect(post.mock.calls.map(([url, body]) => [url, body])).toEqual([
      ['/admin/plans/plan-1/migrations/preview', { ...request, limit: 50 }],
      ['/admin/plans/plan-1/migrations/preview', { ...request, cursor: 'rows-2', limit: 50 }],
    ])

    const get = vi.spyOn(api, 'get').mockResolvedValue(ok(wireStatus()))
    await fetchPlanMigrationRunStatus('plan-1', 'run-1', {})
    await fetchPlanMigrationRunStatus('plan-1', 'run-1', { problemsCursor: 'problems-2' })
    expect(get.mock.calls.map(([url, config]) => [url, (config as { params?: unknown }).params])).toEqual([
      ['/admin/plans/plan-1/migrations/run-1', undefined],
      ['/admin/plans/plan-1/migrations/run-1', { problemsCursor: 'problems-2' }],
    ])
  })

  it('asks for the current run without parameters', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(ok({ runId: null }))
    await expect(fetchPlanMigrationCurrent('plan-1')).resolves.toEqual({ runId: null })
    expect(get.mock.calls.map(([url, config]) => [url, (config as { params?: unknown }).params])).toEqual([
      ['/admin/plans/plan-1/migrations/current', undefined],
    ])
  })
})
