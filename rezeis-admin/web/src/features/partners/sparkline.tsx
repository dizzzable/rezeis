import { useMemo } from 'react'

interface SparklineProps {
  readonly values: ReadonlyArray<number>
  readonly width?: number
  readonly height?: number
  readonly stroke?: string
  readonly fill?: string
  readonly className?: string
}

/**
 * Tiny inline SVG sparkline. We keep it framework-free so it can be
 * dropped on any Card without pulling Recharts into the bundle path.
 */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  stroke = 'hsl(var(--primary))',
  fill = 'hsl(var(--primary) / 0.15)',
  className,
}: SparklineProps) {
  const { linePath, areaPath } = useMemo(() => buildPaths(values, width, height), [values, width, height])
  if (values.length === 0) return null
  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={areaPath} fill={fill} />
      <path d={linePath} stroke={stroke} strokeWidth={1.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function buildPaths(values: ReadonlyArray<number>, width: number, height: number) {
  if (values.length === 0) return { linePath: '', areaPath: '' }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const xStep = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((value, idx) => {
    const x = idx * xStep
    const y = height - ((value - min) / range) * (height - 4) - 2
    return [x, y] as const
  })
  const linePath = points
    .map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ')
  const areaPath = `${linePath} L${width.toFixed(2)},${height} L0,${height} Z`
  return { linePath, areaPath }
}
