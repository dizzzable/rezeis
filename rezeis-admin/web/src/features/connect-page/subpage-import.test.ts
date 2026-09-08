import { describe, expect, it } from 'vitest'

import { importExternalSubpage } from './subpage-import'

/**
 * READING AN EXPORTED SUBSCRIPTION PAGE, ONCE.
 *
 * An operator who already built a catalog on the external Remnawave page should
 * not have to type it again. This converts their export into a v2 draft they
 * then review and save.
 *
 * Two things the cases below are really about:
 *
 * 1. NOTHING IS LOST SILENTLY. An import that quietly drops two platforms is
 *    worse than one that refuses: the operator saves, the screen is short, and
 *    nothing anywhere says why. Every decision has to reach `report.notes`.
 * 2. WHAT COMES OUT MUST BE SAVEABLE. Our schema refuses an app that cannot hand
 *    the subscription over, and refuses more than one featured app per platform.
 *    An import that produces a config the save then rejects has helped nobody.
 *
 * Checked against a real export separately — 7 platforms, 24 apps, 92 steps and
 * 39 icons went through with no losses. The fixture here is small on purpose:
 * a test that reads a file outside the repository cannot run in CI.
 */

const EXPORT = {
  version: '1',
  locales: ['en', 'ru'],
  uiConfig: { subscriptionInfoBlockType: 'cards' },
  brandingSettings: { title: '2GET', logoUrl: 'https://x/logo.svg' },
  svgLibrary: {
    Happ: '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>',
    DownloadIcon: '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>',
    NotAnIcon: 'oops',
  },
  platforms: {
    ios: {
      displayName: { en: 'iOS', ru: 'iOS' },
      svgIconKey: 'DownloadIcon',
      apps: [
        {
          name: 'Happ',
          svgIconKey: 'Happ',
          featured: true,
          blocks: [
            {
              title: { en: 'Install', ru: 'Установка' },
              description: { en: 'Get it', ru: 'Скачайте' },
              svgIconKey: 'DownloadIcon',
              svgIconColor: '#7B93AB',
              buttons: [
                { type: 'external', link: 'https://apps.apple.com/app/x', text: { ru: 'App Store' } },
              ],
            },
            {
              title: { ru: 'Добавьте' },
              buttons: [
                {
                  type: 'subscriptionLink',
                  link: 'happ://add/{{SUBSCRIPTION_LINK}}',
                  text: { ru: 'Добавить' },
                },
              ],
            },
          ],
        },
      ],
    },
    windowsPhone: { displayName: { en: 'Windows Phone' }, apps: [] },
  },
}

describe('an export the operator actually has', () => {
  it('produces platforms the cabinet knows, keyed our way', () => {
    const { config } = importExternalSubpage(EXPORT)
    expect((config.platforms as { id: string }[]).map((p) => p.id)).toEqual(['ios'])
  })

  it('carries both languages through', () => {
    const { config } = importExternalSubpage(EXPORT)
    const platform = (config.platforms as { title: Record<string, string> }[])[0]
    expect(platform.title).toEqual({ en: 'iOS', ru: 'iOS' })
  })

  it('turns blocks into steps and keeps their order', () => {
    const { config } = importExternalSubpage(EXPORT)
    const app = (config.platforms as { apps: { steps: { title: Record<string, string> }[] }[] }[])[0]
      .apps[0]
    expect(app.steps.map((s) => s.title.ru)).toEqual(['Установка', 'Добавьте'])
  })

  it('maps the two button types onto ours and leaves `encode` to the server', () => {
    // `encode` is derived from where the placeholder sits, and that rule lives
    // in exactly one place on purpose. Guessing it here would be a second copy.
    const { config } = importExternalSubpage(EXPORT)
    const steps = (
      config.platforms as { apps: { steps: { buttons: Record<string, unknown>[] }[] }[] }[]
    )[0].apps[0].steps
    expect(steps[0].buttons[0]).toEqual({
      kind: 'external',
      label: { ru: 'App Store' },
      url: 'https://apps.apple.com/app/x',
    })
    expect(steps[1].buttons[0]).toEqual({
      kind: 'deepLink',
      label: { ru: 'Добавить' },
      template: 'happ://add/{{SUBSCRIPTION_LINK}}',
    })
    expect(steps[1].buttons[0]).not.toHaveProperty('encode')
  })

  it('renames donor icon keys into slugs the schema accepts', () => {
    const { config } = importExternalSubpage(EXPORT)
    expect(Object.keys(config.icons).sort()).toEqual(['downloadicon', 'happ'])
    const platform = (config.platforms as { iconKey: string; apps: { iconKey: string }[] }[])[0]
    expect(platform.iconKey).toBe('downloadicon')
    expect(platform.apps[0].iconKey).toBe('happ')
  })
})

