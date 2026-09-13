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
    <div className="flex items-center gap-6">
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
            <Tooltip formatter={(value) => [Number(value ?? 0), '']} contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="text-2xl font-semibold tabular-nums">{total}</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-col gap-3">
        {slices.map((slice) => (
          <li key={slice.key} className="flex min-w-0 items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: slice.color }}
              aria-hidden
            />
            <span className="truncate text-sm text-muted-foreground">{slice.name}</span>
            <span className="ml-auto pl-3 text-sm font-medium tabular-nums">{slice.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
