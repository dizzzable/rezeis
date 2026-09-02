import { useTranslation } from 'react-i18next'

import { RARITY_COLOR, sectorTitle, type WheelSector } from './wheel-config-api'

const SIZE = 260
const CENTER = SIZE / 2
const RADIUS = CENTER - 6

/**
 * The wheel as the OPERATOR sees it.
 *
 * Deliberately not a mock of the customer's wheel, and it says so by showing
 * the one thing the customer never sees: the percentage on every slice. What
 * it is for is the question a table of numbers answers badly — is the jackpot
 * a sliver or a third of the wheel — and for catching the slot order before
 * anybody spins it.
 *
 * Slices are drawn in weight proportion, so a sector at 1 % is a hairline and
 * looks like one. Disabled and zero-weight sectors are absent entirely,
 * because they are absent from the draw.
 */
export function WheelPreview({ sectors }: { readonly sectors: readonly WheelSector[] }) {
  const { t } = useTranslation()
  const drawable = sectors.filter((sector) => sector.enabled && sector.weight > 0)
  const total = drawable.reduce((sum, sector) => sum + sector.weight, 0)

  if (drawable.length === 0 || total <= 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        {t('wheelConfigPage.preview.empty')}
      </div>
    )
  }

  // One sector filling the wheel cannot be drawn as an arc — the start and end
  // points coincide and the path collapses to nothing. A circle is what it
  // actually is.
  if (drawable.length === 1) {
    const only = drawable[0]!
    return (
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-[260px] w-[260px]" role="img"
        aria-label={sectorTitle(only, t('wheelConfigPage.preview.unnamed'))}>
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill={RARITY_COLOR[only.rarity]}
          fillOpacity={0.75}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
        <text x={CENTER} y={CENTER} textAnchor="middle" className="fill-foreground text-[11px]">
          100 %
        </text>
      </svg>
    )
  }

  // A prefix sum rather than a running variable: a `map` that mutates as it
  // goes reads correctly and behaves correctly exactly once, and there are a
  // handful of sectors, so the quadratic sum costs nothing worth naming.
  const slices = drawable.map((sector, index) => {
    const before = drawable
      .slice(0, index)
      .reduce((sum, earlier) => sum + earlier.weight, 0)
    const start = -Math.PI / 2 + (before / total) * Math.PI * 2
    const sweep = (sector.weight / total) * Math.PI * 2
    return { sector, start, end: start + sweep, sweep }
  })

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-[260px] w-[260px]" role="img"
      aria-label={t('wheelConfigPage.preview.title')}>
      {slices.map(({ sector, start, end, sweep }) => {
        const x1 = CENTER + RADIUS * Math.cos(start)
        const y1 = CENTER + RADIUS * Math.sin(start)
        const x2 = CENTER + RADIUS * Math.cos(end)
        const y2 = CENTER + RADIUS * Math.sin(end)
        const largeArc = sweep > Math.PI ? 1 : 0
        const mid = start + sweep / 2
        const labelRadius = RADIUS * 0.62
        return (
          <g key={sector.id}>
            <path
              d={`M ${CENTER} ${CENTER} L ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x2} ${y2} Z`}
              fill={RARITY_COLOR[sector.rarity]}
              fillOpacity={0.75}
              stroke="currentColor"
              strokeOpacity={0.2}
            />
            {/* A sliver has no room for a label, and a label that does not fit
                is worse than none: it overlaps its neighbours and makes the
                whole diagram unreadable. */}
            {sweep > 0.22 ? (
              <text
                x={CENTER + labelRadius * Math.cos(mid)}
                y={CENTER + labelRadius * Math.sin(mid)}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-foreground text-[10px]"
              >
                {sector.chancePercent.toFixed(sector.chancePercent < 10 ? 1 : 0)} %
              </text>
            ) : null}
          </g>
        )
      })}
      <circle cx={CENTER} cy={CENTER} r={RADIUS * 0.18} className="fill-background" />
    </svg>
  )
}
