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
