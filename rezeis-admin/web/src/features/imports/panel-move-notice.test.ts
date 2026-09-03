import { describe, expect, it } from 'vitest'

import { panelMoveField } from './panel-move-report'

/**
 * The one block on this screen that reports a thing the operator cannot undo
 * by re-running the import: the backup came from a DIFFERENT Remnawave panel,
 * so every migrated customer is waiting for a profile — and therefore for a
 * new connection link.
 *
 * The panel and the API ship as separate images, so this is a contract read by
 * hand out of a free-form result payload. A silent rename on the other side
 * turns the block off and the operator hears about the new links from support
 * tickets instead. These assertions are that contract written down.
 */

const REPORT = {
  panelRelationship: {
    verdict: 'different',
    reason: 'the panel has none of the 25 profiles checked',
    sampled: 25,
    matchedOwners: 0,
    mismatchedOwners: 0,
    absent: 25,
    unconfirmed: 0,
    profilesToCreate: 812,
  },
}

describe('the different-panel notice', () => {
  it('reads the verdict and the number of profiles still to create', () => {
    expect(panelMoveField(REPORT)).toEqual({ profilesToCreate: 812 })
  })

  it('stays silent on every ordinary import', () => {
    // `same` is the case every import before this one was, and `unknown` means
    // the run refused to decide — neither is news, and a warning banner on a
    // normal migration is a warning operators learn to scroll past.
    for (const verdict of ['same', 'unknown']) {
      expect(panelMoveField({ panelRelationship: { ...REPORT.panelRelationship, verdict } })).toBeNull()
    }
  })

  it('says nothing for an importer that does not report a verdict at all', () => {
    // Five of the six importers on this page never write the field. Reading a
    // missing block as a panel move would put the banner on all of them.
    expect(panelMoveField({ created: 10 })).toBeNull()
    expect(panelMoveField({ panelRelationship: null })).toBeNull()
    expect(panelMoveField({ panelRelationship: ['different'] })).toBeNull()
  })

  it('still shows the notice when the count is missing', () => {
    // The verdict is the news; the count is detail. Dropping the whole block
    // because one number failed to arrive would hide the part that matters.
    expect(panelMoveField({ panelRelationship: { verdict: 'different' } })).toEqual({
      profilesToCreate: 0,
    })
  })
})
