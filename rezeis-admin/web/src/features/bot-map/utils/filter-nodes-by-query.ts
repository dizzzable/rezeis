/**
 * filterNodesByQuery — pure search predicate.
 *
 * Matches a node when the query (case-insensitive, trimmed) appears in
 * any of: `title`, `group`, the kind-specific identifier
 * (`shortId` / `type` / `route` / `buttonId` of any reply button / the text
 * keys of a built-in screen), or
 * the surrounding RU/EN copy when applicable. Empty / whitespace-only
 * queries return the input unchanged.
 *
 * Designed to filter ≤ 16 ms over a 200-node corpus per the spec
 * (Requirement 9.4), so we walk the array linearly with simple string
 * matches — no regex compilation per call, no string allocation per
 * node beyond the lower-cased haystack.
 */
import { systemScreenById } from '@/features/bot-flow/system-screens'

import type { BotMapNode } from '../types'

export function filterNodesByQuery(
  nodes: ReadonlyArray<BotMapNode>,
  query: string,
): ReadonlyArray<BotMapNode> {
  const trimmed = query.trim().toLowerCase()
  if (trimmed.length === 0) return nodes
  return nodes.filter((node) => nodeMatchesQuery(node, trimmed))
}

function nodeMatchesQuery(node: BotMapNode, query: string): boolean {
  if (node.title.toLowerCase().includes(query)) return true
  if (node.group.toLowerCase().includes(query)) return true
  switch (node.kind) {
    case 'graph-screen':
      return (
        node.shortId.toLowerCase().includes(query) ||
        node.textRu.toLowerCase().includes(query) ||
        node.textEn.toLowerCase().includes(query)
      )
    case 'reply-keyboard':
      return node.buttons.some(
        (b) =>
          b.buttonId.toLowerCase().includes(query) ||
          b.label.toLowerCase().includes(query),
      )
    case 'notification':
      return (
        node.type.toLowerCase().includes(query) ||
        node.titleRu.toLowerCase().includes(query) ||
        (node.titleEn ?? '').toLowerCase().includes(query) ||
        node.bodyRu.toLowerCase().includes(query) ||
        (node.bodyEn ?? '').toLowerCase().includes(query)
      )
    case 'mini-app-terminal':
      return (
        node.route.toLowerCase().includes(query) ||
        node.descriptionRu.toLowerCase().includes(query) ||
        node.descriptionEn.toLowerCase().includes(query)
      )
    case 'system-screen': {
      // By the keys it sends too, its buttons' captions among them: an
      // operator who met `channel.required` in «Тексты» finds the screen
      // that sends it.
      const screen = systemScreenById(node.screenId)
      if (screen === null) return false
      return (
        screen.texts.some((text) => text.key.toLowerCase().includes(query)) ||
        screen.buttons.some((button) => (button.textKey ?? '').toLowerCase().includes(query))
      )
    }
  }
}
