/**
 * WHAT THESE SPECS PIN.
 *
 *   1. The CODE decides, not the sentence. Asserted in both directions: a
 *      recognised code under a reworded message still branches, and the
 *      backend's exact sentence under an unrecognised code does not.
 *   2. `code` first, `errorCode` as the fallback. `AdminSafeExceptionFilter`
 *      writes the product code into `errorCode` unconditionally and adds `code`
 *      only when the thrown body carried one — but `errorCode` also carries the
 *      generic status mapping when there was no product code at all. Read only
 *      `code` and every refusal from an older build is lost; read only
 *      `errorCode` and `BAD_REQUEST` starts looking like a product code.
 *   3. An UNKNOWN code falls through to the server's own message. A rolling
 *      deploy will put a newer backend behind this panel, and collapsing its
 *      new code into a generic sentence takes away the only thing that says
 *      which of seventeen refusals happened.
 *   4. Every code the backend defines has a row here. Enforced against the
 *      backend's own frozen table, from the test side.
 *
 * NO DATE LITERALS anywhere below, and none may be added — see the note in
 * `plan-transition-targets.test.ts`.
 */
import { describe, expect, it } from 'vitest'

// ACROSS THE PACKAGE BOUNDARY, from a test, deliberately — the same move
// `subscription-sync-outcome.test.tsx` and `subscription-delete-stale-link.test.tsx`
// make. Comparing the panel's literals against a second COPY of the backend's
// table would reproduce the drift this guard exists to catch. That module
// imports nothing, so this costs no Nest or Prisma. `tsconfig.app.json`
// excludes tests so the production build never follows this import, and
// `build-isolation.test.ts` pins that arrangement.
import { PLAN_WRITE_REFUSAL_CODES } from '../../../../src/modules/plans/plan-write-refusal-codes'

import {
  PLAN_WRITE_REFUSAL_BY_CODE,
  PLAN_WRITE_REFUSAL_I18N_KEYS,
  readPlanWriteRefusal,
  readProductCode,
  readServerMessage,
  resolvePlanWriteRefusal,
  type PlanWriteRefusal,
} from './plan-write-refusals'

/** An axios-shaped rejection. Nothing here imports axios; the shape is all that matters. */
function rejection(body: unknown, status = 400): unknown {
  return { isAxiosError: true, response: { status, data: body } }
}

/**
 * The seventeen codes this build is written against, spelled out.
 *
 * A THIRD copy on purpose: the guard below asserts THIS list first and only
 * then that the module and the backend agree with it. An agreement-only
 * assertion between two implementations is green when both are wrong.
 */
const EXPECTED_CODES = [
  'PLAN_ALLOWED_USERS_NOT_FOUND',
  'PLAN_CURRENCY_DUPLICATE',
  'PLAN_DELETE_REFERENCED',
  'PLAN_DURATION_DUPLICATE',
  'PLAN_EXTERNAL_SQUAD_NOT_FOUND',
  'PLAN_INTERNAL_SQUADS_NOT_FOUND',
  'PLAN_NAME_TAKEN',
  'PLAN_SQUAD_VALIDATION_UNAVAILABLE',
  'PLAN_TRANSITION_RENEW_MODE_NOT_ARCHIVED',
  'PLAN_TRANSITION_REPLACEMENT_REQUIRED',
  'PLAN_TRANSITION_SELF_REFERENCE',
  'PLAN_TRANSITION_TARGET_NOT_ASSIGNABLE',
  'PLAN_TRANSITION_TARGET_NOT_FOUND',
  'PLAN_TRIAL_ALREADY_EXISTS',
  'PLAN_TRIAL_CONVERSION_FORBIDDEN',
  'PLAN_TRIAL_DURATION_COUNT',
  'PLAN_TRIAL_PRICE_REQUIRED',
]