describe('everything dropped is said out loud', () => {
  it('names a platform the cabinet does not have', () => {
    const { report } = importExternalSubpage(EXPORT)
    expect(report.notes.some((n) => n.includes('windowsPhone'))).toBe(true)
  })

  it('names an icon that is not one', () => {
    const { report } = importExternalSubpage(EXPORT)
    expect(report.notes.some((n) => n.includes('NotAnIcon'))).toBe(true)
  })

  it('names a button type it has never heard of', () => {
    const { report } = importExternalSubpage(withButton({ type: 'qrCode', link: 'x', text: { ru: 'QR' } }))
    expect(report.notes.some((n) => n.includes('qrCode'))).toBe(true)
  })

  it('names a deep link with no placeholder in it', () => {
    // Substituted nowhere, this button opens the app and adds nothing — which
    // reads to a customer as a broken button rather than a misconfigured one.
    const { report } = importExternalSubpage(
      withButton({ type: 'subscriptionLink', link: 'happ://add/', text: { ru: 'Добавить' } }),
    )
    expect(report.notes.some((n) => n.includes('SUBSCRIPTION_LINK'))).toBe(true)
  })

  it('names the sections it does not carry over', () => {
    // The operator asked whether the sizes come across. They do not exist:
    // `uiConfig` is two block-STYLE switches for the external page's own layout
    // and `brandingSettings` is a title and two URLs. Saying so beats letting
    // them wonder whether it silently kept them.
    const { report } = importExternalSubpage(EXPORT)
    expect(report.notes.some((n) => n.includes('uiConfig'))).toBe(true)
    expect(report.notes.some((n) => n.includes('brandingSettings'))).toBe(true)
  })

  it('counts what it produced', () => {
    const { report } = importExternalSubpage(EXPORT)
    expect(report).toMatchObject({ platforms: 1, apps: 1, steps: 2, icons: 2 })
  })
})

describe('what comes out has to survive the save', () => {
  it('gives an app with no hand-over a copy button, and says it did', () => {
    // Our schema refuses an app whose steps cannot hand the subscription over.
    // Importing one as-is would make the save fail with the operator guessing
    // which app broke it; inventing the fallback silently would be worse.
    const noHandover = {
      ...EXPORT,
      platforms: {
        ios: {
          displayName: { ru: 'iOS' },
          apps: [
            {
              name: 'Reader',
              blocks: [{ title: { ru: 'Установка' }, buttons: [] }],
            },
          ],
        },
      },
    }
    const { config, report } = importExternalSubpage(noHandover)
    const steps = (
      config.platforms as { apps: { steps: { buttons: { kind: string }[] }[] }[] }[]
    )[0].apps[0].steps
    expect(steps[0].buttons.map((b) => b.kind)).toEqual(['copyLink'])
    expect(report.notes.some((n) => n.includes('Скопировать ссылку'))).toBe(true)
  })

  it('leaves exactly one recommended app per platform', () => {
    const twoFeatured = {
      ...EXPORT,
      platforms: {
        ios: {
          displayName: { ru: 'iOS' },
          apps: [
            { name: 'A', featured: true, blocks: [handoverBlock()] },
            { name: 'B', featured: true, blocks: [handoverBlock()] },
          ],
        },
      },
    }
    const { config, report } = importExternalSubpage(twoFeatured)
    const apps = (config.platforms as { apps: { featured: boolean }[] }[])[0].apps
    expect(apps.filter((a) => a.featured)).toHaveLength(1)
    expect(report.notes.some((n) => n.includes('рекомендованным'))).toBe(true)
  })

  it('marks one when the donor marked none', () => {
    const none = {
      ...EXPORT,
      platforms: {
        ios: { displayName: { ru: 'iOS' }, apps: [{ name: 'A', blocks: [handoverBlock()] }] },
      },
    }
    const apps = (
      importExternalSubpage(none).config.platforms as { apps: { featured: boolean }[] }[]
    )[0].apps
    expect(apps[0].featured).toBe(true)
  })

  it('keeps two donor names that slug the same, renaming the second', () => {
    const clash = {
      ...EXPORT,
      svgLibrary: {
        Happ: '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>',
        HAPP: '<svg viewBox="0 0 1 1"><path d="M1 1h1v1z"/></svg>',
      },
    }
    const { config, report } = importExternalSubpage(clash)
    // Both drawings survive — overwriting would lose one with nothing said.
    expect(Object.keys(config.icons).sort()).toEqual(['happ', 'happ-2'])
    expect(report.notes.some((n) => n.includes('переименована'))).toBe(true)
  })
})

