import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planAttachmentBlobs } from './attachment-blobs'

const page = readFileSync(
  join(__dirname, '..', '..', 'features', 'support-tickets', 'support-tickets-page.tsx'),
  'utf8',
)

const shot = (id: string) => ({ id, filename: `${id}.png`, mimeType: 'image/png' })
const doc = (id: string) => ({ id, filename: `${id}.pdf`, mimeType: 'application/pdf' })

describe('planAttachmentBlobs', () => {
  it('asks for every image in the thread on a first pass', () => {
    const plan = planAttachmentBlobs(
      [{ attachments: [shot('a')] }, { attachments: [shot('b'), doc('c')] }],
      new Map(),
    )
    expect(plan.wanted.map((a) => a.id)).toEqual(['a', 'b'])
    expect(plan.stale).toEqual([])
  })

  it('asks for nothing it already holds', () => {
    // The thread is polled. Refetching every screenshot on every tick would put
    // a support queue into a download loop.
    const plan = planAttachmentBlobs(
      [{ attachments: [shot('a'), shot('b')] }],
      new Map([['a', 'blob:a']]),
    )
    expect(plan.wanted.map((x) => x.id)).toEqual(['b'])
  })

  it('asks for a repeated attachment id exactly once', () => {
    const plan = planAttachmentBlobs(
      [{ attachments: [shot('a')] }, { attachments: [shot('a')] }],
      new Map(),
    )
    expect(plan.wanted.map((x) => x.id)).toEqual(['a'])
  })

  it('releases a url whose attachment is no longer in the thread', () => {
    // The leak this exists to prevent: an operator working a queue accumulating
    // every screenshot the tab has ever shown.
    const plan = planAttachmentBlobs(
      [{ attachments: [shot('a')] }],
      new Map([
        ['a', 'blob:a'],
        ['gone', 'blob:gone'],
      ]),
    )
    expect(plan.stale).toEqual(['blob:gone'])
    expect(plan.wanted).toEqual([])
  })

  it('releases everything when the thread empties out', () => {
    const plan = planAttachmentBlobs(null, new Map([['a', 'blob:a']]))
    expect(plan.stale).toEqual(['blob:a'])
    expect(plan.wanted).toEqual([])
  })

  it('never asks for a non-image attachment', () => {
    const plan = planAttachmentBlobs([{ attachments: [doc('c')] }], new Map())
    expect(plan.wanted).toEqual([])
  })
})

describe('the ticket thread uses the previews', () => {
  it('renders an image inline instead of a download-only chip', () => {
    // The panel had no preview at all: every screenshot was a blob fetched into
    // a new tab, one at a time. These pin the inline path so it cannot quietly
    // revert to chips.
    expect(page).toContain('useAttachmentBlobs(ticket.id, ticket.messages)')
    expect(page).toContain('blobUrls.get(att.id)')
    expect(page).toContain('cursor-zoom-in rounded-lg object-contain')
  })

  it('keeps the download chip for everything that is not an image', () => {
    expect(page).toContain('return <AttachmentChip key={att.id} ticketId={ticketId} attachment={att} />')
  })

  it('pages across the whole thread, and shows the same bytes it fetched once', () => {
    expect(page).toContain('collectViewableAttachments(ticket.messages')
    expect(page).toContain('indexOfAttachment(viewable, att.id)')
    expect(page).toContain('viewer.element')
  })
})
