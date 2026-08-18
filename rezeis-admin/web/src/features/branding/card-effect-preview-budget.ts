/**
 * Card-effect context budget for the operator preview
 * ───────────────────────────────────────────────────
 * How many preview cards may hold a live GPU context at the same time, and
 * which ones get to. This is the panel-side counterpart of the cabinet's
 * `web/src/lib/card-effect-budget.ts`, and it exists for the same reason and
 * with the same number — see that file for the full arithmetic.
 *
 * ── why the preview needs one at all ────────────────────────────────────────
 * The tariff preview used to render `plans.slice(0, 3)`, so the question never
 * came up: three cards, at most three renderers, and an operator with five
 * plans simply could not see two of them. The slice is gone — the preview now
 * lists every plan and scrolls, exactly as the cabinet's `/plans` does — and a
 * list with no ceiling is a list of GPU contexts. An installation with twenty
 * plans is not unusual, and twenty preview cards each mounting a renderer would
 * ask the browser for far more than it has.
 *
 * WebKit allows 16 live WebGL contexts per web-content process — not per tab,
 * and not approximately. The 17th request does not merely evict the oldest: it
 * hands the evicted one a `SyntheticLostContext`, which WebKit marks
 * unrecoverable, so a card that loses that way is blank until it is remounted
 * from scratch. This is the same failure the cabinet documents as "cards go
 * black one by one", and it is already why `card-effect-slots-section`,
 * `plan-card-styles-section` and `app-background-section` all pass
 * `livePreview={false}` to their pickers.
 *
 * Against 16, per granted card:
 *   1 renderer context, plus
 *   1 capability probe — `detectCapabilities()` in `card-effect-preview-runtime`
 *     opens a real `webgl2` context and releases it through
 *     `WEBGL_lose_context`, which WebKit frees ASYNCHRONOUSLY. The layer waits a
 *     frame before mounting the renderer for exactly that reason, but on the
 *     first paint of a list every granted card probes in the same tick, so the
 *     probes overlap each other and may still be draining when the renderers
 *     arrive. That probe is gated on the slot too, for the same reason the
 *     renderer is: an ungranted card that still probes spends the context it was
 *     just refused.
 * plus 1 for the phone frame's app-background layer, which is mounted for the
 * whole life of the branding page and never asks.
 *
 *   2 × 6 + 1 = 13, leaving 3 of 16 free for whatever else holds one.
 *
 * Six is also the number the cabinet grants, and that is the half of this that
 * matters most: the preview's job is to be accurate. If the preview animated
 * every card while the cabinet's budget let only six draw, the preview would
 * have stopped lying about WHICH plans exist and started lying about how they
 * look — an operator would tune an effect on the twelfth card that no
 * subscriber will ever see move. Keep this in step with
 * `CARD_EFFECT_CONTEXT_BUDGET` in the cabinet.
 *
 * ── what is NOT rationed ────────────────────────────────────────────────────
 * `canvas2d` effects need no GPU context at all, so they are left alone exactly
 * as the cabinet leaves them. Rationing them would cost them visible animation
 * to relieve pressure they do not create. Same for `NONE` and for an id this
 * bundle has no component for: nothing is mounted, so nothing is claimed.
 */

import { useCallback, useEffect, useState } from 'react'

import { requiresPreviewCardEffectWebGL } from './card-effect-preview-utils'

/** Simultaneously live preview renderers. Mirrors the cabinet's budget. */
export const CARD_EFFECT_PREVIEW_CONTEXT_BUDGET = 6

type PreviewSlotListener = (granted: boolean) => void

interface PreviewSlotClaim {
  readonly notify: PreviewSlotListener
  granted: boolean
}

export interface CardEffectPreviewBudget {
  readonly limit: number
  /**
   * Ask for a slot. `notify` is called whenever the answer CHANGES, including
   * synchronously during this call if the claim is granted straight away.
   * Returns the release; calling it is not optional — a claim that is never
   * released holds a slot a scrolled-away card is no longer using, which is the
   * one way this mechanism can leave a visible card static for ever.
   */
  claim(notify: PreviewSlotListener): () => void
  /** Currently granted claims. Diagnostics and tests. */
  readonly grantedCount: number
}

/**
 * Strict first-come-first-served, and deliberately so.
 *
 * A claim that has been granted is never taken away to give a newcomer a turn.
 * Priority by "most visible" or by distance from the viewport centre would
 * re-rank the whole list on every scroll frame and tear down a renderer that
 * was drawing correctly — replacing a bounded number of contexts with an
 * unbounded number of context CREATIONS, which is the more expensive half of
 * the problem.
 */
