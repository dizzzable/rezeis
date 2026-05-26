#!/usr/bin/env node
/**
 * Sync country flag SVGs from `country-flag-icons/3x2` into `src/flags/`.
 *
 * Why we vendor instead of using `import.meta.glob` against node_modules:
 * Vite/Rollup ship inconsistent behaviour for `node_modules`-based globs in
 * production builds — they sometimes strip the entire dictionary down to a
 * single match, which silently breaks the flags table at runtime.
 * Vendoring the SVGs into our src tree turns the lookup into a fully
 * deterministic local glob.
 *
 * Runs automatically before every dev server / production build via the
 * `predev` / `prebuild` npm script. Idempotent — safe to call repeatedly.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const src = join(root, 'node_modules', 'country-flag-icons', '3x2')
const dst = join(root, 'src', 'flags')

async function main() {
  let entries
  try {
    entries = await readdir(src)
  } catch (err) {
    console.error(`[sync-flags] cannot read ${src}: ${err.message}`)
    process.exit(1)
  }

  await mkdir(dst, { recursive: true })

  let copied = 0
  for (const name of entries) {
    if (!name.endsWith('.svg')) continue
    const from = join(src, name)
    const to = join(dst, name)
    try {
      const fromStat = await stat(from)
      let toStat
      try {
        toStat = await stat(to)
      } catch {
        toStat = null
      }
      if (toStat && toStat.size === fromStat.size && toStat.mtimeMs >= fromStat.mtimeMs) {
        continue
      }
    } catch {
      // best-effort: if stat fails we still copy
    }
    await copyFile(from, to)
    copied += 1
  }
  console.log(`[sync-flags] ${copied} flag SVG(s) updated in ${dst}`)
}

main().catch((err) => {
  console.error(`[sync-flags] failed: ${err.stack ?? err.message}`)
  process.exit(1)
})
