export function formatBytes(bytes: number | null | undefined, decimals = 2): string {
  if (bytes === null || bytes === undefined || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[Math.min(i, sizes.length - 1)]}`
}

export function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function formatMemory(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(0)} MB`
}

export function getNodeStatusColor(node: { isConnected: boolean; isDisabled: boolean; isConnecting: boolean }): string {
  if (node.isDisabled) return 'text-muted-foreground'
  if (node.isConnecting) return 'text-yellow-500'
  if (node.isConnected) return 'text-emerald-500'
  return 'text-destructive'
}

export function getNodeStatusLabel(node: { isConnected: boolean; isDisabled: boolean; isConnecting: boolean }): string {
  if (node.isDisabled) return 'Disabled'
  if (node.isConnecting) return 'Connecting'
  if (node.isConnected) return 'Online'
  return 'Offline'
}

export function getCountryEmoji(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return '🌐'
  const code = countryCode.toUpperCase()
  return String.fromCodePoint(...[...code].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65))
}

export function getBandwidthDelta(current: number, previous: number): { label: string; positive: boolean } {
  if (previous === 0) return { label: '—', positive: true }
  const pct = ((current - previous) / previous) * 100
  return { label: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, positive: pct >= 0 }
}


/**
 * Summarises the raw node list returned by `/api/nodes` into the same
 * three categories the Remnawave UI shows on its dashboard:
 *
 *   • online   — `isConnected` and not `isDisabled`
 *   • offline  — not `isConnected` and not `isDisabled` (the node is enabled
 *                but the panel can't reach it right now)
 *   • disabled — the operator turned it off (`isDisabled`)
 *
 * `total = online + offline + disabled`. We compute this on the client side
 * because the `/api/system/stats` `nodes.totalOnline` counter changed
 * semantics across Remnawave versions and no longer matches the panel's UI
 * counter on 2.7.x.
 */
export interface NodeStatsSummary {
  readonly total: number
  readonly online: number
  readonly offline: number
  readonly disabled: number
}

export function summarizeNodes(
  nodes: readonly { isConnected?: boolean; isDisabled?: boolean }[],
): NodeStatsSummary {
  let online = 0
  let offline = 0
  let disabled = 0
  for (const node of nodes) {
    if (node.isDisabled) {
      disabled += 1
      continue
    }
    if (node.isConnected) {
      online += 1
    } else {
      offline += 1
    }
  }
  return { total: nodes.length, online, offline, disabled }
}


/**
 * Strip a leading country-code prefix from a node/host display name when it
 * duplicates the rendered flag.
 *
 * Operators in Remnawave typically prefix names with the ISO code:
 *   "DE Germany 09" / "PL · Poland 06" / "LV-Latvia 03"
 * Once we render the flag SVG, that 2-letter prefix becomes redundant noise.
 *
 * Conditions that trigger the strip:
 *   • the input starts with a 2-letter ISO code (case-insensitive),
 *   • optionally followed by space, dot, dash, slash, pipe, colon, middle-dot,
 *   • that code matches the resolved country.
 *
 * Falls through to the original string when nothing was stripped, so we
 * never produce an empty label.
 */
export function stripCountryPrefix(input: string, countryCode: string): string {
  if (!input) return ''
  if (!countryCode) return input
  const safeCode = countryCode.replace(/[^A-Za-z]/g, '')
  if (safeCode.length !== 2) return input
  const pattern = new RegExp(`^\\s*${safeCode}[\\s·:|/\\-]+`, 'i')
  const stripped = input.replace(pattern, '').trim()
  return stripped.length > 0 ? stripped : input
}
