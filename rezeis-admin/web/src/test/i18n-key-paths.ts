/**
 * The one flattener the i18n specs share.
 *
 * It used to live inside `i18n/features/branding-bundle.test.ts`. The bundle
 * parity spec needs the identical traversal — two copies that drifted would
 * make one of the two suites quietly stop comparing what it claims to compare
 * — and a test file cannot import another test file without re-registering
 * that file's `describe` blocks into the importing suite. So it moved here,
 * under `src/test/`, which vitest's coverage config already excludes.
 *
 * Arrays and `null` are LEAVES, not containers: the dictionaries hold a few
 * string arrays, and descending into them would compare list lengths as if
 * they were key sets, which is a translator's decision and not a parity bug.
 */
type Dict = Record<string, unknown>

export function keyPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [prefix]
  return Object.entries(node as Dict).flatMap(([key, value]) =>
    keyPaths(value, prefix ? `${prefix}.${key}` : key),
  )
}

/** Reads the value at a dotted path produced by {@link keyPaths}. */
export function valueAt(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Dict)?.[part], root)
}
