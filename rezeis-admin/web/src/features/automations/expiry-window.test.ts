/**
 * How long an expiry warning may stay showable, against the warnings themselves.
 *
 * A pop-up is QUEUED when the event arrives and stays showable for its
 * `ttlHours` — the customer has to open the cabinet for it to be drawn, so the
 * TTL is the window between "we were told" and "we stop saying it".
 *
 * Remnawave 3.x sends ONE expiry warning, `user.expiration`, at each of the
 * hours the operator set in Remnawave (`notifications.expirationNotifications`;
 * the hours ride in `meta.expiration`), and the panel forwards every one of them
 * under a single type, so a template bound to that type is bound to ALL of
 * them. The last warning is what sets the ceiling: keep a hint raised at the
 * 24-hour mark showable for 48 and the customer meets "your subscription ends
 * soon" a full day after it ended — while the expired template, which shares
 * its group, says the opposite.
 *
 * THE CEILING IS A STATED RULE NOW, not a number read out of the server. It used
 * to be parsed from the fixed `user.expires_in_{72,48,24}_hours` names Remnawave
 * 2.7.4 sent; those went with 2.x support, and the hours 3.x warns at live in
 * the operator's Remnawave settings, which the panel never reads. The
 * ready-made pop-ups are built for a last warning 24 hours before the end — the
 * mark those names had, and the one this file holds them to. What IS still read
 * from the server is that the warning reaches this type at all.
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

/** How close to the end the last warning the ready-made pop-ups are built for comes. */
const LAST_WARNING_HOURS = 24

describe('the expiry warning the panel forwards', () => {
  it('reaches the expire-soon type from the one name Remnawave 3.x sends', () => {
    // Anti-emptiness anchor: without this route no template below is ever
    // raised, and the rules would guard a type nothing emits.
    expect(WEBHOOK).toMatch(
      /'user\.expiration':\s*\{\s*type:\s*EVENT_TYPES\.REMNAWAVE_USER_EXPIRE_SOON/,
    )
  })

  it('no longer answers to the fixed names only Remnawave 2.7.4 sent', () => {
    expect(WEBHOOK).not.toMatch(/'user\.expires_in_\d+_hours':\s*\{/)
  })
})

describe('a ready-made pop-up bound to the expiry warning', () => {
  const ceiling = LAST_WARNING_HOURS
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
    expect(expired?.ttlHours).toBeGreaterThan(LAST_WARNING_HOURS)
  })
})
