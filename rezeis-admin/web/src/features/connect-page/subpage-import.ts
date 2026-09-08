/**
 * subpage-import
 * ──────────────
 * Filling the cabinet's connect catalog from an exported Remnawave subscription
 * page.
 *
 * ── What this is, and what it is NOT ─────────────────────────────────────────
 *
 * It is a ONE-TIME conversion, run by an operator who already built a catalog on
 * the external page and does not want to type it a second time. It reads that
 * file, produces a v2 draft, and hands the draft to the editor for review.
 *
 * It is NOT compatibility. Nothing at runtime reads the donor's shape, and that
 * stays true: `connect-page.schema.ts` is ours, the cabinet renders ours, and
 * this module is the only place in either repository that has ever heard of
 * `svgIconKey`. Reading a file once is a favour to the operator; reading it
 * continuously would make their catalog a mirror of a project we do not control.
 *
 * ── What the file does NOT contain ───────────────────────────────────────────
 *
 * Sizes, corners, fonts, spacing — none of it. `brandingSettings` is a title, a
 * logo URL and a support URL; `uiConfig` is two block-STYLE switches for the
 * external page's own layout (`cards`, `accordion`, `timeline`, …); the rest is
 * meta tags and two booleans. The cabinet screen has one composition and takes
 * its geometry from the appearance settings, so none of that maps and none of
 * it is read here.
 *
 * ── Everything dropped is reported ───────────────────────────────────────────
 *
 * An import that silently loses half a catalog is worse than one that refuses:
 * the operator saves, the screen is short two platforms, and nothing anywhere
 * says why. Every decision this module makes lands in `report`.
 */

/** Donor platform key → the id our schema uses. */
const PLATFORM_IDS: Readonly<Record<string, string>> = {
  ios: 'ios',
  android: 'android',
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
  androidtv: 'androidtv',
  appletv: 'appletv',
}

const MAX_PLATFORMS = 20
const MAX_APPS_PER_PLATFORM = 30
const MAX_STEPS_PER_APP = 12
const MAX_BUTTONS_PER_STEP = 6
const MAX_ICONS = 200
const MAX_ICON_BYTES = 32 * 1024

export interface ImportReport {
  /** One line per decision, in the order they were made. */
  readonly notes: readonly string[]
  readonly platforms: number
  readonly apps: number
  readonly steps: number
  readonly icons: number
}

export interface ImportResult {
  readonly config: {
    version: number
    connectScreenEnabled?: boolean
    icons: Record<string, string>
    platforms: unknown[]
  }
  readonly report: ImportReport
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Donor keys are PascalCase (`DownloadIcon`, `ExternalLink`); ours are slugs.
 *
 * Lower-casing alone would collide `Happ` with `HAPP`, so collisions are
 * detected rather than assumed away — the caller renames the loser and says so.
 */
function slug(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z0-9]/.test(cleaned) ? cleaned : `x-${cleaned}`
}

