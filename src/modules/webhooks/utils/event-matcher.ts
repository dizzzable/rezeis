/**
 * Wildcard-aware event-type matcher used by webhook dispatch.
 *
 * Supported patterns:
 *   `*`               --> matches every event
 *   `payment.*`       --> matches every event in the `payment.` namespace
 *   `payment.completed` --> exact match
 *
 * Empty list of patterns also matches everything — that's the convention
 * we expose in the UI for "subscribe to all".
 */
export function eventMatches(eventType: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  for (const pattern of patterns) {
    if (pattern === '*' || pattern === eventType) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1); // keep the dot
      if (eventType.startsWith(prefix)) return true;
    }
  }
  return false;
}
