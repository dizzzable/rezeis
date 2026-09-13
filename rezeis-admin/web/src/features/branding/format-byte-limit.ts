/**
 * Bytes as an operator reads them. Binary units, because that is what the
 * server constants are written in (`512 * 1024`, `2 * 1024 * 1024`,
 * `96 * 1024`) — rounding 512 KiB to "524 KB" would print a number that
 * appears nowhere else. Shared by the branding image slots
 * (`branding-asset-field.tsx`) and the QR tab's logo upload, which state
 * their ceilings the same way.
 */
export function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  }
  const kb = bytes / 1024
  return `${Number.isInteger(kb) ? kb : Math.round(kb)} KB`
}
