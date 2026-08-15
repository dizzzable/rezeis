/**
 * reiwa's `<NetworkBg>` geometry, in the cabinet's own pixels.
 *
 * A module of its own, not a second export from `app-background-builtin.tsx`:
 * a file that exports both a component and a constant loses React Fast Refresh
 * for that component, which `react-refresh/only-export-components` warns about.
 * The parity test needs these numbers by name — comparing against a second
 * hand-written copy would defeat the point of the test — so the constant moves
 * out rather than the test reaching into the component file.
 *
 * Every number here is reiwa's. `app-background-builtin.test.tsx` reads
 * `reiwa/web/src/components/ui/network-bg.tsx` from the sibling checkout and
 * fails if the two drift apart; that file's own docblock explains why the three
 * blob sizes and their stop alphas may not be changed independently.
 */
export const NETWORK_BG_GEOMETRY = {
  /** `intensity="medium"` — the value `StealthLayout` mounts it with. */
  opacity: 0.5,
  /** The SVG network sits at `opacity * this`. */
  networkOpacityFactor: 0.4,
  /** Dot-grid tile pitch. */
  gridPitchPx: 80,
  /** Diagonal accent lines, as `[x1, y1, x2, y2]` percentages. */
  diagonals: [
    [0, 20, 60, 0],
    [40, 100, 100, 30],
    [0, 60, 80, 100],
    [20, 0, 100, 80],
  ],
  /**
   * The three pre-blurred glow discs. `stops` are the convolved alpha profile
   * sampled at 0/15/32/50/68/84% of the disc radius (the seventh stop is
   * transparent at 100%), as percentages of the brand colour mixed into
   * transparency. `offsets` are signed pixel offsets from the named edge.
   */
  glows: [
    { sizePx: 544, stops: [13.3, 12.1, 8.8, 4.7, 1.5, 0.3], top: -208, left: -208 },
    { sizePx: 544, stops: [5.3, 4.8, 3.4, 1.7, 0.6, 0.2], topFromThird: -112, right: -208 },
    { sizePx: 416, stops: [3.6, 3.3, 2.4, 1.3, 0.5, 0.2], bottom: 16, leftFromQuarter: -80 },
  ],
} as const
