import { describe, expect, it } from 'vitest'

import { computeSystemButtons } from './utils'

/**
 * The buttons reiwa adds to its built-in invite screen, as the constructor's
 * canvas draws them. reiwa added «🌐 Скопировать ссылку на сайт» on 22.09.2026
 * and neither this list nor the inspector's preview beside it
 * (`ScreenEditorPanel`) showed it — two copies of the same list, and the
 * operator's picture of the bot was missing a button either way.
 */
describe('the invite screen on the canvas', () => {
  it('shows the website-link button reiwa adds, right after «Скопировать ссылку», where reiwa puts it', () => {
    const invite = { name: 'invite', isRoot: false, buttons: [] } as unknown as Parameters<
      typeof computeSystemButtons
    >[0]
    expect(computeSystemButtons(invite).map((button) => button.key)).toEqual([
      'invite-share',
      'invite-copy',
      'invite-copy-web',
      'invite-back',
    ])
  })
})
