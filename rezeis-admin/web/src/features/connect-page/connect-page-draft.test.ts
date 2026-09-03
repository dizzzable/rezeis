import { describe, expect, it } from 'vitest'

import {
  emptyApp,
  emptyButton,
  issuesFromError,
  moveItem,
  removeAt,
  replaceAt,
  setAppAt,
  slugify,
  type ConnectApp,
} from './connect-page-api'

/**
 * The parts of the catalog editor that decide something.
 *
 * The editor itself decides nothing about whether a catalog is valid — the API
 * does, and the editor asks it. What lives here is the draft arithmetic: moving
 * a row, minting an id, keeping "exactly one recommended app" true, and reading
 * the server's refusal back out. Each one is a place where being subtly wrong
 * costs an operator work they cannot see they are losing.
 */

const app = (id: string, featured = false): ConnectApp => ({
  id,
  name: id,
  iconKey: null,
  featured,
  steps: [],
})

describe('moving a row', () => {
  it('moves it and leaves the rest in order', () => {
    // Order is content: which app is offered first is a decision, so it has to
    // be editable and it has to be exact.
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
  })

  it('does nothing at the ends instead of wrapping around', () => {
    // Wrapping would silently send the first app to the bottom of the list on a
    // mis-tap, and the operator would have to notice the order changed.
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })

  it('never hands back the array it was given', () => {
    // The draft comes out of the query cache. Mutating it in place edits what
    // every other component sees, without a re-render to show it.
    const original = ['a', 'b']

    expect(moveItem(original, 0, 1)).not.toBe(original)
    expect(replaceAt(original, 0, 'z')).not.toBe(original)
    expect(removeAt(original, 0)).not.toBe(original)
    expect(original).toEqual(['a', 'b'])
  })
})

describe('minting an app id', () => {
  it('makes a slug out of whatever was typed', () => {
    expect(slugify('Clash Meta', [])).toBe('clash-meta')
    expect(slugify('  V2RayTun!  ', [])).toBe('v2raytun')
  })

  it('never collides with a sibling', () => {
    // Two apps sharing an id inside one platform makes a remembered choice
    // ambiguous — which is the one thing the id exists to settle.
    expect(slugify('Happ', ['happ'])).toBe('happ-2')
    expect(slugify('Happ', ['happ', 'happ-2'])).toBe('happ-3')
  })

  it('still produces something for a name with nothing usable in it', () => {
    expect(slugify('——', [])).toBe('app')
    expect(slugify('', ['app'])).toBe('app-2')
  })
})

describe('the recommended app', () => {
  it('unticks the previous one when a new one is ticked', () => {
    // The audit refuses a platform that recommends two, and the screen has to
    // open on exactly one. Leaving this to the operator means going to find
    // which app was recommended before in order to change your mind.
    const apps = [app('happ', true), app('streisand'), app('v2raytun')]

    const next = setAppAt(apps, 1, { ...apps[1], featured: true })

    expect(next.map((a) => a.featured)).toEqual([false, true, false])
  })

  it('leaves the others alone for an edit that is not about recommending', () => {
    const apps = [app('happ', true), app('streisand')]

    const next = setAppAt(apps, 1, { ...apps[1], name: 'Streisand VPN' })

    expect(next[0].featured).toBe(true)
    expect(next[1].name).toBe('Streisand VPN')
  })

  it('lets the recommended one be unticked without promoting anybody', () => {
    // Zero recommended is also refused by the audit — but it is a state the
    // operator has to be able to pass through on the way to picking another.
    const apps = [app('happ', true), app('streisand')]

    const next = setAppAt(apps, 0, { ...apps[0], featured: false })

    expect(next.map((a) => a.featured)).toEqual([false, false])
  })
})

describe('a new row', () => {
  it('starts an app with a step, because an app with none renders an empty card', () => {
    expect(emptyApp([]).steps).toHaveLength(1)
    expect(emptyApp(['app']).id).toBe('app-2')
  })

  it('gives a deep-link button the placeholder it cannot work without', () => {
    // A template with no placeholder is refused on save. Starting from one the
    // operator only has to complete is the difference between filling a field
    // and reading the documentation for it.
    expect(emptyButton('deepLink').template).toContain('{{SUBSCRIPTION_LINK}}')
    expect(emptyButton('external').url).toBe('')
    expect(emptyButton('copyLink').template).toBeUndefined()
  })
})

describe('reading the server back', () => {
  it('pulls the issue rows out of a refusal', () => {
    // The list is the point: a toast that says "invalid" sends the operator
    // hunting through forty rows for the one the server means.
    const issues = issuesFromError({
      response: {
        data: {
          message: 'The catalog would not work',
          issues: [{ path: 'platforms[0]', message: 'no recommended app' }],
        },
      },
    })

    expect(issues).toEqual([{ path: 'platforms[0]', message: 'no recommended app' }])
  })

  it('answers with nothing for a failure that carries no issues', () => {
    // A network error, a 500, a proxy page. The editor falls back to a plain
    // "could not save" rather than rendering an empty problem list as if the
    // catalog had been judged and found fine.
    expect(issuesFromError(new Error('offline'))).toEqual([])
    expect(issuesFromError({ response: { data: 'gateway timeout' } })).toEqual([])
    expect(issuesFromError(null)).toEqual([])
  })
})
