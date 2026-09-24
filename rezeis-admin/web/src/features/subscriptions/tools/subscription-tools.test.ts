/**
 * The three decisions of «Подписки» → «Инструменты» that fail silently: who
 * sees which tab, whether the button exists at all, and which tab an address
 * opens. `subscriptions-page.test.tsx` drives the same rules through the real
 * page; these pin each one on its own, so a regression names the rule it broke.
 */
import { describe, expect, it } from 'vitest'

import { SUBSCRIPTION_DELETE_REFUSAL_REMEDY_HREF } from '@/features/users/subscription-delete-refusals'
import {
  allowedToolTabs,
  resolveToolTab,
  SUBSCRIPTION_TOOL_PERMISSIONS,
  SUBSCRIPTION_TOOL_TABS,
  SUBSCRIPTION_TOOLS_PARAM,
  subscriptionToolsHref,
} from './subscription-tools'

/** An admin holding exactly these permission tokens. */
function holder(...tokens: string[]) {
  const granted = new Set(tokens)
  return (resource: string, action: string): boolean => granted.has(`${resource}:${action}`)
}

describe('which tabs an admin sees', () => {
  it('shows every tab, in sheet order, to an admin holding both permissions', () => {
    expect(allowedToolTabs(holder('subscriptions:edit', 'plans:view'))).toEqual([
      'merge',
      'squads',
      'unlinked',
      'extraProfiles',
      'lifetime',
    ])
  })

  it('gives subscriptions:edit the merge, the two link lists and the lifetime census — not the squads report', () => {
    expect(allowedToolTabs(holder('subscriptions:edit'))).toEqual([
      'merge',
      'unlinked',
      'extraProfiles',
      'lifetime',
    ])
  })

  it('gives plans:view the squads report and nothing that writes a subscription', () => {
    expect(allowedToolTabs(holder('plans:view'))).toEqual(['squads'])
  })

  it('gives an admin with neither nothing at all — the button is hidden', () => {
    expect(allowedToolTabs(holder('subscriptions:view', 'plans:edit'))).toEqual([])
  })

  it('names the permission each endpoint demands', () => {
    expect(SUBSCRIPTION_TOOL_PERMISSIONS).toEqual({
      merge: { resource: 'subscriptions', action: 'edit' },
      squads: { resource: 'plans', action: 'view' },
      unlinked: { resource: 'subscriptions', action: 'edit' },
      extraProfiles: { resource: 'subscriptions', action: 'edit' },
      lifetime: { resource: 'subscriptions', action: 'edit' },
    })
  })
})

describe('which tab an address opens', () => {
  const everything = [...SUBSCRIPTION_TOOL_TABS]

  it('honours a known tab the admin may see', () => {
    expect(resolveToolTab('lifetime', everything)).toBe('lifetime')
    expect(resolveToolTab('extraProfiles', everything)).toBe('extraProfiles')
  })

  it('opens the first allowed tab for a word this build does not know', () => {
    expect(resolveToolTab('repair', everything)).toBe('merge')
    expect(resolveToolTab('', ['squads'])).toBe('squads')
  })

  it('opens the first allowed tab — never the forbidden one — for a tab the admin may not see', () => {
    expect(resolveToolTab('lifetime', ['squads'])).toBe('squads')
    expect(resolveToolTab('squads', ['merge', 'unlinked', 'extraProfiles', 'lifetime'])).toBe('merge')
  })

  it('opens the first allowed tab when the address names none', () => {
    expect(resolveToolTab(null, ['unlinked', 'lifetime'])).toBe('unlinked')
  })

  it('opens nothing for an admin who may see no tab', () => {
    expect(resolveToolTab('merge', [])).toBeNull()
    expect(resolveToolTab(null, [])).toBeNull()
  })

  it('does not read an inherited object key as a tab', () => {
    expect(resolveToolTab('toString', everything)).toBe('merge')
    expect(resolveToolTab('constructor', everything)).toBe('merge')
  })

  it('writes the address other screens link to', () => {
    expect(SUBSCRIPTION_TOOLS_PARAM).toBe('tools')
    expect(subscriptionToolsHref('unlinked')).toBe('/subscriptions?tools=unlinked')
  })
})

describe('the user card’s delete refusal opens the tab that holds its fix', () => {
  it('points at «Подписки без привязки к Remnawave», spelled in the sheet’s own vocabulary', () => {
    const href = SUBSCRIPTION_DELETE_REFUSAL_REMEDY_HREF.stalePanelLink
    const url = new URL(href, 'https://panel.example')
    expect(url.pathname).toBe('/subscriptions')
    const requested = url.searchParams.get(SUBSCRIPTION_TOOLS_PARAM)
    // Resolved against an admin who may see every tab: a value the sheet does
    // not know would quietly fall to the first tab, «Слияние», instead.
    expect(resolveToolTab(requested, [...SUBSCRIPTION_TOOL_TABS])).toBe('unlinked')
    expect(href).toBe(subscriptionToolsHref('unlinked'))
  })
})
