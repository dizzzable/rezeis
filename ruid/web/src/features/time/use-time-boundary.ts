import { useEffect, useMemo, useState } from 'react'

const MAX_TIMEOUT_DELAY_IN_MILLISECONDS = 2147483647

export function useTimeBoundary(boundaries: readonly (string | null | undefined)[]): number {
  const [now, setNow] = useState<number>(() => Date.now())
  const nextBoundaryTimestamp: number | null = useMemo(() => getNextBoundaryTimestamp({ boundaries, now }), [boundaries, now])
  useEffect(() => {
    if (nextBoundaryTimestamp === null) {
      return
    }
    const timeoutDelay: number = Math.min(Math.max(nextBoundaryTimestamp - now + 1, 0), MAX_TIMEOUT_DELAY_IN_MILLISECONDS)
    const timeoutId: number = window.setTimeout(() => {
      setNow(Date.now())
    }, timeoutDelay)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [nextBoundaryTimestamp, now])
  return now
}

function getNextBoundaryTimestamp({
  boundaries,
  now,
}: {
  readonly boundaries: readonly (string | null | undefined)[]
  readonly now: number
}): number | null {
  const timestamps: number[] = boundaries.flatMap((boundary) => {
    if (!boundary) {
      return []
    }
    const timestamp: number = Date.parse(boundary)
    if (Number.isNaN(timestamp) || timestamp <= now) {
      return []
    }
    return [timestamp]
  })
  if (timestamps.length === 0) {
    return null
  }
  return Math.min(...timestamps)
}
