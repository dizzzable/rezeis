import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { HINT_TEMPLATES, HINT_TEMPLATE_STAGES, buildHint, buildHintAction } from './hint-templates'
import { ru } from '@/i18n/features/automations.ru'
import { en } from '@/i18n/features/automations.en'

/**
 * The ready-made pop-ups.
 *
 * A pop-up is two rows that have to agree: a hint, and a rule whose action
 * names it by key. Every failure below is silent at the moment it is made and
 * loud much later — in an execution log, after the moment the pop-up was about
 * has passed.
 */

const copy = (bundle: Record<string, unknown>, id: string): Record<string, string> =>
  ((bundle.automationsPage as Record<string, unknown>).hintTemplates as Record<string, unknown>)[
    id
  ] as Record<string, string>

const text = (key: string): string => {
  const path = key.split('.').slice(1)
  let node: unknown = ru.automationsPage
  for (const step of path) node = (node as Record<string, unknown>)[step]
  return typeof node === 'string' ? node : key
}

/**
 * The group of a template, by id — and a FAILURE when there is no such id.
 *
 * Read as "this template has no group" by every rule below. A lookup that
 * shrugs at a missing row makes a rename indistinguishable from the property
 * being right, which is how several of these cases came to guard nothing.
 */
const groupKeyOf = (id: string): string | undefined => {
  const template = HINT_TEMPLATES.find((candidate) => candidate.id === id)
  if (template === undefined) throw new Error(`no template with id "${id}"`)
  return template.groupKey
}

describe('a template builds both halves', () => {
  it('points the rule at the hint it just created', () => {
    // The one way to get this wrong produces a rule that fails at run time,
    // naming a key nothing answers to — long after the operator left the page.
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)
      const [action] = buildHintAction(template)

      expect(hint.key).toBe(template.hintKey)
      expect(action.type).toBe('show_hint')
      expect((action.params as { hintKey: string }).hintKey).toBe(hint.key)
    }
  })

  it('binds only to triggers the server calls pop-up capable', () => {
    // THIS CASE USED TO BE A PREFIX REGEX, and it certified four templates that
    // could never fire. `/^(payment|subscription|user|promocode)\./` is matched
    // by `subscription.expired` (declared, emitted from nowhere) and by
    // `user.expire_soon` (not an event type at all — a key of Remnawave's own
    // webhook map). A trigger nothing emits fails in silence: the rule is never
    // selected by the pattern filter, so there is no execution row, no error
    // and no log line, and it reads "enabled" for ever.
    //
    // The list is the SERVER's, parsed out of its source rather than restated —
    // a copy here would be one more thing free to drift, which is the shape of
    // the defect this replaces. The parse asserts it found something, so a
    // rename over there fails this file loudly instead of quietly checking
    // nothing. The server's own `popup-capable-events.spec.ts` checks the same
    // templates from the other side; this one exists so the SPA suite alone
    // catches a template added without one.
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..', '..', '..', '..',
        'src', 'modules', 'automations', 'popup-capable-events.ts',
      ),
      'utf8',
    )
    const capable = new Set(
      Array.from(source.matchAll(/^\s*type:\s*'([^']+)',$/gm), (match) => match[1]),
    )
    expect(capable.size, 'POPUP_CAPABLE_EVENTS was not parsed').toBeGreaterThanOrEqual(10)

    for (const template of HINT_TEMPLATES) {
      expect(capable.has(template.triggerSpec), `${template.id} -> ${template.triggerSpec}`).toBe(
        true,
      )
    }
  })

  it('gives every template a distinct key', () => {
    // Two templates sharing a key would have the second silently overwrite the
    // first's text — and the rule points at the key, so the operator who
    // applied the first would find their pop-up saying somebody else's words.
    //
    // Sharing a TRIGGER is a different matter and is allowed; see "never puts
    // two pop-ups on one trigger by accident" for which pairs do it, and why.
    expect(new Set(HINT_TEMPLATES.map((t) => t.hintKey)).size).toBe(HINT_TEMPLATES.length)
  })
})

