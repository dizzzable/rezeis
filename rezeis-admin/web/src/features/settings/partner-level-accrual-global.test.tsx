/**
 * The GLOBAL per-level accrual controls on the Partner Program settings page.
 *
 * These three selects write `Settings.partnerSettings`, which every partner on
 * global settings is paid from. Four things are pinned, and each is a way the
 * form can look finished while quietly changing what partners earn:
 *
 *   • WHAT IT SUBMITS. `accrualStrategies` is NOT one of the three keys
 *     `mergePartnerSettings` deep-merges (`levels`, `gatewayCommissions`,
 *     `withdrawals` are), so the PATCH replaces the object wholesale. A submit
 *     carrying only the level the operator touched DROPS the other two, and
 *     they revert to the legacy flat key on the next accrual. So every save
 *     must carry all three.
 *   • WHAT IT SHOWS FOR AN UNSET LEVEL. An explicit "Inherit (…)" naming the
 *     current strategy — never a blank, and never the strategy pre-filled as
 *     though the operator had chosen it. Pre-filling would turn an inherited
 *     level into a stored one on the very next save, and stored levels stop
 *     following the strategy above.
 *   • THAT INHERIT DEGRADES TO TODAY'S BEHAVIOUR. Inherit goes out as an
 *     explicit `null`, which `readAccrualMode` refuses in both the map and the
 *     flat key, so the level falls through to the legacy flat `accrualStrategy`
 *     — what an install that predates this feature already does.
 *   • THAT THE HINT SAYS THE NON-OBVIOUS PART: picking the value the strategy
 *     above already has is NOT a no-op.
 *
 * Assertions are on rendered values and on the request body that actually goes
 * out — including one that reads the body after JSON serialisation, because
 * "explicit null" and "omitted" are two different requests and only the wire
 * decides which one was sent.
 *
 * No absolute dates anywhere: this file has no time-dependent fixture at all.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PartnerSettingsPage from './partner-settings-page'

const ON_EACH = 'On each payment'
const ON_FIRST = 'On first payment only'
const INHERIT_EACH = `Inherit (${ON_EACH})`
const INHERIT_FIRST = `Inherit (${ON_FIRST})`

/** Radix's Select trigger needs these; jsdom ships none of them. */
beforeAll(async () => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
  proto['hasPointerCapture'] ??= () => false
  proto['setPointerCapture'] ??= () => {}
  proto['releasePointerCapture'] ??= () => {}
  proto['scrollIntoView'] ??= () => {}
  await i18nReady
})

beforeEach(() => {
  vi.restoreAllMocks()
})

type Json = Record<string, unknown>

/**
 * Stored `partnerSettings`. Percents are here only so the form has something
 * to round-trip; the accrual keys are what every test is about.
 */
function storedSettings(partnerSettings: Json = {}): Json {
  return {
    partnerSettings: {
      enabled: true,
      level1Percent: 10,
      level2Percent: 5,
      level3Percent: 1,
      accrualStrategy: 'ON_EACH_PAYMENT',
      ...partnerSettings,
    },
  }
}

async function mount(settings: Json | 'load-fails' = storedSettings()) {
  if (settings === 'load-fails') {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('boom'))
  } else {
    vi.spyOn(api, 'get').mockResolvedValue({ data: settings })
  }
  vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderWithProviders(<PartnerSettingsPage />)
  const user = userEvent.setup()
  if (settings !== 'load-fails') {
    // The page renders a skeleton until the settings land; every assertion
    // below is about the form, so wait for the form and not for a timeout.
    await screen.findByText('Accrual mode per level')
  }
  return user
}

/** The three per-level triggers, addressed by the label above each one. */
function levelTrigger(level: 1 | 2 | 3): HTMLElement {
  return screen.getByRole('combobox', { name: `L${level}` })
}

function levelValues(): readonly string[] {
  return [1, 2, 3].map((level) => levelTrigger(level as 1 | 2 | 3).textContent ?? '')
}

function patchSpy(): ReturnType<typeof vi.fn> {
  return api.patch as unknown as ReturnType<typeof vi.fn>
}

/** Saves and returns the body handed to `PATCH /admin/settings/partner`. */
async function save(user: ReturnType<typeof userEvent.setup>): Promise<Json> {
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await vi.waitFor(() => expect(patchSpy()).toHaveBeenCalled())
  const [url, body] = patchSpy().mock.calls[0] as [string, Json]
  expect(url).toBe('/admin/settings/partner')
  return body
}

/** Opens a level's select and picks an option by its visible label. */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  level: 1 | 2 | 3,
  option: string,
): Promise<void> {
  await user.click(levelTrigger(level))
  await user.click(await screen.findByRole('option', { name: option }))
}