describe('readProductCode', () => {
  it('prefers `code`, the field that is only ever a product code', () => {
    expect(readProductCode(rejection({ code: 'PLAN_NAME_TAKEN', errorCode: 'BAD_REQUEST' }))).toBe(
      'PLAN_NAME_TAKEN',
    )
  })

  // The filter writes the product code into `errorCode` unconditionally and
  // adds `code` only when the thrown body carried one, so this is the field
  // that is always present — and the only one an older build sends.
  it('falls back to `errorCode` when `code` is absent', () => {
    expect(readProductCode(rejection({ errorCode: 'PLAN_TRIAL_PRICE_REQUIRED' }))).toBe(
      'PLAN_TRIAL_PRICE_REQUIRED',
    )
  })

  it('returns null when neither field carries a usable string', () => {
    expect(readProductCode(rejection({}))).toBeNull()
    expect(readProductCode(rejection({ code: '', errorCode: '' }))).toBeNull()
    expect(readProductCode(rejection({ code: 42, errorCode: null }))).toBeNull()
    expect(readProductCode(rejection(null))).toBeNull()
    expect(readProductCode(rejection('plain text body'))).toBeNull()
  })

  it('returns null for anything that is not an axios-shaped rejection', () => {
    expect(readProductCode(null)).toBeNull()
    expect(readProductCode(undefined)).toBeNull()
    expect(readProductCode('boom')).toBeNull()
    expect(readProductCode(new Error('Network Error'))).toBeNull()
    expect(readProductCode({})).toBeNull()
  })

  // An empty `code` beside a real `errorCode` is the shape that breaks a naive
  // `record.code ?? record.errorCode`: `''` is neither null nor undefined.
  it('steps past an empty `code` to reach a real `errorCode`', () => {
    expect(readProductCode(rejection({ code: '', errorCode: 'PLAN_DELETE_REFERENCED' }))).toBe(
      'PLAN_DELETE_REFERENCED',
    )
  })
})

describe('readServerMessage', () => {
  it('reads the server’s own sentence', () => {
    expect(readServerMessage(rejection({ message: 'Duration 30 days is duplicated' }))).toBe(
      'Duration 30 days is duplicated',
    )
  })

  // `message` is `string | string[]` on the wire — the filter passes a
  // class-validator array through unchanged.
  it('joins an array message instead of rendering it as an object', () => {
    expect(readServerMessage(rejection({ message: ['name must be a string', 'name is required'] }))).toBe(
      'name must be a string name is required',
    )
  })

  it('returns null when there is no sentence to show', () => {
    expect(readServerMessage(rejection({}))).toBeNull()
    expect(readServerMessage(rejection({ message: '' }))).toBeNull()
    expect(readServerMessage(rejection({ message: [] }))).toBeNull()
    expect(readServerMessage(rejection({ message: 42 }))).toBeNull()
    expect(readServerMessage(new Error('Network Error'))).toBeNull()
  })
})

describe('readPlanWriteRefusal', () => {
  it('names the transition refusal that caused the production defect', () => {
    expect(
      readPlanWriteRefusal(rejection({ code: 'PLAN_TRANSITION_TARGET_NOT_ASSIGNABLE' })),
    ).toBe('transitionTargetNotAssignable')
  })

  // THE CODE DECIDES, NOT THE SENTENCE — asserted in both directions.
  it('branches on the code even when the message has been reworded', () => {
    expect(
      readPlanWriteRefusal(
        rejection({
          code: 'PLAN_TRIAL_ALREADY_EXISTS',
          message: 'somebody rewrote this sentence entirely',
        }),
      ),
    ).toBe('trialAlreadyExists')
  })

  it('does not branch on the backend’s exact sentence under an unrelated code', () => {
    expect(
      readPlanWriteRefusal(
        rejection({
          code: 'SOMETHING_ELSE_ENTIRELY',
          message: 'Only one active trial plan is allowed',
        }),
      ),
    ).toBeNull()
  })

  it('returns null for a failure with no product code at all', () => {
    expect(readPlanWriteRefusal(rejection({ errorCode: 'BAD_REQUEST', message: 'Bad Request' }))).toBeNull()
    expect(readPlanWriteRefusal(new Error('Network Error'))).toBeNull()
  })
})