describe('the pop-up an operator gets', () => {
  it('carries text in both languages, because it is shown to customers', () => {
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)

      for (const [field, value] of Object.entries({
        titleRu: hint.titleRu,
        bodyRu: hint.bodyRu,
        titleEn: hint.titleEn,
        bodyEn: hint.bodyEn,
      })) {
        expect((value ?? '').trim().length, `${template.id}.${field}`).toBeGreaterThan(0)
        expect(value, `${template.id}.${field} is an untranslated key`).not.toMatch(
          /^automationsPage\./,
        )
      }
    }
  })

  it('gives a button a target, and a pop-up without one no button', () => {
    // `ctaKind: ROUTE` with no target renders a button that goes nowhere.
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)

      if (template.route === null) {
        expect(hint.ctaKind, template.id).toBe('NONE')
        expect(hint.ctaTarget).toBeUndefined()
      } else {
        expect(hint.ctaKind, template.id).toBe('ROUTE')
        expect(hint.ctaTarget).toBe(template.route)
        expect((hint.ctaLabelRu ?? '').length, template.id).toBeGreaterThan(0)
      }
    }
  })

  it('only sends people to routes the SERVER accepts', () => {
    // READ FROM THE DTO, not retyped here — and the difference was a defect in
    // this case rather than a hypothetical. The hand-written set it replaces
    // held five paths and included `/subscription/connect`, which
    // `HINT_ROUTE_TARGETS` deliberately EXCLUDES: whether a customer lands on
    // the internal connect screen or is sent to the external subscription page
    // is one operator switch, and a hint button calls `navigate()` straight
    // past it. So this guard would have waved through a template the server
    // refuses with a 400 — the exact class of second-copy disagreement the
    // pop-up work has spent its time removing.
    const dto = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/modules/user-hints/dto/user-hint.dto.ts'),
      'utf8',
    )
    const block = /export const HINT_ROUTE_TARGETS = \[([\s\S]*?)\] as const/.exec(dto)
    expect(block, 'HINT_ROUTE_TARGETS is gone from the DTO').not.toBeNull()
    const known = new Set(
      // Whole lines that are nothing but a quoted path. The list carries a long
      // comment about why `/subscription/connect` is absent, and an apostrophe
      // in English prose — "the operator's decision" — reads as a quote to
      // anything looser than this.
      Array.from(
        (block as RegExpExecArray)[1].matchAll(/^\s*'(\/[a-z0-9/-]*)',\s*$/gm),
        (match) => match[1],
      ),
    )

    // Anti-emptiness anchor: a set of one would fail every template below
    // rather than pass it, but a set built from the wrong block might not.
    expect(known.size).toBeGreaterThan(8)
    for (const template of HINT_TEMPLATES) {
      if (template.route === null) continue
      expect(known.has(template.route), `${template.id} → ${template.route}`).toBe(true)
    }
  })

  it('never puts two pop-ups on one trigger by accident', () => {
    // Sharing a trigger IS allowed, and four pairs do it on purpose: two ways
    // to answer a failed payment, a loud and a quiet expiry warning, a renewal
    // prompt and a win-back offer, a modal and a toast for a promo code. They
    // are ALTERNATIVES — an operator enables one of each pair — and the
    // collision panel says so out loud if both rules end up enabled.
    //
    // What must not happen is an accidental fifth: a trigger carrying two
    // templates nobody meant to pair. So the pairs are listed, and a new
    // collision has to be added here deliberately.
    const byTrigger = new Map<string, string[]>()
    for (const template of HINT_TEMPLATES) {
      byTrigger.set(template.triggerSpec, [
        ...(byTrigger.get(template.triggerSpec) ?? []),
        template.id,
      ])
    }
    const shared = [...byTrigger.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([trigger, ids]) => `${trigger}: ${ids.slice().sort().join(' + ')}`)
      .sort()

    expect(shared).toEqual([
      'payment.failed: payment_failed + payment_failed_method',
      'promocode.activated: promocode_activated + promocode_activated_quiet',
      'remnawave.user.expire_soon: expire_soon + expire_soon_quiet',
      'remnawave.user.expired: expired_comeback + subscription_expired',
    ])
  })

  it('puts every template in a stage the page can label', () => {
    // The library is rendered stage by stage. A template whose stage has no
    // heading is not shown at all — it does not fall to the bottom of a list,
    // because there is no list any more.
    const stages = (
      (ru.automationsPage as unknown as Record<string, Record<string, unknown>>).hintTemplates
        .stages ?? {}
    ) as Record<string, string>
    for (const template of HINT_TEMPLATES) {
      expect(HINT_TEMPLATE_STAGES, template.id).toContain(template.stage)
      expect(
        (stages[template.stage] ?? "").length,
        `stage ${template.stage} has no heading`,
      ).toBeGreaterThan(0)
    }
  })

  it('fills every stage, so no heading renders empty', () => {
    // The other direction: a stage nothing belongs to is a heading with
    // nothing under it. The page skips those, and a vocabulary carrying a
    // stage no template uses is a decision somebody abandoned half way.
    for (const stage of HINT_TEMPLATE_STAGES) {
      expect(
        HINT_TEMPLATES.some((template) => template.stage === stage),
        `nothing is in stage ${stage}`,
      ).toBe(true)
    }
  })

  it('repeats what is about an event and not what is about a person', () => {
    // "Your payment failed" is about this payment. "Welcome" is about the
    // person, and showing it twice says the product forgot them. So does
    // "you are connected": a first connection happens once by definition, and
    // a product that celebrates it every week is not paying attention.
    const once = HINT_TEMPLATES.filter((t) => !t.repeatable).map((t) => t.id)

    expect(once.sort()).toEqual([
      'first_connected',
      'first_traffic_devices',
      'trial_granted',
      'welcome',
      'welcome_web',
    ])
  })
})