// ── What an unset level shows ────────────────────────────────────────────────

describe('global accrual levels — the empty state is Inherit, not a blank', () => {
  it('shows Inherit naming the strategy above when nothing is stored', async () => {
    await mount()

    expect(levelValues()).toEqual([INHERIT_EACH, INHERIT_EACH, INHERIT_EACH])
  })

  it('names the OTHER strategy when that is the one stored', async () => {
    await mount(storedSettings({ accrualStrategy: 'ON_FIRST_PAYMENT' }))

    expect(levelValues()).toEqual([INHERIT_FIRST, INHERIT_FIRST, INHERIT_FIRST])
  })

  it('re-labels Inherit the moment the operator changes the strategy above', async () => {
    const user = await mount()
    await user.click(screen.getByRole('combobox', { name: 'Accrual Strategy' }))
    await user.click(await screen.findByRole('option', { name: ON_FIRST }))

    // The label is a claim about what an inherited level resolves to, so it has
    // to track the control it is quoting rather than the value at load time.
    expect(levelValues()).toEqual([INHERIT_FIRST, INHERIT_FIRST, INHERIT_FIRST])
  })

  it('does NOT pre-fill an unset level with the strategy above', async () => {
    await mount(storedSettings({ accrualStrategy: 'ON_FIRST_PAYMENT' }))

    // Showing a bare "On first payment only" here would look identical to the
    // operator and mean the opposite: the next save would STORE it, and the
    // level would stop following the strategy for good.
    for (const level of [1, 2, 3] as const) {
      expect(levelTrigger(level)).not.toHaveTextContent(new RegExp(`^${ON_FIRST}$`))
    }
    expect(levelValues()).toEqual([INHERIT_FIRST, INHERIT_FIRST, INHERIT_FIRST])
  })
})

// ── Which stored shape wins ──────────────────────────────────────────────────

describe('global accrual levels — read in the order the backend resolves them', () => {
  it('reads accrualStrategies.LEVEL_N first', async () => {
    await mount(
      storedSettings({
        accrualStrategies: { LEVEL_2: 'ON_FIRST_PAYMENT' },
      }),
    )

    expect(levelValues()).toEqual([INHERIT_EACH, ON_FIRST, INHERIT_EACH])
  })

  it('falls back to the flat levelNAccrualStrategy key when the map lacks that level', async () => {
    await mount(
      storedSettings({
        accrualStrategies: { LEVEL_1: 'ON_EACH_PAYMENT' },
        level3AccrualStrategy: 'ON_FIRST_PAYMENT',
      }),
    )

    expect(levelValues()).toEqual([ON_EACH, INHERIT_EACH, ON_FIRST])
  })

  it('lets the map win over a flat key that disagrees', async () => {
    await mount(
      storedSettings({
        accrualStrategies: { LEVEL_1: 'ON_FIRST_PAYMENT' },
        level1AccrualStrategy: 'ON_EACH_PAYMENT',
      }),
    )

    expect(levelTrigger(1)).toHaveTextContent(ON_FIRST)
  })

  it('accepts ONCE_PER_USER as the per-partner spelling of first-payment-only', async () => {
    await mount(storedSettings({ accrualStrategies: { LEVEL_1: 'once_per_user' } }))

    expect(levelTrigger(1)).toHaveTextContent(ON_FIRST)
  })

  it('degrades an empty or unrecognised stored level to Inherit, not to a mode', async () => {
    // Each of these is what `readAccrualMode` refuses on the backend. The form
    // has to refuse them the same way, or it would show a mode the accrual
    // engine is not using.
    for (const junk of ['', '   ', 'ONCE', 'on_first', 'true', null]) {
      vi.restoreAllMocks()
      await mount(storedSettings({ accrualStrategies: { LEVEL_1: junk } }))
      expect(
        levelTrigger(1),
        `LEVEL_1=${JSON.stringify(junk)} must fall through to Inherit`,
      ).toHaveTextContent(INHERIT_EACH)
      cleanup()
    }
  })
})

// ── What the form submits ────────────────────────────────────────────────────

