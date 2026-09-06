import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PRESENCE_AWAY_MS,
  PRESENCE_ONLINE_MS,
  presenceDotClass,
  presenceFromLastSeen,
} from './user-presence-dot'

/**
 * The browser's status dot and the API's presence filter must agree.
 *
 * They cannot share a module: the SPA builds from `web/` alone and its Docker
 * stage copies nothing from `src/`. So the thresholds exist twice, and the only
 * thing that can keep them equal is a test that reads the API's file.
 *
 * The disagreement this replaces was not theoretical. Three copies existed —
 * this one, one in `users-page`, one in `user-detail-panel` — and the support
 * picker's FILTER used the API's numbers while the list's DOT used the
 * browser's. A row selected by "online" could render amber right beside the
 * control that selected it.
 */

// Four levels up: users -> features -> src -> web, then into the API tree.
// `__dirname` and not `import.meta.url`: this project's vitest serves modules
// over http, so `fileURLToPath` refuses the URL. Read as a FILE at run time,
// never imported — a cross-boundary import is what `build-isolation.test.ts`
// refuses, and a test has no business dragging backend source into the SPA's
// module graph.
const API_UTIL = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'src/modules/users/utils/user-presence.util.ts',
)

/** Reads a `export const NAME = <expr>;` millisecond constant out of the API file. */
function apiConstant(source: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(source)
  expect(match, `${name} is no longer declared in the API util`).not.toBeNull()
  // The expressions are plain arithmetic on numeric literals (`5 * 60_000`).
  const expression = (match as RegExpExecArray)[1].replace(/_/g, '')
  expect(expression, `${name} is no longer a plain arithmetic literal`).toMatch(
    /^[\d\s*+]+$/,
  )
  return Number(new Function(`return (${expression})`)())
}

describe('presence thresholds, browser against API', () => {
  const source = readFileSync(API_UTIL, 'utf8')

  it('reads the API file at all', () => {
    // Anchors the two cases below: a path that stopped resolving would make
    // every regex miss and every comparison compare nothing.
    expect(source).toContain('resolveUserPresence')
    expect(source.length).toBeGreaterThan(500)
  })

  it('uses the same online threshold', () => {
    expect(PRESENCE_ONLINE_MS).toBe(apiConstant(source, 'PRESENCE_ONLINE_MS'))
  })

  it('uses the same away threshold', () => {
    expect(PRESENCE_AWAY_MS).toBe(apiConstant(source, 'PRESENCE_AWAY_MS'))
  })
})

describe('the shared dot', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('buckets a timestamp the way the API does', () => {
    expect(presenceFromLastSeen(ago(0), now)).toBe('online')
    expect(presenceFromLastSeen(ago(PRESENCE_ONLINE_MS - 1), now)).toBe('online')
    expect(presenceFromLastSeen(ago(PRESENCE_ONLINE_MS), now)).toBe('away')
    expect(presenceFromLastSeen(ago(PRESENCE_AWAY_MS - 1), now)).toBe('away')
    expect(presenceFromLastSeen(ago(PRESENCE_AWAY_MS), now)).toBe('offline')
    expect(presenceFromLastSeen(null, now)).toBe('offline')
    expect(presenceFromLastSeen('not a date', now)).toBe('offline')
  })

  it('treats a timestamp from the future as right now', () => {
    // Clock skew between the reporter and the operator's workstation. `offline`
    // is the one answer that is certainly wrong for someone just seen.
    expect(presenceFromLastSeen(new Date(now + 30_000).toISOString(), now)).toBe('online')
  })

  it("prefers the API's answer over its own arithmetic", () => {
    // The whole point: where the payload carries a bucket, the browser must not
    // recompute one. A row the API called `away` cannot render green here
    // merely because this machine's clock says otherwise.
    const justNow = new Date(now).toISOString()
    expect(presenceDotClass({ presence: 'away', lastSeenAt: justNow })).toContain('amber')
    expect(presenceDotClass({ presence: 'offline', lastSeenAt: justNow })).toContain(
      'muted-foreground',
    )
  })

  it('lets blocked win over any presence, on every screen', () => {
    // Two of the three old copies did this and the third did not, so a blocked
    // customer active a minute ago was green in the picker and red on the list.
    expect(presenceDotClass({ isBlocked: true, presence: 'online' })).toContain('destructive')
  })
})