describe('a file that is not one', () => {
  it('refuses anything without a platforms section', () => {
    for (const bad of [null, 42, 'text', {}, { platforms: [] }]) {
      expect(() => importExternalSubpage(bad), JSON.stringify(bad)).toThrow()
    }
  })

  it('refuses an export whose every platform is unknown', () => {
    expect(() =>
      importExternalSubpage({ platforms: { symbian: { displayName: { ru: 'S' }, apps: [] } } }),
    ).toThrow()
  })
})

function handoverBlock() {
  return {
    title: { ru: 'Добавьте' },
    buttons: [
      { type: 'subscriptionLink', link: 'x://add/{{SUBSCRIPTION_LINK}}', text: { ru: 'Добавить' } },
    ],
  }
}

function withButton(button: Record<string, unknown>) {
  return {
    ...EXPORT,
    platforms: {
      ios: {
        displayName: { ru: 'iOS' },
        apps: [{ name: 'A', blocks: [{ title: { ru: 'Шаг' }, buttons: [button] }] }],
      },
    },
  }
}

describe('reusing the library the operator already has', () => {
  /**
   * The export and our own library hold the SAME logos under different names —
   * `ClashMeta` there, `clash-meta` here — so without this an import doubles
   * the library and the operator cannot tell which of two identical marks their
   * catalog points at.
   *
   * The whole path was untested, and it destroyed a drawing: the reuse branch
   * wrote over a key an earlier donor icon had already claimed.
   */
  const A = '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>'
  const Z = '<svg viewBox="0 0 1 1"><path d="M1 1h1v1z"/></svg>'

  const withLibrary = (library: Record<string, string>, iconKey: string) => ({
    ...EXPORT,
    svgLibrary: library,
    platforms: {
      ios: {
        displayName: { ru: 'iOS' },
        apps: [
          {
            name: 'A',
            svgIconKey: iconKey,
            blocks: [
              {
                title: { ru: 'Добавьте' },
                buttons: [
                  { type: 'subscriptionLink', link: 'x://add/{{SUBSCRIPTION_LINK}}', text: { ru: 'Добавить' } },
                ],
              },
            ],
          },
        ],
      },
    },
  })

  it('keeps our name for a drawing we already have', () => {
    const { config, report } = importExternalSubpage(
      withLibrary({ ClashMeta: Z }, 'ClashMeta'),
      { existingIcons: { 'clash-meta': Z } },
    )
    expect(Object.keys(config.icons)).toEqual(['clash-meta'])
    expect((config.platforms as { apps: { iconKey: string }[] }[])[0].apps[0].iconKey).toBe('clash-meta')
    expect(report.notes.some((n) => n.includes('clash-meta'))).toBe(true)
  })

  it('does not destroy a donor drawing that claimed the key first', () => {
    // `Download` slugs to `download` and is stored; then `DownloadIcon` matches
    // our existing `download` BY DRAWING and used to overwrite it — the first
    // drawing gone, and the app silently pointing at a different logo.
    const { config, report } = importExternalSubpage(
      withLibrary({ Download: A, DownloadIcon: Z }, 'Download'),
      { existingIcons: { download: Z } },
    )
    const keys = Object.keys(config.icons).sort()
    expect(keys).toHaveLength(2)
    expect(Object.values(config.icons)).toContain(A)
    // …and the app still points at the drawing the donor named for it.
    const app = (config.platforms as { apps: { iconKey: string }[] }[])[0].apps[0]
    expect(config.icons[app.iconKey]).toBe(A)
    expect(report.notes.some((n) => n.includes('переименована'))).toBe(true)
  })

  it('says something even when the donor name and ours slug the same', () => {
    // The silent case: `slug("Happ") === "happ" === known`, so the note was
    // skipped and a drawing vanished with nothing reported at all.
    const { report } = importExternalSubpage(
      withLibrary({ HAPP: A, Happ: Z }, 'HAPP'),
      { existingIcons: { happ: Z } },
    )
    expect(report.notes.some((n) => n.includes('happ'))).toBe(true)
  })
})

