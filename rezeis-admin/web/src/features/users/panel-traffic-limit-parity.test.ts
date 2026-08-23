/**
 * The panel's copy of the byte→gigabyte rule, against the backend's.
 * ──────────────────────────────────────────────────────────────────
 * `panel-traffic-limit.ts` is a hand-written copy of the server's
 * `panelTrafficLimitToGb`, because the production frontend project may not
 * import out of `web/` (see `build-isolation.test.ts` and the Dockerfile stage
 * that copies `web/` alone). This file is the other half of that bargain: the
 * copy is pinned to the original from the TEST side, where reaching across the
 * package boundary is legal and already blessed — `rbac-catalog-parity.test.ts`
 * and `subscription-sync-outcome.test.tsx` both make exactly this move.
 *
 * WHAT IT IS GUARDING. This conversion had six spellings before it had one, and
 * two of them had already lost the `Math.max(1, …)` floor: the same customer,
 * the same panel row, two different answers depending on which path touched it
 * last. The seventh spelling was inline in `user-detail-panel.tsx`, unfloored,
 * and it turned the drift notice into a liar the moment the backend was fixed —
 * server storing `1` for a 0.4 GB cap, panel computing `0`, a drift reported
 * between two sides that agreed.
 *
 * So the table below is not decoration. Each row is a way the two can disagree,
 * and the three that matter most are the ones a careless "simplification" hits
 * first: the sub-gigabyte floor, `0` bytes answering unlimited, and garbage
 * answering unlimited rather than `NaN`.
 */
import { describe, expect, it } from 'vitest'

// ACROSS THE PACKAGE BOUNDARY, from a test, deliberately. `tsconfig.app.json`
// excludes tests so the production build never follows this import;
// `tsconfig.test.json` type-checks it with the repository around it. Comparing
// the panel's copy against a second copy would reproduce the drift being
// guarded against.
import { panelTrafficLimitToGb as BACKEND } from '../../../../src/modules/remnawave/utils/panel-traffic-limit.util'

import { panelTrafficLimitToGb as PANEL } from './panel-traffic-limit'

const GIB = 1024 * 1024 * 1024

/**
 * Every input shape the rule makes a decision about, with the answer spelled
 * out here as well so this file fails on a SILENT agreement — if both sides
 * were broken the same way, `toBe(BACKEND(x))` alone would pass.
 */
const TABLE: ReadonlyArray<{ readonly name: string; readonly bytes: number | null | undefined; readonly gb: number | null }> = [
  { name: 'unlimited: the panel spells it 0 bytes', bytes: 0, gb: null },
  { name: 'unlimited: a negative cap is not a cap', bytes: -1, gb: null },
  { name: 'absent: null', bytes: null, gb: null },
  { name: 'absent: undefined', bytes: undefined, gb: null },
  { name: 'garbage: NaN must not reach the column', bytes: Number.NaN, gb: null },
  { name: 'garbage: Infinity must not reach the column', bytes: Number.POSITIVE_INFINITY, gb: null },
  // THE FLOOR. Every one of these rounds to 0 without `Math.max(1, …)`, and a
  // stored 0 is pushed back to the panel as UNLIMITED — a 0.4 GB cap silently
  // becoming no cap at all.
  { name: 'floor: one single byte is still worth a gigabyte', bytes: 1, gb: 1 },
  { name: 'floor: 0.4 GB does not round down to zero', bytes: Math.round(0.4 * GIB), gb: 1 },
  { name: 'floor: 0.5 GB does not round down to zero', bytes: Math.round(0.49 * GIB), gb: 1 },
  { name: 'exact: one gigabyte', bytes: GIB, gb: 1 },
  { name: 'rounds: 1.4 GB down to 1', bytes: Math.round(1.4 * GIB), gb: 1 },
  { name: 'rounds: 1.6 GB up to 2', bytes: Math.round(1.6 * GIB), gb: 2 },
  { name: 'exact: fifty gigabytes', bytes: 50 * GIB, gb: 50 },
]

describe('the panel copy of panelTrafficLimitToGb against the backend original', () => {
  it('is reading two real, distinct functions', () => {
    // The anchor. An import that resolved to the same module would make every
    // comparison below compare a function with itself — the vacuous-green shape
    // this repository keeps finding.
    expect(PANEL).not.toBe(BACKEND)
    expect(typeof PANEL).toBe('function')
    expect(typeof BACKEND).toBe('function')
  })

  for (const row of TABLE) {
    it(`agrees, and is right, for ${row.name}`, () => {
      // Right first, THEN agreeing — in that order on purpose. Two functions
      // broken identically agree perfectly.
      expect(BACKEND(row.bytes)).toBe(row.gb)
      expect(PANEL(row.bytes)).toBe(row.gb)
    })
  }

  it('never answers 0 gigabytes for any input, on either side', () => {
    // `0` is a REAL value in this column — genuinely no traffic — and the panel
    // has no encoding for it, so a conversion is never allowed to invent one.
    // Only an explicit local assignment may write it.
    for (const row of TABLE) {
      expect(BACKEND(row.bytes)).not.toBe(0)
      expect(PANEL(row.bytes)).not.toBe(0)
    }
  })
})
