const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const
const BYTE_BASE = 1024

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return 'Unknown'
  }
  if (value < BYTE_BASE) {
    return `${value} B`
  }
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(BYTE_BASE)), BYTE_UNITS.length - 1)
  const unitValue = value / BYTE_BASE ** unitIndex
  const maximumFractionDigits = unitValue >= 10 ? 0 : 1
  const formattedValue = new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(unitValue)
  return `${formattedValue} ${BYTE_UNITS[unitIndex]}`
}