describe('what the schema will accept', () => {
  it('stops at the step ceiling instead of producing an unsaveable app', () => {
    const many = {
      ...EXPORT,
      platforms: {
        ios: {
          displayName: { ru: 'iOS' },
          apps: [
            {
              name: 'A',
              blocks: Array.from({ length: 20 }, (_, i) => ({
                title: { ru: `Шаг ${i}` },
                buttons:
                  i === 0
                    ? [{ type: 'subscriptionLink', link: 'x://a/{{SUBSCRIPTION_LINK}}', text: { ru: 'Добавить' } }]
                    : [],
              })),
            },
          ],
        },
      },
    }
    const { config, report } = importExternalSubpage(many)
    const steps = (config.platforms as { apps: { steps: unknown[] }[] }[])[0].apps[0].steps
    expect(steps.length).toBeLessThanOrEqual(12)
    expect(report.notes.some((n) => n.includes('12'))).toBe(true)
  })

  it('stops at the button ceiling, leaving room for the fallback', () => {
    const many = {
      ...EXPORT,
      platforms: {
        ios: {
          displayName: { ru: 'iOS' },
          apps: [
            {
              name: 'A',
              blocks: [
                {
                  title: { ru: 'Шаг' },
                  buttons: Array.from({ length: 12 }, (_, i) => ({
                    type: 'external',
                    link: `https://e.test/${i}`,
                    text: { ru: `Кнопка ${i}` },
                  })),
                },
              ],
            },
          ],
        },
      },
    }
    const { config } = importExternalSubpage(many)
    const steps = (config.platforms as { apps: { steps: { buttons: unknown[] }[] }[] }[])[0].apps[0]
      .steps
    for (const step of steps) expect(step.buttons.length).toBeLessThanOrEqual(6)
  })

  it('drops a step colour that is not a colour, and keeps one that is', () => {
    const coloured = (value: unknown) => ({
      ...EXPORT,
      platforms: {
        ios: {
          displayName: { ru: 'iOS' },
          apps: [
            {
              name: 'A',
              blocks: [
                {
                  title: { ru: 'Шаг' },
                  svgIconColor: value,
                  buttons: [
                    { type: 'subscriptionLink', link: 'x://a/{{SUBSCRIPTION_LINK}}', text: { ru: 'Добавить' } },
                  ],
                },
              ],
            },
          ],
        },
      },
    })
    const colourOf = (payload: unknown) =>
      (
        importExternalSubpage(payload).config.platforms as {
          apps: { steps: { iconColor: string | null }[] }[]
        }[]
      )[0].apps[0].steps[0].iconColor

    expect(colourOf(coloured('#4FC4DD'))).toBe('#4FC4DD')
    // Five and seven digits are not colours — the browser drops the whole
    // declaration, so accepting them made the operator's choice do nothing.
    for (const bad of ['#12345', '#1234567', 'red', 'var(--x)', 'url(#g)']) {
      expect(colourOf(coloured(bad)), bad).toBeNull()
    }
  })
})
