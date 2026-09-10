/**
 * How long an expiry warning may stay showable, against the warnings themselves.
 *
 * A pop-up is QUEUED when the event arrives and stays showable for its
 * `ttlHours` — the customer has to open the cabinet for it to be drawn, so the
 * TTL is the window between "we were told" and "we stop saying it".
 *
 * Remnawave sends its expiry warnings at fixed distances and the panel forwards
 * every one of them under a single type, so a template bound to that type is
 * bound to ALL of them. The last warning is what sets the ceiling: keep a hint
 * raised at the 24-hour mark showable for 48 and the customer meets "your
 * subscription ends soon" a full day after it ended — while the expired
 * template, which shares its group, says the opposite.
 *
 * The ceiling is PARSED OUT OF THE SERVER'S OWN ROUTING TABLE rather than
 * written here as 24. Remnawave adding an `expires_in_12_hours` — or the panel
 * dropping the 24-hour key — moves the ceiling, and this file is the only place
 * that would notice.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { HINT_TEMPLATES } from './hint-templates'

const WEBHOOK = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'src',
    'modules',
    'remnawave',
    'services',
    'remnawave-webhook.service.ts',
  ),
  'utf8',
)

/** Every `user.expires_in_N_hours` the panel routes to the expire-soon type. */
const WARNING_HOURS: readonly number[] = Array.from(
  WEBHOOK.matchAll(
    /'user\.expires_in_(\d+)_hours':\s*\{\s*type:\s*EVENT_TYPES\.REMNAWAVE_USER_EXPIRE_SOON/g,
  ),
  (match) => Number(match[1]),
)

describe('the expiry warnings the panel forwards', () => {
  it('were found in the server source at all', () => {
    // Anti-emptiness anchor. A regex that matched nothing hands `Math.min` an
    // Infinity that every TTL satisfies, and the rule below would guard air.
    expect(WARNING_HOURS.length).toBeGreaterThanOrEqual(3)
    expect(WARNING_HOURS).toContain(24)
  })
})

describe('a ready-made pop-up bound to the expiry warning', () => {
  const ceiling = Math.min(...WARNING_HOURS)
  const warnings = HINT_TEMPLATES.filter(
    (template) => template.triggerSpec === 'remnawave.user.expire_soon',
  )

  it('exists', () => {
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('never outlives the subscription it is about', () => {
    const overrun = warnings
      .filter((template) => template.ttlHours > ceiling)
      .map((template) => `${template.id}: ${template.ttlHours}h > ${ceiling}h`)

    expect(overrun).toEqual([])
  })

  it('is not so short that the warning cannot be read', () => {
    // The other direction, which matters because the fix for the above is a
    // number: a one-hour window means only a customer already looking at the
    // cabinet ever sees it, and the pop-up quietly becomes decoration.
    for (const template of warnings) {
      expect(template.ttlHours, template.id).toBeGreaterThanOrEqual(12)
    }
  })
})

describe('the pop-up for a subscription that already ended', () => {
  it('may outlive the deadline, because its subject is the deadline passing', () => {
    // Deliberately NOT held to the ceiling above, and stated here so the rule
    // is not "tightened" onto it later. "Your subscription has ended" is still
    // true a week later; "it ends soon" is not true an hour later.
    const expired = HINT_TEMPLATES.find((template) => template.id === 'subscription_expired')
    expect(expired?.ttlHours).toBeGreaterThan(Math.min(...WARNING_HOURS))
  })
})