describe('the copy exists in both bundles', () => {
  it('has every field the builder reads, in ru and en', () => {
    // The bundle-parity test compares key sets, so a field missing from BOTH
    // bundles passes it and reaches an operator as the raw key.
    for (const template of HINT_TEMPLATES) {
      for (const bundle of [ru, en] as unknown as Array<Record<string, unknown>>) {
        const fields = copy(bundle, template.id)
        expect(fields, template.id).toBeDefined()
        for (const field of ['name', 'description', 'titleRu', 'bodyRu', 'titleEn', 'bodyEn']) {
          expect((fields[field] ?? '').trim().length, `${template.id}.${field}`).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('a pop-up that can arrive more than once', () => {
  /**
   * THE THREE-DEEP MODAL.
   *
   * Remnawave sends `expires_in_72_hours`, then `_48`, then `_24`, and the
   * panel forwards all three — plus `user.expiration` — under the one type
   * `remnawave.user.expire_soon`. A repeatable hint with no group turns each of
   * them into its own `UserHintDelivery` row, and nothing collapses them: a
   * customer away for three days opens the cabinet to three identical renewal
   * modals, dismissing two that are about a deadline that has already moved.
   *
   * Supersession is the mechanism that stops it and it is keyed ONLY on
   * `groupKey`, so a template that omits one opts out silently.
   */
  it('carries a group, so a newer one replaces an unshown older one', () => {
    const stacking = HINT_TEMPLATES.filter(
      (template) => template.repeatable && template.groupKey === undefined,
    ).map((template) => template.id)

    expect(stacking.sort()).toEqual([
      // ONE LEFT, and deliberately. A fraud signal is opened once per
      // investigation and a second one is a different fact — grouping it would
      // let the second erase an unread first.
      //
      // Everything else that repeats now carries a group, including the
      // alternatives. Each has its OWN, never its partner's: a pair must not
      // depend on which half raised last, and across modes a MODAL lapsing a
      // TOAST destroys the one a cabinet drawing only modals could have shown.
      'fraud_signal',
    ])
  })

  it('reads the expiry clock as one fact', () => {
    // Shared, not merely present: a warning still queued when the subscription
    // finally expires has to lose to the newer reading. Two separate keys would
    // leave both queued.
    const expiry = HINT_TEMPLATES.filter(
      (template) => template.groupKey === 'subscription-expiry',
    ).map((template) => template.id)

    expect(expiry.sort()).toEqual(['expire_soon', 'subscription_expired'])
  })

  it('never puts two pop-ups that fire for one act in one group', () => {
    // THE DEFECT THIS REPLACED. `subscription.trial_granted` and
    // `subscription.created` are emitted one line apart in the sync processor
    // for a single provisioning, and `automations.constants.ts` declares them a
    // coincident pair. Grouped together, whichever `raise()` landed second —
    // and the order is decided nowhere — lapsed the other. When the loser was
    // the trial toast the loss was permanent: it is `repeatable: false`, and a
    // lapsed row still counts as a prior delivery, so it could never be queued
    // again for that customer.

    // Both may have a group; neither may have the SAME one, and `undefined ===
    // undefined` must not read as agreement — nor may a renamed id, which is
    // why this looks the row up and fails when it is missing.
    const trial = groupKeyOf('trial_granted')
    const created = groupKeyOf('subscription_created')

    expect(trial === undefined || created === undefined || trial !== created).toBe(true)
  })

  it('keeps traffic out of that group', () => {
    // Being low on traffic and being close to expiry are two different facts
    // and a person can be in both; collapsing them would silence one.
    //
    // Asserted as "not the expiry group" rather than as one literal string,
    // which is what this case always meant. Pinning `traffic-usage` made it a
    // second, silent opinion about how the traffic templates are grouped — and
    // it disagreed with the coincidence guard below, which is the one that
    // decides. Every traffic template is checked now, not just the first.
    const traffic = HINT_TEMPLATES.filter((template) =>
      ['traffic_running_out', 'traffic_exhausted', 'traffic_reset'].includes(template.id),
    )

    const EXPIRY_GROUPS = HINT_TEMPLATES.filter((template) =>
      ['expire_soon', 'expire_soon_quiet', 'subscription_expired'].includes(template.id),
    ).map((template) => template.groupKey)

    expect(traffic.length, 'the traffic templates were renamed').toBe(3)
    expect(EXPIRY_GROUPS.length, 'the expiry templates were renamed').toBe(3)
    for (const template of traffic) {
      expect(template.groupKey, template.id).toBeDefined()
      expect(EXPIRY_GROUPS, template.id).not.toContain(template.groupKey)
    }
  })

  it('sends the group to the server, within the field it accepts', () => {
    // The builder is where this reaches the API, and the DTO caps the field at
    // 64 characters — over that the whole hint is refused with a 400 and the
    // template cannot be applied at all.
    for (const template of HINT_TEMPLATES) {
      const hint = buildHint(template, text)

      expect(hint.groupKey, template.id).toBe(template.groupKey)
      expect((template.groupKey ?? '').length, template.id).toBeLessThanOrEqual(64)
    }
  })
})

describe('two templates that fire for one act', () => {
  /**
   * The file's own rule, applied to itself.
   *
   * `first_connected` and `first_traffic_devices` shared a group AND were both
   * `repeatable: false` — the unrecoverable combination the header spells out.
   * The webhook handler emits `user.first_traffic` and then
   * `remnawave.user.first_connected` inside one `handleEvent`, so whichever
   * `raise()` landed second lapsed the other, and a lapsed row still counts as
   * a prior delivery: the loser could never be queued for that customer again.
   */
  const groupOf = groupKeyOf

  it('never lets a once-only template share a group with anything', () => {
    // The general form. A `repeatable: false` hint has exactly one delivery
    // ever, so a group can only take it away — there is nothing to collapse.
    const grouped = HINT_TEMPLATES.filter(
      (template) => !template.repeatable && template.groupKey !== undefined,
    ).map((template) => template.id)

    expect(grouped).toEqual([])
  })

  it('keeps the two first-connection templates apart', () => {
    expect(groupOf('first_connected')).toBeUndefined()
    expect(groupOf('first_traffic_devices')).toBeUndefined()
  })

  it('gives each half of an alternative pair its own group, never a shared one', () => {
    // A pair must not depend on which half raised last — and across modes it is
    // worse than arbitrary: a MODAL lapsing a TOAST destroys the one a cabinet
    // drawing only modals could actually have shown.
    const PAIRS = [
      ['payment_failed', 'payment_failed_method'],
      ['expire_soon', 'expire_soon_quiet'],
      ['subscription_expired', 'expired_comeback'],
      ['promocode_activated', 'promocode_activated_quiet'],
    ]

    for (const [left, right] of PAIRS) {
      const a = groupOf(left)
      const b = groupOf(right)
      expect(a === undefined || b === undefined || a !== b, `${left} / ${right}`).toBe(true)
    }
  })

  it('groups every repeatable template that a single act can emit twice', () => {
    // `promocode.activated` is emitted from a catch AND on the normal path when
    // the reward's sync enqueue fails, and the bridge dispatches on type alone.
    // A Redis blip during one redemption was two identical modals.
    for (const id of ['promocode_activated', 'promocode_activated_quiet']) {
      expect(groupOf(id), id).toBeDefined()
    }
  })

  /**
   * THE GENERAL FORM, AGAINST THE SERVER'S OWN LIST.
   *
   * The four cases above name their pairs by hand, which is how the traffic
   * pair went unnoticed for as long as it did: `traffic_running_out` and
   * `traffic_exhausted` sit on two DIFFERENT triggers, so no "same trigger"
   * check saw them — and `automations.constants.ts` declares those two triggers
   * coincident, which makes them one act by one customer exactly like a pair
   * that shares a trigger.
   *
   * Supersession is unconditional and the order is decided nowhere, so a shared
   * group between them is a coin toss over which pop-up the customer loses. The
   * one that survived could be the TOAST that says nothing is broken yet, while
   * the MODAL carrying the button was lapsed unshown.
   *
   * The list is READ FROM THE SERVER rather than restated, for the reason every
   * other cross-boundary parse in this feature is: a copy of it here would be
   * free to drift, and whether two events arrive together is a fact about the
   * flows this product runs, which nothing in the type system knows.
   */
  const COINCIDENT_GROUPS = (() => {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..', '..', '..', '..',
        'src', 'modules', 'automations', 'automations.constants.ts',
      ),
      'utf8',
    )
    // COMMENTS FIRST, and this is not hygiene. The declaration is followed by a
    // paragraph explaining that `['user.registered', 'user.web_registered']`
    // USED TO BE THERE and was removed — written out in full, in backticks. A
    // parse that reads the raw text resurrects the one group somebody deleted
    // on purpose, and then certifies the templates against it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const start = code.indexOf('COINCIDENT_EVENT_GROUPS')
    expect(start, 'COINCIDENT_EVENT_GROUPS is gone from the server constants').toBeGreaterThan(-1)
    // From the `=`, not from the name: the TYPE between the two carries
    // `string[]`, and the first bracket after the name is that one.
    const assignment = code.indexOf('=', start)
    expect(assignment, 'COINCIDENT_EVENT_GROUPS is no longer an assignment').toBeGreaterThan(-1)
    const open = code.indexOf('[', assignment)
    let depth = 0
    let end = open
    for (; end < code.length; end += 1) {
      if (code[end] === '[') depth += 1
      else if (code[end] === ']') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = code.slice(open + 1, end)
    return [...body.matchAll(/\[([^\]]*)\]/g)].map((match) =>
      [...match[1]!.matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]!),
    )
  })()

  it('reads the coincident groups the server actually declares', () => {
    // Anti-vacuity. A parse that came back empty — or that swallowed the
    // removed group out of a comment — would make the case below agree with
    // everything, which is the failure mode this whole feature keeps hitting.
    expect(COINCIDENT_GROUPS.length, 'no coincident groups were parsed').toBeGreaterThanOrEqual(5)
    expect(
      COINCIDENT_GROUPS.some(
        (group) =>
          group.includes('remnawave.user.bandwidth_threshold') &&
          group.includes('remnawave.user.limited'),
      ),
      'the traffic pair is no longer declared coincident, so the guard below proves nothing',
    ).toBe(true)
    expect(
      COINCIDENT_GROUPS.some(
        (group) => group.includes('user.registered') && group.includes('user.web_registered'),
      ),
      'a group that lives only inside a comment was parsed as if it were live',
    ).toBe(false)
  })

  it('never lets two templates on coincident triggers share a group', () => {
    // A trigger is coincident with ITSELF, which is the strongest form of the
    // same rule and the one the hand-written pairs above cover; both shapes are
    // checked here so a fifth pair cannot appear without a decision.
    const triggers = [...new Set(HINT_TEMPLATES.map((template) => template.triggerSpec))]
    const acts = [...COINCIDENT_GROUPS, ...triggers.map((trigger) => [trigger])]

    const clashes: string[] = []
    for (const act of acts) {
      const involved = HINT_TEMPLATES.filter((template) => act.includes(template.triggerSpec))
      for (let i = 0; i < involved.length; i += 1) {
        for (let j = i + 1; j < involved.length; j += 1) {
          const left = involved[i]!
          const right = involved[j]!
          if (left.groupKey === undefined || right.groupKey === undefined) continue
          if (left.groupKey !== right.groupKey) continue
          clashes.push(`${left.id} + ${right.id} both on "${left.groupKey}" (${act.join(', ')})`)
        }
      }
    }

    expect([...new Set(clashes)]).toEqual([])
  })
})
