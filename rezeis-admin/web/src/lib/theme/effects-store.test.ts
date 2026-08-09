/**
 * The effects store's id catalogue and its persistence migration.
 *
 * The reason this file exists: `STORE_VERSION` was deliberately NOT bumped
 * when `shuffle` / `typewriter` / `proximity` / `target` / `textTrail` were
 * added, on the reasoning that adding an option cannot invalidate anything
 * already persisted. That reasoning is only as good as `migrate` actually
 * being id-validating rather than id-enumerating, so it is checked here
 * instead of asserted in a comment.
 */
import { describe, expect, it } from 'vitest'

import {
  CURSOR_EFFECTS,
  TEXT_ANIMATIONS,
  useEffectsStore,
  type CursorEffectId,
  type TextAnimationId,
} from './effects-store'

/**
 * Reach the `migrate` the store was configured with. zustand exposes the
 * persist options on the store's `persist` API, which is how the real
 * rehydration path reaches it too — re-implementing the function here would
 * test a copy.
 */
const migrate = (state: unknown, version: number) =>
  (useEffectsStore.persist.getOptions().migrate as (s: unknown, v: number) => Record<string, unknown>)(
    state,
    version,
  )

describe('effects-store catalogue', () => {
  it('lists every new title animation exactly once', () => {
    const ids = TEXT_ANIMATIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['shuffle', 'typewriter', 'proximity'] as const) {
      expect(ids).toContain(id)
    }
  })

  it('lists every new cursor effect exactly once', () => {
    const ids = CURSOR_EFFECTS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['target', 'textTrail'] as const) {
      expect(ids).toContain(id)
    }
  })

  it('gives every option both an English and a Russian name', () => {
    for (const def of [...TEXT_ANIMATIONS, ...CURSOR_EFFECTS]) {
      expect(def.name.length, `${def.id} name`).toBeGreaterThan(0)
      expect(def.nameRu.length, `${def.id} nameRu`).toBeGreaterThan(0)
    }
  })
})

describe('effects-store migrate', () => {
  it('keeps every id in the current catalogue', () => {
    // The load-bearing half of "do not bump STORE_VERSION". If `migrate` ever
    // stops being a pure validity check — if it starts remapping or dropping
    // ids — adding an option would no longer be version-neutral and this goes
    // red before an operator's selection is silently reset.
    for (const anim of TEXT_ANIMATIONS) {
      expect(migrate({ textAnimation: anim.id }, 3).textAnimation).toBe(anim.id)
    }
    for (const cursor of CURSOR_EFFECTS) {
      expect(migrate({ cursorEffect: cursor.id }, 3).cursorEffect).toBe(cursor.id)
    }
  })

  it('snaps an id that no longer exists back to the default', () => {
    // `electricBorder` / `magnet` / `starBorder` are the three ids removed at
    // version 3; `asciiText` never existed. Both shapes must land on a value
    // the <Select> can actually render, or the trigger renders empty.
    const migrated = migrate(
      {
        textAnimation: 'asciiText',
        cursorEffect: 'ribbons',
        hoverEffect: 'electricBorder',
        clickEffect: 'starBorder',
        contentAnimation: 'magnet',
      },
      2,
    )

    expect(migrated.textAnimation).toBe('shiny')
    expect(migrated.cursorEffect).toBe('none')
    expect(migrated.hoverEffect).toBe('spotlight')
    expect(migrated.clickEffect).toBe('spark')
    expect(migrated.contentAnimation).toBe('animatedContent')

    // And the fallback has to be a value that is actually in the catalogue —
    // "falls back cleanly" means renderable, not merely non-null.
    expect(TEXT_ANIMATIONS.map((a) => a.id)).toContain(migrated.textAnimation as TextAnimationId)
    expect(CURSOR_EFFECTS.map((e) => e.id)).toContain(migrated.cursorEffect as CursorEffectId)
  })

  it('replaces a non-string id rather than trusting it', () => {
    const migrated = migrate({ textAnimation: 42, cursorEffect: null }, 2)
    expect(migrated.textAnimation).toBe('shiny')
    expect(migrated.cursorEffect).toBe('none')
  })

  it('survives a persisted blob with nothing in it', () => {
    expect(() => migrate(null, 2)).not.toThrow()
    const migrated = migrate({}, 2)
    expect(migrated.textAnimation).toBe('shiny')
    expect(migrated.cursorEffect).toBe('none')
  })

  it('setting a new id and resetting round-trips through the live store', () => {
    const store = useEffectsStore.getState()
    store.setTextAnimation('proximity')
    store.setCursorEffect('textTrail')
    expect(useEffectsStore.getState().textAnimation).toBe('proximity')
    expect(useEffectsStore.getState().cursorEffect).toBe('textTrail')

    useEffectsStore.getState().reset()
    expect(useEffectsStore.getState().textAnimation).toBe('shiny')
    expect(useEffectsStore.getState().cursorEffect).toBe('none')
  })
})
