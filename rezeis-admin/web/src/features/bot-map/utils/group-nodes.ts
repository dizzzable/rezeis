/**
 * groupNodes — fold a flat node list into the rail's group structure.
 *
 * Group order is fixed (graph → reply → notifications by category →
 * Mini App terminals) so the rail stays predictable as nodes come and
 * go. Inside each group, items are sorted alphabetically by title;
 * graph screens with `isRoot=true` always lead their group so the
 * operator sees the start screen first.
 */
import type { BotMapNode } from '../types'

export interface NodeGroup {
  readonly key: string
  readonly nodes: ReadonlyArray<BotMapNode>
}

const GROUP_ORDER: ReadonlyArray<string> = [
  'graph',
  'reply',
  // The bot's screens with no flow block (`withBuiltInNodes`), next to the
  // other things the bot builds by itself.
  'system',
  'notification:expires',
  'notification:referral',
  'notification:partner',
  'notification:promocode',
  'notification:system',
  'notification:other',
  'terminal',
]

export function groupNodes(nodes: ReadonlyArray<BotMapNode>): ReadonlyArray<NodeGroup> {
  const buckets = new Map<string, BotMapNode[]>()
  for (const node of nodes) {
    const bucket = buckets.get(node.group) ?? []
    bucket.push(node)
    buckets.set(node.group, bucket)
  }
  for (const bucket of buckets.values()) {
    bucket.sort(compareNodes)
  }
  // Emit groups in the canonical order; any unknown group lands at the end
  // alphabetically so a future server-side group key shows up gracefully.
  const ordered = GROUP_ORDER.filter((key) => buckets.has(key))
  const extras = [...buckets.keys()].filter((k) => !GROUP_ORDER.includes(k)).sort()
  return [...ordered, ...extras].map((key) => ({
    key,
    nodes: buckets.get(key) ?? [],
  }))
}

function compareNodes(a: BotMapNode, b: BotMapNode): number {
  const aRoot = a.kind === 'graph-screen' && a.isRoot ? 0 : 1
  const bRoot = b.kind === 'graph-screen' && b.isRoot ? 0 : 1
  if (aRoot !== bRoot) return aRoot - bRoot
  return a.title.localeCompare(b.title)
}