describe('resolvePlanWriteRefusal', () => {
  it('hands the form a dictionary key for a code it knows', () => {
    expect(
      resolvePlanWriteRefusal(
        rejection({
          code: 'PLAN_TRANSITION_TARGET_NOT_ASSIGNABLE',
          message:
            'Replacement and upgrade plans must be active non-trial public plans: cmsxo98e8006r01jgn33gtpbe',
        }),
      ),
    ).toEqual({
      recognised: true,
      refusal: 'transitionTargetNotAssignable',
      i18nKey: 'planWriteRefusal.transitionTargetNotAssignable',
      serverMessage:
        'Replacement and upgrade plans must be active non-trial public plans: cmsxo98e8006r01jgn33gtpbe',
    })
  })

  // A ROLLING DEPLOY WILL PRODUCE CODES THIS BUILD DOES NOT KNOW. English the
  // operator has to puzzle over beats a generic sentence that says nothing.
  it('falls through to the server’s own message for an unknown code', () => {
    const resolution = resolvePlanWriteRefusal(
      rejection({
        code: 'PLAN_SOMETHING_ADDED_NEXT_RELEASE',
        message: 'Plan quota exceeded for this operator',
      }),
    )
    expect(resolution).toEqual({
      recognised: false,
      refusal: null,
      i18nKey: null,
      serverMessage: 'Plan quota exceeded for this operator',
    })
  })

  // The ONLY case where the caller may reach for its own generic copy.
  it('reports no message at all when the request never reached the server', () => {
    expect(resolvePlanWriteRefusal(new Error('Network Error'))).toEqual({
      recognised: false,
      refusal: null,
      i18nKey: null,
      serverMessage: null,
    })
  })
})

describe('the refusal table', () => {
  // Expected answer FIRST, agreement second. Asserting only that the two tables
  // match is green when both are wrong — which is exactly how the picker and
  // the server drifted apart in the defect this work exists to fix.
  it('carries a row for every code the backend defines, and no others', () => {
    expect([...EXPECTED_CODES].sort()).toEqual(EXPECTED_CODES)
    expect(EXPECTED_CODES).toHaveLength(17)
    expect([...PLAN_WRITE_REFUSAL_BY_CODE.keys()].sort()).toEqual(EXPECTED_CODES)
    expect([...Object.values(PLAN_WRITE_REFUSAL_CODES)].sort()).toEqual(EXPECTED_CODES)
  })

  it('maps every code to a distinct refusal kind', () => {
    const kinds = [...PLAN_WRITE_REFUSAL_BY_CODE.values()]
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('reserves one dictionary key per refusal kind, all distinct', () => {
    const kinds = [...PLAN_WRITE_REFUSAL_BY_CODE.values()].sort()
    expect(Object.keys(PLAN_WRITE_REFUSAL_I18N_KEYS).sort()).toEqual(kinds)
    const keys = Object.values(PLAN_WRITE_REFUSAL_I18N_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
    for (const [kind, key] of Object.entries(PLAN_WRITE_REFUSAL_I18N_KEYS)) {
      expect(key).toBe(`planWriteRefusal.${kind}`)
    }
  })

  // Every row is reachable end to end, not just present in a table.
  it('resolves every backend code to its own key through the public entry point', () => {
    for (const code of Object.values(PLAN_WRITE_REFUSAL_CODES)) {
      const resolution = resolvePlanWriteRefusal(rejection({ code }))
      expect(resolution.recognised).toBe(true)
      const refusal = resolution.refusal as PlanWriteRefusal
      expect(resolution.i18nKey).toBe(PLAN_WRITE_REFUSAL_I18N_KEYS[refusal])
    }
  })
})
