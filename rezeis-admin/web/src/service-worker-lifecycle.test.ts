import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/sw.ts'), 'utf8')
const registrationSource = readFileSync(
  resolve(process.cwd(), 'src/lib/register-sw.ts'),
  'utf8',
)

describe('service worker lifecycle registration', () => {
  it('registers Workbox cache cleanup during initial script evaluation', () => {
    const cleanupIndex = source.indexOf('cleanupOutdatedCaches()')
    const activateIndex = source.indexOf("self.addEventListener('activate'")
    const activateBody = source.slice(activateIndex, source.indexOf('// Application shell'))

    expect(cleanupIndex).toBeGreaterThan(-1)
    expect(cleanupIndex).toBeLessThan(activateIndex)
    expect(activateBody).not.toContain('cleanupOutdatedCaches()')
  })

  it('only removes caches owned by Rezeis', () => {
    expect(source).toContain('ownedCachePrefixes')
    expect(source).toContain('name.startsWith(prefix)')
    expect(source).not.toContain("!name.startsWith('workbox-precache')")
  })

  it('leaves update reload ownership to the auto-update registration helper', () => {
    expect(registrationSource).not.toContain('controllerchange')
    expect(registrationSource).toContain('registration.update().catch')
  })
})