/** `{en, ru}` in, `{en, ru}` out — but only the strings that are actually there. */
function localized(value: unknown): Record<string, string> | null {
  if (typeof value === 'string') {
    const text = value.trim()
    return text.length > 0 ? { ru: text, en: text } : null
  }
  if (!isRecord(value)) return null
  const out: Record<string, string> = {}
  for (const [lang, text] of Object.entries(value)) {
    if (/^[a-z]{2}$/.test(lang) && typeof text === 'string' && text.trim().length > 0) {
      out[lang] = text.trim()
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * The same drawing, ignoring how it was written.
 *
 * The export and our own library hold the SAME icons under different names —
 * `ClashMeta` there, `clash-meta` here — and their markup differs only in
 * whitespace, because ours was reflowed when it was brought in. Comparing bytes
 * therefore says "different" about drawings that are identical, and an import
 * would leave the operator with two libraries: fifteen pairs of the same logo
 * under two spellings, and no way to tell which one their catalog points at.
 */
function drawing(markup: string): string {
  return markup.replace(/\s+/g, '')
}

/**
 * Convert an exported subscription page into a connect-screen catalog draft.
 *
 * Throws only when the file is not one of these at all — everything else is a
 * note in the report, because a partial import an operator can see is worth more
 * than a refusal they cannot act on.
 */
export function importExternalSubpage(
  payload: unknown,
  options: {
    /**
     * The library the operator already has. An imported icon that IS one of
     * these keeps the existing key instead of arriving as a near-duplicate.
     */
    readonly existingIcons?: Readonly<Record<string, string>>
  } = {},
): ImportResult {
  if (!isRecord(payload) || !isRecord(payload['platforms'])) {
    throw new Error('Это не выгрузка страницы подписки: в файле нет раздела platforms')
  }
  const notes: string[] = []

  // ── icons ────────────────────────────────────────────────────────────────
  const icons: Record<string, string> = {}
  const iconKeyFor = new Map<string, string>()
  const existing = options.existingIcons ?? {}
  const existingByDrawing = new Map<string, string>()
  for (const [key, markup] of Object.entries(existing)) {
    // First key wins, so a library with its own duplicates does not shuffle.
    if (!existingByDrawing.has(drawing(markup))) existingByDrawing.set(drawing(markup), key)
  }
  const library = isRecord(payload['svgLibrary']) ? payload['svgLibrary'] : {}
  for (const [name, markup] of Object.entries(library)) {
    if (typeof markup !== 'string' || !markup.trim().startsWith('<svg')) {
      notes.push(`Иконка «${name}» пропущена: это не SVG`)
      continue
    }
    if (markup.length > MAX_ICON_BYTES) {
      notes.push(`Иконка «${name}» пропущена: больше ${Math.floor(MAX_ICON_BYTES / 1024)} КБ`)
      continue
    }
    if (Object.keys(icons).length >= MAX_ICONS) {
      notes.push(`Иконка «${name}» пропущена: больше ${MAX_ICONS} не помещается`)
      continue
    }
    const known = existingByDrawing.get(drawing(markup))
    if (known !== undefined) {
      // Already in the library under our own name. Keeping ours means the
      // catalog this import produces points at the icons the operator has been
      // looking at, rather than at a second copy that only differs in spelling.
      //
      // But this slot may already hold a DIFFERENT donor drawing that slugged
      // to the same key earlier in this loop — `Download` → `download`, then
      // `DownloadIcon` matching an existing `download` by drawing. Writing over
      // it destroyed the first drawing and silently repointed every app that
      // referenced it. So the earlier one is moved aside, exactly as an ordinary
      // collision is, and both names are said out loud.
      const displaced = icons[known]
      if (displaced !== undefined && drawing(displaced) !== drawing(existing[known])) {
        let n = 2
        while (icons[`${known}-${n}`] !== undefined) n += 1
        const moved = `${known}-${n}`
        icons[moved] = displaced
        for (const [donorName, mapped] of iconKeyFor) {
          if (mapped === known) iconKeyFor.set(donorName, moved)
        }
        notes.push(`Иконка «${known}» из выгрузки переименована в «${moved}»: имя занято вашей`)
      }
      icons[known] = existing[known]
      iconKeyFor.set(name, known)
      notes.push(`Иконка «${name}» уже есть в библиотеке под именем «${known}» — взята она`)
      continue
    }
    let key = slug(name)
    if (icons[key] !== undefined) {
      // Two donor names that slug to one key. Renaming beats overwriting: the
      // operator ends up with both drawings and a note saying which is which.
      let n = 2
      while (icons[`${key}-${n}`] !== undefined) n += 1
      notes.push(`Иконка «${name}» переименована в «${key}-${n}»: ключ уже занят`)
      key = `${key}-${n}`
    }
    icons[key] = markup.trim()
    iconKeyFor.set(name, key)
  }

  const iconRef = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.trim().length === 0) return null
    return iconKeyFor.get(value) ?? null
  }

  // ── platforms ────────────────────────────────────────────────────────────
  const platforms: unknown[] = []
  let appCount = 0
  let stepCount = 0

  for (const [donorKey, donorPlatform] of Object.entries(payload['platforms'])) {
    const id = PLATFORM_IDS[donorKey.toLowerCase()]
    if (id === undefined) {
      notes.push(`Платформа «${donorKey}» пропущена: кабинет её не знает`)
      continue
    }
    if (!isRecord(donorPlatform)) {
      notes.push(`Платформа «${donorKey}» пропущена: неожиданная форма записи`)
      continue
    }
    if (platforms.length >= MAX_PLATFORMS) {
      notes.push(`Платформа «${donorKey}» пропущена: больше ${MAX_PLATFORMS} не помещается`)
      continue
    }

    const title = localized(donorPlatform['displayName']) ?? { ru: donorKey, en: donorKey }
    const donorApps = Array.isArray(donorPlatform['apps']) ? donorPlatform['apps'] : []
    const apps: unknown[] = []
    const usedAppIds = new Set<string>()

    for (const donorApp of donorApps) {
      if (!isRecord(donorApp) || typeof donorApp['name'] !== 'string') {
        notes.push(`${id}: приложение пропущено — нет названия`)
        continue
      }
      const name = donorApp['name'].trim()
      if (apps.length >= MAX_APPS_PER_PLATFORM) {
        notes.push(`${id}: «${name}» пропущено — больше ${MAX_APPS_PER_PLATFORM} не помещается`)
        continue
      }

      let appId = slug(name)
      if (usedAppIds.has(appId)) {
        let n = 2
        while (usedAppIds.has(`${appId}-${n}`)) n += 1
        appId = `${appId}-${n}`
      }
      usedAppIds.add(appId)

      const steps: unknown[] = []
      let handsOver = false
      const blocks = Array.isArray(donorApp['blocks']) ? donorApp['blocks'] : []

      for (const block of blocks) {
        if (!isRecord(block)) continue
        // The schema refuses an app with more, so importing them produces a
        // draft the operator cannot save and cannot see the reason for.
        if (steps.length >= MAX_STEPS_PER_APP) {
          notes.push(`${id}/${name}: шаг пропущен — больше ${MAX_STEPS_PER_APP} не помещается`)
          continue
        }
        const stepTitle = localized(block['title'])
        if (stepTitle === null) {
          notes.push(`${id}/${name}: шаг пропущен — нет заголовка`)
          continue
        }
        const buttons: unknown[] = []
        for (const button of Array.isArray(block['buttons']) ? block['buttons'] : []) {
          if (!isRecord(button)) continue
          const label = localized(button['text'])
          const link = typeof button['link'] === 'string' ? button['link'].trim() : ''
          if (label === null || link.length === 0) {
            notes.push(`${id}/${name}: кнопка пропущена — нет надписи или ссылки`)
            continue
          }
          const kind = button['type']
          if (kind === 'external') {
            if (!/^https?:\/\//i.test(link)) {
              notes.push(`${id}/${name}: кнопка «${label['ru'] ?? link}» пропущена — ссылка не http(s)`)
              continue
            }
            buttons.push({ kind: 'external', label, url: link })
          } else if (kind === 'subscriptionLink') {
            if (!link.includes('{{SUBSCRIPTION_LINK}}')) {
              notes.push(
                `${id}/${name}: кнопка «${label['ru'] ?? link}» пропущена — в схеме нет {{SUBSCRIPTION_LINK}}`,
              )
              continue
            }
            // `encode` is derived by the server from where the placeholder sits;
            // guessing it here would be a second opinion about the one rule this
            // catalog deliberately keeps in exactly one place.
            buttons.push({ kind: 'deepLink', label, template: link })
            handsOver = true
          } else if (kind === 'copyButton') {
            buttons.push({ kind: 'copyLink', label })
            handsOver = true
          } else {
            notes.push(`${id}/${name}: кнопка типа «${String(kind)}» пропущена — такого типа нет`)
          }
          // One short of the ceiling, because the copy-link fallback below may
          // still need a slot on the last step.
          if (buttons.length >= MAX_BUTTONS_PER_STEP - 1) {
            notes.push(`${id}/${name}: остальные кнопки шага пропущены — больше ${MAX_BUTTONS_PER_STEP} не помещается`)
            break
          }
        }

        // The donor colours steps per block, and losing that on the way across
        // would be a visible downgrade for anyone who used it. Anything that is
        // not a hex literal is dropped rather than carried: the value lands in a
        // `style` attribute, and both our schema and the cabinet refuse the
        // rest.
        const donorColour = block['svgIconColor']
        const iconColor =
          typeof donorColour === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(donorColour.trim())
            ? donorColour.trim()
            : null
        if (donorColour !== undefined && iconColor === null) {
          notes.push(`${id}/${name}: цвет значка «${String(donorColour)}» пропущен — нужен вид #rrggbb`)
        }

        steps.push({
          title: stepTitle,
          body: localized(block['description']),
          iconKey: iconRef(block['svgIconKey']),
          iconColor,
          buttons,
        })
        stepCount += 1
      }

      if (steps.length === 0) {
        notes.push(`${id}: «${name}» пропущено — ни одного шага`)
        continue
      }
      if (!handsOver) {
        // Our schema refuses an app that cannot hand the subscription over, and
        // it is right to: the customer reads "tap Add below" under a card with
        // no button. Rather than let the save fail with the operator wondering
        // which app broke it, the fallback that always works is added here —
        // and said out loud, because it is content we invented.
        ;(steps[steps.length - 1] as { buttons: unknown[] }).buttons.push({
          kind: 'copyLink',
          label: { ru: 'Скопировать ссылку', en: 'Copy the link' },
        })
        notes.push(
          `${id}/${name}: добавлена кнопка «Скопировать ссылку» — иначе подписку нечем передать`,
        )
      }

      apps.push({
        id: appId,
        name,
        iconKey: iconRef(donorApp['svgIconKey']) ?? iconRef(name),
        featured: donorApp['featured'] === true,
        steps,
      })
      appCount += 1
    }

    if (apps.length === 0) {
      notes.push(`Платформа «${id}» пропущена: ни одного пригодного приложения`)
      continue
    }
    // Exactly one featured per platform is the schema's rule; the donor does not
    // enforce it.
    const featured = apps.filter((a) => (a as { featured: boolean }).featured)
    if (featured.length === 0) {
      ;(apps[0] as { featured: boolean }).featured = true
      notes.push(`${id}: рекомендованным отмечено «${(apps[0] as { name: string }).name}»`)
    } else if (featured.length > 1) {
      for (const extra of featured.slice(1)) (extra as { featured: boolean }).featured = false
      notes.push(
        `${id}: рекомендованным оставлено «${(featured[0] as { name: string }).name}», остальные сняты`,
      )
    }

    platforms.push({ id, title, iconKey: iconRef(donorPlatform['svgIconKey']), apps })
  }

  if (platforms.length === 0) {
    throw new Error('Из этого файла не вышло ни одной платформы, которую кабинет умеет показать')
  }

  // Named so the operator is not left wondering whether it silently kept them.
  for (const ignored of ['uiConfig', 'baseSettings', 'brandingSettings', 'baseTranslations']) {
    if (payload[ignored] !== undefined) {
      notes.push(`Раздел «${ignored}» не переносится: он описывает внешнюю страницу, а не этот экран`)
    }
  }

  return {
    config: { version: 2, icons, platforms },
    report: {
      notes,
      platforms: platforms.length,
      apps: appCount,
      steps: stepCount,
      icons: Object.keys(icons).length,
    },
  }
}