export function createCardEffectPreviewBudget(
  limit: number,
): CardEffectPreviewBudget {
  const queue: PreviewSlotClaim[] = []

  const settle = (): void => {
    let live = 0
    for (const claim of queue) {
      const next = live < limit
      if (next) live += 1
      if (claim.granted === next) continue
      claim.granted = next
      claim.notify(next)
    }
  }

  return {
    limit,
    claim(notify) {
      const entry: PreviewSlotClaim = { notify, granted: false }
      queue.push(entry)
      settle()
      let released = false
      return () => {
        if (released) return
        released = true
        const at = queue.indexOf(entry)
        if (at !== -1) queue.splice(at, 1)
        entry.granted = false
        settle()
      }
    },
    get grantedCount() {
      return queue.reduce((total, claim) => total + (claim.granted ? 1 : 0), 0)
    },
  }
}

/**
 * One budget for the whole document, not one per list.
 *
 * The limit being modelled is WebKit's, and WebKit counts per web-content
 * process. A per-list budget would let the tariff preview and anything else
 * that ever gains a live renderer agree separately that they were each within
 * their means.
 */
export const cardEffectPreviewBudget = createCardEffectPreviewBudget(
  CARD_EFFECT_PREVIEW_CONTEXT_BUDGET,
)

export interface CardEffectPreviewSlot {
  /**
   * Attach to the card's own element — the thing whose visibility decides.
   *
   * Named `attach` rather than `ref`, which is what the cabinet's equivalent
   * calls it: the React Compiler lint infers that any object carrying a `ref`
   * IS a ref object and then reports every read of its siblings as a ref access
   * during render. This is a callback ref and `active` is a plain boolean, so
   * the report is wrong, and a name is cheaper than three suppressions.
   */
  readonly attach: (node: Element | null) => void
  /**
   * Pass straight to `CardEffectPreviewLayer`.
   *
   * `undefined` means "not rationed" and lets the layer mount as it always has,
   * which is the behaviour the app-background layer keeps. A boolean means this
   * card is rationed and the layer must obey it.
   */
  readonly active: boolean | undefined
}

/**
 * A preview card's claim on the context budget, tied to its own visibility.
 *
 * The tariff preview scrolls inside the phone frame, so "visible" here means
 * visible within that scroller rather than within the browser window. The
 * observer is left with the default root for exactly the reason the cabinet
 * uses the default root: an element scrolled out of a clipping ancestor stops
 * intersecting the viewport too, so the default root already answers both
 * questions, and naming the scroller as root would additionally require the
 * scroller to exist before the card mounts.
 *
 * A card that is refused, or that has scrolled away, keeps its gradient — the
 * `NONE` appearance, which is a designed state and the same thing an operator
 * gets by choosing no effect at all.
 */
export function usePreviewCardEffectSlot(
  effect: string,
  budget: CardEffectPreviewBudget = cardEffectPreviewBudget,
): CardEffectPreviewSlot {
  const rationed = requiresPreviewCardEffectWebGL(effect)
  const [node, setNode] = useState<Element | null>(null)
  const [intersecting, setIntersecting] = useState(false)
  const [granted, setGranted] = useState(false)

  const attach = useCallback((next: Element | null) => setNode(next), [])

  // No observer at all (jsdom, a very old engine) must not mean "no card ever
  // animates". Fall back to the pre-budget answer — treat it as on screen and
  // let the budget alone decide. Derived during render rather than pushed into
  // state by an effect: whether the environment HAS the API is a fact a render
  // can simply read, and routing it through `setState` would be a cascading
  // render for an answer that was already available.
  const observable = typeof IntersectionObserver !== 'undefined'
  const onScreen = observable ? intersecting : true

  useEffect(() => {
    if (!rationed || node === null || !observable) return
    const observer = new IntersectionObserver(
      ([entry]) => setIntersecting(entry?.isIntersecting === true),
      { threshold: 0.01 },
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
      // Forget what the OLD observer last said. Visibility is that observer's
      // answer, not a property of the card, and the next one has not spoken
      // yet — carrying the answer over claims a slot on evidence that has been
      // thrown away. Reachable: the operator's per-plan `cardEffect` can change
      // under a mounted card, and a canvas2d value in between tears this
      // observer down.
      setIntersecting(false)
    }
  }, [node, observable, rationed])

  useEffect(() => {
    if (!rationed || !onScreen) return
    const release = budget.claim(setGranted)
    return () => {
      release()
      setGranted(false)
    }
  }, [budget, onScreen, rationed])

  return {
    attach,
    // `onScreen` is re-checked here rather than trusted through `granted`
    // alone: the release that clears `granted` runs in an effect, one commit
    // after the card left the screen, and a card must stop drawing in the SAME
    // commit it stops being visible.
    active: rationed ? granted && onScreen : undefined,
  }
}
