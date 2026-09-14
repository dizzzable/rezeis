/**
 * One half of the subscription card: a heading, a ring and its legend.
 *
 * Both halves — subscription statuses on the left, client apps on the right —
 * are drawn by these two components, so they cannot drift apart. They used to:
 * the status half took the card's own header, which sits ABOVE the grid, while
 * the client-apps half had a small heading inside its column. The right title
 * landed lower and smaller than the left one, and its ring started lower too
 * (owner's screenshot, 13.09.2026). Now each half puts the same heading in the
 * first row of its own column, so the titles share a line and the rings below
 * them start at the same height.
 */
import type { CSSProperties, JSX, ReactNode } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

export interface DashboardRingSlice {
  readonly key: string
  readonly name: string
  readonly value: number
  readonly color: string
}

/**
 * The heading of one half. The description line keeps its height while it has
 * nothing to say yet (the client apps are still loading), so the ring under it
 * does not jump when the count arrives. `data-concept-heading` is what concept
 * themes style headings by — the same attribute `CardTitle` carries, with the
 * same classes, so both titles look like every other card title on the page.
 */
export function DashboardRingHeading({
  id,
  title,
  description,
}: {
  readonly id: string
  readonly title: ReactNode
  readonly description?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <h3
        id={id}
        data-concept-heading=""
        className="text-2xl font-semibold leading-none tracking-tight"
      >
        {title}
      </h3>
      <p className="min-h-5 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

/**
 * The ring and its legend.
 *
 * Slices are separated by the CARD's own colour rather than recharts' default
 * white stroke, which drew bright seams across a dark card, and their ends are
 * slightly rounded. The total sits in the hole of the ring; it repeats the
 * heading's count, so it is hidden from assistive technology.
 *
 * The tooltip names the slice it points at, in the legend's words. It used to
 * be handed a formatter that swapped every slice's name for an empty string,
 * and a slice read " : 44" with nothing to say which one it was.
 *
 * A legend label is never cut short, and no word in it is broken.
 *
 * It used to `truncate` ("Активные (…" in half of a 1920 px dashboard), and
 * then to wrap beside the ring from a 22rem column. A row there gets the column
 * minus the ring and the gap — about 139 px at 1920 — and with four-digit counts
 * in the panel's own Geist it read "Активны|е (> 7 дн.)", "Ограничен|ные",
 * "Истёкши|е", and "Остальны|е" on the apps half.
 *
 * SO THE WIDEST ROW DECIDES WHERE THE LEGEND GOES. A row needs its dot, two
 * gaps, the longest WORD of its label and its count. The widest is
 * "Ограниченные" with a six-digit count: 189.4 px in Geist, 191.2 px in IBM
 * Plex Mono, the widest of the panel's fonts. With the 12rem ring and its
 * 1.5rem gap that needs a 407 px column, so the legend goes beside the ring from
 * 26rem (416 px) and under it, with the whole column, below that. Being in rem
 * like the ring and the text, the threshold follows the operator's font size.
 *
 * Beside the ring the legend starts at its narrowest (its longest word) and
 * grows to its natural width, so a label wraps only between words. A row that
 * still does not fit — an app name that is one long word, a count of eight
 * digits — moves the legend under the ring instead. Only a word wider than the
 * whole column, like a raw package id, still breaks, as it must to stay in the
 * card.
 *
 * Measured in Chromium against the compiled classes with the panel's fonts
 * inlined: ru and en, counts of up to eight digits, columns of 238–600 px, root
 * sizes 14/16/17 px. No word breaks, nothing is cut, no count leaves the column,
 * and wherever a row fits beside the ring the layout is the previous one, pixel
 * for pixel. The price: in the two-column dashboard the legend now sits under
 * the ring below a 416 px column — about a 2160 px window with the sidebar open
 * — and the card is taller there.
 *
 * Beside the ring the legend is centred against it, and a legend taller than
 * the ring grows downwards while the ring stays at the top, level with the
 * other half's.
 */
export function DashboardRing({
  slices,
  total,
  tooltipStyle,
}: {
  readonly slices: readonly DashboardRingSlice[]
  readonly total: number
  readonly tooltipStyle: CSSProperties
}): JSX.Element {
  return (
    <div className="@container">
      <div className="flex flex-col items-center gap-4 @min-[26rem]:flex-row @min-[26rem]:flex-wrap @min-[26rem]:items-start @min-[26rem]:gap-x-6">
        <div className="relative h-48 w-48 shrink-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <PieChart>
              <Pie
                data={[...slices]}
                cx="50%"
                cy="50%"
                innerRadius={56}
                outerRadius={84}
                paddingAngle={2}
                cornerRadius={4}
                stroke="var(--card)"
                strokeWidth={2}
                dataKey="value"
                nameKey="name"
              >
                {slices.map((slice) => (
                  <Cell key={slice.key} fill={slice.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span className="text-2xl font-semibold tabular-nums">{total}</span>
          </div>
        </div>
        <div className="flex min-w-0 max-w-full flex-col @min-[26rem]:w-min @min-[26rem]:max-w-max @min-[26rem]:grow @min-[26rem]:self-center">
          <ul className="flex min-w-0 flex-col gap-3">
            {slices.map((slice) => (
              <li key={slice.key} className="flex min-w-0 items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: slice.color }}
                  aria-hidden
                />
                <span className="min-w-0 text-balance break-words text-sm leading-tight text-muted-foreground">
                  {slice.name}
                </span>
                <span className="ml-auto pl-3 text-sm font-medium tabular-nums">{slice.value}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