describe('global accrual levels — every save carries all three', () => {
  it('sends the two untouched levels alongside the one that changed', async () => {
    const user = await mount(
      storedSettings({
        accrualStrategies: {
          LEVEL_1: 'ON_EACH_PAYMENT',
          LEVEL_2: 'ON_FIRST_PAYMENT',
          LEVEL_3: 'ON_EACH_PAYMENT',
        },
      }),
    )
    await choose(user, 2, ON_EACH)

    const body = await save(user)

    // The PATCH replaces `accrualStrategies` wholesale, so a body with one key
    // in it is a body that erases the other two.
    expect(body.accrualStrategies).toEqual({
      LEVEL_1: 'ON_EACH_PAYMENT',
      LEVEL_2: 'ON_EACH_PAYMENT',
      LEVEL_3: 'ON_EACH_PAYMENT',
    })
  })

  it('writes the flat keys too, so no stale flat key outlives the map', async () => {
    const user = await mount(storedSettings())
    await choose(user, 3, ON_FIRST)

    const body = await save(user)

    expect(body.level3AccrualStrategy).toBe('ON_FIRST_PAYMENT')
    expect(body.level1AccrualStrategy).toBeNull()
    expect(body.level2AccrualStrategy).toBeNull()
  })

  it('round-trips stored levels untouched when the operator saves something else', async () => {
    const user = await mount(
      storedSettings({ accrualStrategies: { LEVEL_2: 'ON_FIRST_PAYMENT' } }),
    )
    await user.click(screen.getByRole('switch', { name: 'Enable Partner Program' }))

    const body = await save(user)

    expect(body.accrualStrategies).toEqual({
      LEVEL_1: null,
      LEVEL_2: 'ON_FIRST_PAYMENT',
      LEVEL_3: null,
    })
  })

  it('sends an Inherit level as an explicit null in both shapes', async () => {
    const user = await mount(
      storedSettings({
        accrualStrategies: { LEVEL_1: 'ON_FIRST_PAYMENT', LEVEL_2: 'ON_FIRST_PAYMENT' },
      }),
    )
    await choose(user, 1, INHERIT_EACH)

    const body = await save(user)

    expect(body.accrualStrategies).toEqual({
      LEVEL_1: null,
      LEVEL_2: 'ON_FIRST_PAYMENT',
      LEVEL_3: null,
    })
    expect(body.level1AccrualStrategy).toBeNull()
  })

  it('keeps that null on the wire, where null and omitted stop being the same', async () => {
    const user = await mount(storedSettings())

    const body = await save(user)

    // Axios serialises the body with `JSON.stringify`, which KEEPS a null and
    // DROPS an undefined. `null` is the value that means "inherit"; a dropped
    // key would leave whatever is stored in place, which is the opposite
    // request. Reading the serialised form is the only way to tell them apart.
    const wire = JSON.parse(JSON.stringify(body)) as Json
    const strategies = wire.accrualStrategies as Json
    expect(Object.keys(strategies).sort()).toEqual(['LEVEL_1', 'LEVEL_2', 'LEVEL_3'])
    expect(strategies.LEVEL_1).toBeNull()
    expect('level1AccrualStrategy' in wire).toBe(true)
    expect(wire.level1AccrualStrategy).toBeNull()
  })

  it('leaves the legacy flat accrualStrategy in the body, which inherit falls back to', async () => {
    const user = await mount(storedSettings({ accrualStrategy: 'ON_FIRST_PAYMENT' }))

    const body = await save(user)

    // All three levels inherit and go out as null, so the accrual engine reads
    // this key for every one of them — today's behaviour, unchanged.
    expect(body.accrualStrategy).toBe('ON_FIRST_PAYMENT')
    expect(body.accrualStrategies).toEqual({ LEVEL_1: null, LEVEL_2: null, LEVEL_3: null })
  })
})

// ── The hint ─────────────────────────────────────────────────────────────────

describe('global accrual levels — the hint explains the non-obvious part', () => {
  it('gives each level its own info trigger', async () => {
    await mount()

    for (const level of [1, 2, 3]) {
      expect(
        screen.getByRole('button', { name: `What the level ${level} accrual mode does` }),
      ).toBeInTheDocument()
    }
  })

  it('says on hover that picking the strategy above is not a no-op', async () => {
    const user = await mount()

    await user.hover(
      screen.getByRole('button', { name: 'What the level 2 accrual mode does' }),
    )

    const tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText(/is not a no-op/)).toBeInTheDocument()
    expect(
      within(tooltip).getByText(
        /a stored value stops following that strategy, an inherited one keeps following it/,
      ),
    ).toBeInTheDocument()
  })

  it('says under the group that an Inherit level follows the strategy above', async () => {
    await mount()

    expect(
      screen.getByText(/A level left on Inherit follows the strategy above/),
    ).toBeInTheDocument()
  })
})

// ── A failed load is not an empty state ──────────────────────────────────────

describe('global accrual levels — a failed load is not an empty form', () => {
  it('does not claim every level inherits when the settings never arrived', async () => {
    await mount('load-fails')

    // "Inherit (On each payment)" is a statement about what is stored. Rendering
    // it from a request that failed invents that statement — and the Save button
    // beside it would then write the invention over the real settings.
    await screen.findByText(/could not be loaded/i)
    expect(screen.queryByText(INHERIT_EACH)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
