import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  QR_PREVIEW_PARTNER_LINK,
  QR_PREVIEW_PARTNER_PX,
  QR_PREVIEW_REFERRAL_PX,
} from './qr-style-section'

// The API's own link builder and code minter — imported, not restated, the way
// `qr-style-contract.test.ts` imports the API's QR vocabulary.
import {
  buildAdDeepLinks,
  generateTrackingCode,
  parseAdPayload,
} from '../../../../src/modules/advertising/utils/tracking-code.util'

/**
 * The QR tab's samples, and the panel's QR codes in general, held to the
 * cabinet — the things no test of a drawn image can hold.
 *
 * WHY THE SIZES ARE READ OFF THE CABINET'S SOURCE. The partner sample is drawn
 * at `QR_PREVIEW_PARTNER_PX` because that is the size a partner is shown the
 * code at, and the size decides whether dots survive. But for the sample link
 * the renderer draws the same bytes at every size from 96 to 163 px, so the
 * byte-for-byte cases in `qr-style-section.test.tsx` stay green with the
 * constant at 120 as happily as at 96. The number can only be checked against
 * the number the cabinet actually uses. The referral sample's 208 had the same
 * hole, unchecked until now.
 *
 * Those cases need the sibling `reiwa` checkout, as `qr-kit-manifest.test.ts`
 * does, and skip in this repository's CI. The reader they use is proven on
 * fixed sources here, which always run — including the shapes a
 * tap-to-enlarge view gives the partner card: a button around a thumbnail, a
 * dialog in the same component, and a dialog component of its own that takes
 * the thumbnail as `children` and renders it in its trigger.
 *
 * WHY THE ENCODER RULE LIVES HERE. The cabinet's `web/test/qr-options.test.ts`
 * fails its build when any file but its QR modules reaches the `qrcode`
 * encoder: three drifted copies of the options are how an unscannable code
 * once shipped. The panel had a copy of its own — the advertising page's
 * bitmap, with a one-module quiet zone — and nothing to stop the next one. The
 * same rule, read by the same kind of parser, is at the end.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_SRC = join(HERE, '..', '..')
// Six levels up from `branding/` reaches the workspace root that holds both
// checkouts: branding → features → src → web → rezeis-admin → rezeis → root.
const REIWA_WEB_SRC = join(HERE, '..', '..', '..', '..', '..', '..', 'reiwa', 'web', 'src')
const PARTNER_ADS = join(REIWA_WEB_SRC, 'features', 'partner', 'components', 'partner-advertising-section.tsx')
const INVITE_HERO = join(REIWA_WEB_SRC, 'features', 'referrals', 'components', 'invite-link-hero.tsx')

/* ─────────────────────────────── reading sources ────────────────────────────── */

/**
 * Parsed rather than pattern-matched: a regular expression reads a comment as
 * code and cannot tell a JSX prop from the same word anywhere else.
 */
function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    name.endsWith('.tsx') || name.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/** A parsed module, and how to reach the modules it imports. */
interface Source {
  readonly file: ts.SourceFile
  /** The module an import specifier in this file names — `null` when it cannot be found. */
  readonly load: (specifier: string) => Source | null
}

const reiwaSources = new Map<string, Source>()

/** A file of the cabinet's web app, resolving `@/…` and relative imports the way its bundler does. */
function reiwaSource(path: string): Source {
  const cached = reiwaSources.get(path)
  if (cached !== undefined) return cached
  const source: Source = {
    file: parse(path, readFileSync(path, 'utf8')),
    load: (specifier) => {
      const base = specifier.startsWith('@/')
        ? join(REIWA_WEB_SRC, specifier.slice(2))
        : specifier.startsWith('.')
          ? join(dirname(path), specifier)
          : null
      if (base === null) return null
      const found = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      )
      return found === undefined ? null : reiwaSource(found)
    },
  }
  reiwaSources.set(path, source)
  return source
}

/** A fixed source, with the modules it may import given by specifier. */
function probe(text: string, modules: Readonly<Record<string, string>> = {}): Source {
  const make = (name: string, body: string): Source => ({
    file: parse(name, body),
    load: (specifier) => {
      const module = modules[specifier]
      return module === undefined ? null : make(`${specifier}.tsx`, module)
    },
  })
  return make('probe.tsx', text)
}

const lineOf = (file: ts.SourceFile, node: ts.Node): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1

function unwrap(expression: ts.Expression): ts.Expression {
  let inner = expression
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)) {
    inner = inner.expression
  }
  return inner
}

/** `import { a as b } from 'x'` → for `b`: `{ specifier: 'x', imported: 'a' }`. Named imports only. */
function namedImport(file: ts.SourceFile, local: string): { specifier: string; imported: string } | null {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (element.name.text === local) {
        return { specifier: statement.moduleSpecifier.text, imported: (element.propertyName ?? element.name).text }
      }
    }
  }
  return null
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

/** Every `const name = …` in a file, as its initialiser; `exportedOnly` for what an importer can reach. */
function constInitialisers(file: ts.SourceFile, name: string, exportedOnly: boolean): ts.Expression[] {
  const found: ts.Expression[] = []
  walk(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      (!exportedOnly || isExported(node.parent.parent))
    ) {
      found.push(node.initializer)
    }
  })
  return found
}

const MAX_HOPS = 6

/**
 * What an expression is, followed through the file and its imports: a `const`
 * to its initialiser, an imported name to the exporting module's `const`, and
 * `a.b` to the `b` of an object literal `a` resolves to — which is how a size
 * written as `LOGO_DISPLAY_PIXELS.referralInvite` in the shared kit is read.
 * `null` for anything else: what cannot be read is reported, not guessed.
 */
function resolve(source: Source, expression: ts.Expression, hops = 0): { source: Source; expression: ts.Expression } | null {
  if (hops > MAX_HOPS) return null
  const inner = unwrap(expression)

  if (ts.isIdentifier(inner)) {
    const local = constInitialisers(source.file, inner.text, false)
    // Two consts of one name in different scopes: which one is meant is a
    // question for a type checker, not for this.
    if (local.length > 1) return null
    if (local.length === 1) return resolve(source, local[0]!, hops + 1)
    const imported = namedImport(source.file, inner.text)
    const module = imported === null ? null : source.load(imported.specifier)
    if (imported === null || module === null) return null
    const exported = constInitialisers(module.file, imported.imported, true)
    return exported.length === 1 ? resolve(module, exported[0]!, hops + 1) : null
  }

  if (ts.isPropertyAccessExpression(inner)) {
    const owner = resolve(source, inner.expression, hops + 1)
    if (owner === null) return null
    const object = unwrap(owner.expression)
    if (!ts.isObjectLiteralExpression(object)) return null
    const member = object.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === inner.name.text,
    )
    return member === undefined ? null : resolve(owner.source, member.initializer, hops + 1)
  }

  return { source, expression: inner }
}

function staticNumber(source: Source, expression: ts.Expression | undefined): number | null {
  if (expression === undefined) return null
  const resolved = resolve(source, expression)
  return resolved !== null && ts.isNumericLiteral(resolved.expression) ? Number(resolved.expression.text) : null
}

/**
 * The overlay parts that decide on their own where what they wrap is shown:
 * a trigger wraps what is tapped, a content/portal/overlay wraps what opens.
 * The bare roots (`Dialog`, `Drawer`, …) hold both and decide nothing.
 */
function overlayPart(tag: string): 'trigger' | 'content' | null {
  const match = /^(?:AlertDialog|Dialog|Drawer|Sheet|Popover)(Trigger|Content|Portal|Overlay)$/.exec(tag)
  if (match === null) return null
  return match[1] === 'Trigger' ? 'trigger' : 'content'
}

/** A component's own function, in this file or in the module it is imported from. */
function componentDefinition(source: Source, name: string): { source: Source; node: ts.Node } | null {
  const definedIn = (candidate: Source, target: string, exportedOnly: boolean): ts.Node | null => {
    for (const statement of candidate.file.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === target &&
        (!exportedOnly || isExported(statement))
      ) {
        return statement
      }
    }
    const consts = constInitialisers(candidate.file, target, exportedOnly).map(unwrap)
    return consts.length === 1 && (ts.isArrowFunction(consts[0]!) || ts.isFunctionExpression(consts[0]!))
      ? consts[0]!
      : null
  }
  const local = definedIn(source, name, false)
  if (local !== null) return { source, node: local }
  const imported = namedImport(source.file, name)
  const module = imported === null ? null : source.load(imported.specifier)
  if (imported === null || module === null) return null
  const exported = definedIn(module, imported.imported, true)
  return exported === null ? null : { source: module, node: exported }
}

/**
 * Where a wrapper component shows the `children` it is handed — in an overlay's
 * trigger, in its content, or somewhere that decides nothing. Read off the
 * component itself, because its name says nothing: `<PartnerQrDialog>` is a
 * dialog, and the thumbnail passed to it is rendered in its trigger.
 */
function childrenPlacement(source: Source, component: string, hops: number): 'trigger' | 'content' | null {
  if (hops > MAX_HOPS) return null
  const definition = componentDefinition(source, component)
  if (definition === null) return null
  const placements: Array<'trigger' | 'content' | null> = []
  walk(definition.node, (node) => {
    if (!ts.isJsxExpression(node) || node.expression === undefined) return
    const shown = unwrap(node.expression)
    const isChildren =
      (ts.isIdentifier(shown) && shown.text === 'children') ||
      (ts.isPropertyAccessExpression(shown) && shown.name.text === 'children')
    if (isChildren) placements.push(placementOf(definition.source, node, hops + 1))
  })
  const [first] = placements
  return first !== undefined && placements.every((placement) => placement === first) ? first : null
}

/**
 * Where a node is shown, decided by the nearest ancestor that decides: an
 * overlay part, or a wrapper component whose own source puts its children in
 * one. A wrapper that cannot be read decides nothing, and the search goes on.
 */
function placementOf(source: Source, node: ts.Node, hops = 0): 'trigger' | 'content' | null {
  let ancestor: ts.Node | undefined = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent
  for (; ancestor !== undefined; ancestor = ancestor.parent) {
    if (!ts.isJsxElement(ancestor)) continue
    const tagName = ancestor.openingElement.tagName
    const part = overlayPart(tagName.getText(source.file))
    if (part !== null) return part
    if (ts.isIdentifier(tagName) && /^[A-Z]/.test(tagName.text)) {
      const wrapped = childrenPlacement(source, tagName.text, hops)
      if (wrapped !== null) return wrapped
    }
  }
  return null
}

interface LocalQrUse {
  /** Source line, for messages. */
  readonly line: number
  /** The `size` prop as written, `null` when absent. */
  readonly sizeText: string | null
  /** The `size` as a number, when the source spells one out. */
  readonly size: number | null
  /** Shown by an overlay when it opens — an enlarged code, not one on the card. */
  readonly enlarged: boolean
}

/** Every `<LocalQr …>` in a file, with its size and whether it is what opens or what sits on the card. */
function localQrUses(source: Source): LocalQrUse[] {
  const uses: LocalQrUse[] = []
  walk(source.file, (node) => {
    if (!(ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))) return
    if (node.tagName.getText(source.file) !== 'LocalQr') return
    const size = node.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(source.file) === 'size',
    )
    const initializer = size?.initializer
    uses.push({
      line: lineOf(source.file, node),
      sizeText: initializer?.getText(source.file) ?? null,
      size:
        initializer !== undefined && ts.isJsxExpression(initializer)
          ? staticNumber(source, initializer.expression)
          : null,
      enlarged: placementOf(source, node) === 'content',
    })
  })
  return uses
}

/** The display size handed to every `qrSvg(text, style, size, …)` call in a file. */
function qrSvgSizes(source: Source): Array<{ line: number; text: string; size: number | null }> {
  const calls: Array<{ line: number; text: string; size: number | null }> = []
  walk(source.file, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'qrSvg') {
      calls.push({
        line: lineOf(source.file, node),
        text: node.getText(source.file),
        size: staticNumber(source, node.arguments[2]),
      })
    }
  })
  return calls
}

const onTheCard = (uses: readonly LocalQrUse[]): LocalQrUse[] => uses.filter((use) => !use.enlarged)

/* ───────────────────────────── the sample link ─────────────────────────────── */

describe('the partner sample encodes a link of the shape the API mints', () => {
  it('is exactly what buildAdDeepLinks writes for a web placement', () => {
    const link = new URL(QR_PREVIEW_PARTNER_LINK)
    const code = parseAdPayload(link.searchParams.get('campaign'))
    expect(code, 'the sample carries no `campaign=ad_<code>` the API would parse').not.toBeNull()
    // Rebuilt by the API from the sample's own parts: any other shape — a bot
    // link, `?ad=`, a path, a missing slash before `?` — comes back different.
    expect(buildAdDeepLinks({ miniAppWebBaseUrl: link.origin, code: code ?? '' }).miniAppWeb).toBe(
      QR_PREVIEW_PARTNER_LINK,
    )
  })

  it('carries a code as long as the ones the API mints — length decides the symbol version', () => {
    const code = parseAdPayload(new URL(QR_PREVIEW_PARTNER_LINK).searchParams.get('campaign'))
    // Both minting call sites (`advertising-campaign.service.ts`,
    // `ad-placement-request.service.ts`) ask for 10, the default.
    expect(code).toHaveLength(generateTrackingCode().length)
  })

  it('points at a reserved domain, not at anybody’s real service', () => {
    expect(new URL(QR_PREVIEW_PARTNER_LINK).hostname).toMatch(/(?:^|\.)example\.(?:com|net|org)$/)
  })
})

/* ───────────────────────────── the reader itself ───────────────────────────── */

describe('reading LocalQr sizes off a source', () => {
  const sizes = (source: Source) => {
    const uses = localQrUses(source)
    return {
      card: onTheCard(uses).map((use) => use.size),
      enlarged: uses.filter((use) => use.enlarged).map((use) => use.size),
    }
  }

  /** The cabinet's own dialog, reduced to what decides where `children` goes. */
  const TRIGGER_DIALOG = `
    import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
    import { LOGO_DISPLAY_PIXELS } from "@/lib/qr-logo";
    export const ENLARGED_PARTNER_QR_PIXELS = LOGO_DISPLAY_PIXELS.partnerEnlarged;
    export function PartnerQrDialog({ kind, url, style, children }) {
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button type="button" aria-label={label}>{children}</button>
          </DialogTrigger>
          <DialogContent className="p-4">
            <img src={code} alt={title} width={ENLARGED_PARTNER_QR_PIXELS} height={ENLARGED_PARTNER_QR_PIXELS} />
          </DialogContent>
        </Dialog>
      );
    }`

  it('reads the partner card as it was — two codes on the card', () => {
    expect(
      sizes(
        probe(`
          const a = <div>
            {botUrl && <LocalQr label={t("partnerAds.qrBot")} url={botUrl} size={96} style={qrStyle} />}
            {webUrl && <LocalQr label={t("partnerAds.qrWeb")} url={webUrl} size={96} style={qrStyle} />}
          </div>`),
      ),
    ).toEqual({ card: [96, 96], enlarged: [] })
  })

  it('reads a thumbnail handed as children to a dialog component that renders it in its trigger', () => {
    expect(
      sizes(
        probe(
          `
          import { PartnerQrDialog } from "./partner-qr-dialog";
          const a = <div>
            {botUrl && (
              <PartnerQrDialog kind="bot" url={botUrl} style={qrStyle}>
                <LocalQr label={t("partnerAds.qrBot")} url={botUrl} size={96} style={qrStyle} />
              </PartnerQrDialog>
            )}
            {webUrl && (
              <PartnerQrDialog kind="web" url={webUrl} style={qrStyle}>
                <LocalQr label={t("partnerAds.qrWeb")} url={webUrl} size={96} style={qrStyle} />
              </PartnerQrDialog>
            )}
          </div>`,
          { './partner-qr-dialog': TRIGGER_DIALOG },
        ),
      ),
    ).toEqual({ card: [96, 96], enlarged: [] })
  })

  it('still sees a thumbnail wrapped in a plain button', () => {
    expect(
      sizes(
        probe(`
          const a = <button type="button" onClick={() => setOpen(true)} aria-label={label}>
            <LocalQr label={label} url={url} size={96} style={qrStyle} />
          </button>`),
      ),
    ).toEqual({ card: [96], enlarged: [] })
  })

  it('tells the thumbnail in a dialog trigger from the large code in its content', () => {
    expect(
      sizes(
        probe(`
          const a = <Dialog>
            <DialogTrigger asChild>
              <button type="button"><LocalQr label={label} url={url} size={96} style={qrStyle} /></button>
            </DialogTrigger>
            <DialogContent className="max-w-xs">
              <DialogHeader><LocalQr label={label} url={url} size={280} style={qrStyle} captioned={false} /></DialogHeader>
            </DialogContent>
          </Dialog>`),
      ),
    ).toEqual({ card: [96], enlarged: [280] })
  })

  it('sets aside a large code handed to a component that renders children in its content, in this file or another', () => {
    expect(
      sizes(
        probe(
          `
          import { CodeLightbox } from "@/components/code-lightbox";
          function QrZoom({ children }) {
            return <Dialog open={open}><DialogContent>{children}</DialogContent></Dialog>
          }
          const a = <>
            <button onClick={() => setZoom(url)}><LocalQr url={url} label={label} size={96} /></button>
            <QrZoom><LocalQr url={url} label={label} size={320} /></QrZoom>
            <CodeLightbox><LocalQr url={url} label={label} size={300} /></CodeLightbox>
            <UnreadableWrapper><LocalQr url={url} label={label} size={96} /></UnreadableWrapper>
          </>`,
          {
            '@/components/code-lightbox':
              'export const CodeLightbox = ({ children }) => <Drawer><DrawerContent><div>{children}</div></DrawerContent></Drawer>',
          },
        ),
      ),
    ).toEqual({ card: [96, 96], enlarged: [320, 300] })
  })

  it('reads a size given as a constant — here or in an imported object — and refuses one it cannot read', () => {
    const read = (text: string, modules?: Record<string, string>) => localQrUses(probe(text, modules))
    expect(read('const THUMBNAIL_PX = 96\nconst a = <LocalQr url={u} label={l} size={THUMBNAIL_PX} />')[0]?.size).toBe(96)
    expect(
      read(
        'import { SIZES as PX } from "@/lib/sizes"\nconst CARD = PX.card\nconst a = <LocalQr url={u} label={l} size={CARD} />',
        { '@/lib/sizes': 'export const SIZES = { card: 96, enlarged: 256 } as const' },
      )[0]?.size,
    ).toBe(96)
    // Declared but not exported: an importer cannot reach it.
    expect(
      read('import { SIZES } from "@/lib/sizes"\nconst a = <LocalQr url={u} label={l} size={SIZES.card} />', {
        '@/lib/sizes': 'const SIZES = { card: 96 }',
      })[0]?.size,
    ).toBeNull()
    expect(read('const a = <LocalQr url={u} label={l} size={size} />')[0]?.size).toBeNull()
    expect(read('const a = <LocalQr url={u} label={l} size="96" />')[0]?.size).toBeNull()
    expect(read('const a = <LocalQr url={u} label={l} />')[0]?.sizeText).toBeNull()
    expect(read('// <LocalQr url={u} label={l} size={120} />\nconst a = 1')).toEqual([])
  })

  it('reads the size handed to qrSvg, the way the invite now names it', () => {
    const source = probe(
      [
        'import { LOGO_DISPLAY_PIXELS } from "@/lib/qr-logo";',
        'const INVITE_QR_PIXELS = LOGO_DISPLAY_PIXELS.referralInvite;',
        'await qrSvg(webLink, qrStyle, 208)',
        'await qrSvg(webLink, qrStyle, INVITE_QR_PIXELS, logoHref)',
        'await qrSvg(webLink, qrStyle)',
      ].join('\n'),
      { '@/lib/qr-logo': 'export const LOGO_DISPLAY_PIXELS = {\n  referralInvite: 208,\n  partnerEnlarged: 256,\n} as const' },
    )
    expect(qrSvgSizes(source).map((call) => call.size)).toEqual([208, 208, null])
  })
})

/* ───────────────────────────── against the cabinet ─────────────────────────── */

// Keyed on the checkout, not on the two files, so a file that moved fails here
// by name instead of quietly skipping.
const hasSibling = existsSync(REIWA_WEB_SRC)

describe('the sample sizes are the cabinet’s own', () => {
  it.skipIf(!hasSibling)('draws the partner sample at the size partners see their codes on the card', () => {
    expect(existsSync(PARTNER_ADS), `${PARTNER_ADS} is gone — where do partner codes render now?`).toBe(true)
    const card = onTheCard(localQrUses(reiwaSource(PARTNER_ADS)))
    expect(
      card.length,
      'partner-advertising-section.tsx renders no <LocalQr> on the card — the thumbnails moved, and this test must follow them',
    ).toBeGreaterThan(0)
    for (const use of card) {
      expect(
        use.size,
        `partner-advertising-section.tsx:${use.line} draws a code on the card with size=${use.sizeText ?? '(absent)'}, ` +
          'a size this test cannot read. If it is the enlarged view instead, it has to be shown by a dialog ' +
          "content element (or by a component that puts its children in one) to be told apart from a thumbnail",
      ).not.toBeNull()
      expect(
        use.size,
        `partner-advertising-section.tsx:${use.line} shows partners their code at ${use.size} px, but the QR tab ` +
          `previews it at QR_PREVIEW_PARTNER_PX = ${QR_PREVIEW_PARTNER_PX}. Whether dots survive depends on that ` +
          'size, so the operator would approve a code partners do not get',
      ).toBe(QR_PREVIEW_PARTNER_PX)
    }
  })

  it.skipIf(!hasSibling)('draws the referral sample at the size the invite dialog shows the code', () => {
    expect(existsSync(INVITE_HERO), `${INVITE_HERO} is gone — where does the invite code render now?`).toBe(true)
    const calls = qrSvgSizes(reiwaSource(INVITE_HERO))
    expect(calls.length, 'the invite no longer draws its code with `qrSvg`').toBeGreaterThan(0)
    for (const call of calls) {
      expect(
        call.size,
        `invite-link-hero.tsx:${call.line} draws \`${call.text}\` at a size this test cannot read, or at none`,
      ).not.toBeNull()
      expect(
        call.size,
        `invite-link-hero.tsx:${call.line} draws the invite at ${call.size} px, but the QR tab previews it at ` +
          `QR_PREVIEW_REFERRAL_PX = ${QR_PREVIEW_REFERRAL_PX}`,
      ).toBe(QR_PREVIEW_REFERRAL_PX)
    }
  })
})

/* ──────────────────────────── who may touch the encoder ────────────────────── */

/** Directly under here, and only here: the vendored, byte-frozen renderer. */
const ENCODER_OWNER_DIR = 'lib/qr/kit/'

/**
 * Every source the production build compiles, `web/src`-relative. Tests are
 * left out on purpose, as `tsconfig.app.json` leaves them out: a test may build
 * a matrix to measure a code, and none of them draws one on a page.
 */
function productionSources(dir: string = WEB_SRC, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) productionSources(path, into)
    else if (/\.[cm]?[jt]sx?$/.test(entry) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry)) {
      into.push(path.slice(WEB_SRC.length + 1).split(sep).join('/'))
    }
  }
  return into
}

const isEncoderOwner = (path: string): boolean =>
  path.startsWith(ENCODER_OWNER_DIR) && !path.slice(ENCODER_OWNER_DIR.length).includes('/')

const readWebSource = (path: string): string => readFileSync(join(WEB_SRC, path), 'utf8')

/**
 * The `qrcode` package by any specifier that loads it. A subpath counts: the
 * package publishes no `exports` map, so `qrcode/lib/core/qrcode` is a working
 * second door to the same encoder.
 */
function isQrcodeSpecifier(node: ts.Node | undefined): boolean {
  if (node === undefined || !ts.isStringLiteral(node)) return false
  return node.text === 'qrcode' || node.text.startsWith('qrcode/')
}

/** A static import that loads the package at run time — anything but a type-only one. */
function importsAtRunTime(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) return true
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false
  if (clause.name !== undefined) return true
  const bindings = clause.namedBindings
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true
  return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)
}

/**
 * Every way a file reaches the encoder: loading the package under any name (a
 * runtime import, an import-equals, a re-export, `import()`, `require()`), or
 * calling any method on `QRCode`. The same detector as the cabinet's, so the
 * two repositories hold one rule the same way.
 */
function encoderUse(file: ts.SourceFile): string[] {
  const found: string[] = []
  walk(file, (node) => {
    if (ts.isImportDeclaration(node)) {
      if (isQrcodeSpecifier(node.moduleSpecifier) && importsAtRunTime(node)) found.push('imports qrcode')
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isQrcodeSpecifier(node.moduleReference.expression)
      ) {
        found.push('imports qrcode')
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && isQrcodeSpecifier(node.moduleSpecifier)) found.push('re-exports qrcode')
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
      if (loads && isQrcodeSpecifier(node.arguments[0])) found.push('loads qrcode')
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'QRCode'
      ) {
        found.push(`calls QRCode.${callee.name.text}`)
      }
    }
  })
  return found
}

describe('who may touch the QR encoder in the panel', () => {
  it('is the vendored kit, and nothing else', () => {
    const offenders = productionSources()
      .filter((path) => !isEncoderOwner(path))
      // A sound prefilter: every construct `encoderUse` reports spells one of
      // these two words out in the text.
      .filter((path) => /qrcode|QRCode/.test(readWebSource(path)))
      .map((path) => [path, encoderUse(parse(path, readWebSource(path)))] as const)
      .filter(([, found]) => found.length > 0)
      .map(([path, found]) => `${path}: ${found.join(', ')}`)

    expect(
      offenders,
      'these reach the `qrcode` encoder themselves instead of drawing through `qrSvg` from ' +
        '`@/lib/qr/kit/qr-style` (or `LocalQr`, which does). A second copy of the encoder options is how ' +
        'the advertising page came to print codes with a one-module quiet zone',
    ).toEqual([])
  })

  it('recognises every way in — and not a type-only import, a comment, or a qrSvg call', () => {
    const use = (text: string): string[] => encoderUse(parse('probe.ts', text))

    expect(use('QRCode.toDataURL(url, { width: 88, margin: 1 })')).toEqual(['calls QRCode.toDataURL'])
    expect(use("QRCode.create(text, { errorCorrectionLevel: 'H' })")).toEqual(['calls QRCode.create'])
    expect(use("import QRCode from 'qrcode'")).toEqual(['imports qrcode'])
    expect(use("import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode'")).toEqual(['imports qrcode'])
    expect(use("import { create } from 'qrcode'")).toEqual(['imports qrcode'])
    expect(use('import * as encoder from "qrcode"')).toEqual(['imports qrcode'])
    expect(use("import 'qrcode'")).toEqual(['imports qrcode'])
    expect(use("import encoder = require('qrcode')")).toEqual(['imports qrcode'])
    expect(use("const encoder = await import('qrcode')")).toEqual(['loads qrcode'])
    expect(use("const encoder = require('qrcode')")).toEqual(['loads qrcode'])
    expect(use("export { toString } from 'qrcode'")).toEqual(['re-exports qrcode'])
    expect(use('import QRCode from "qrcode/lib/core/qrcode"')).toEqual(['imports qrcode'])
    expect(use('import generate from "qrcode-generator"')).toEqual([])

    expect(use("import type { QRCodeToStringOptions } from 'qrcode'")).toEqual([])
    expect(use("import { type QRCodeToStringOptions } from 'qrcode'")).toEqual([])
    expect(use('// QRCode.toDataURL(url) is how the advertising page used to draw')).toEqual([])
    expect(use('const svg = await qrSvg(url, QR_STYLE_PLAIN, 120)')).toEqual([])
  })

  it('finds the encoder and the drawing call sites at all, so the rule cannot pass by finding nothing', () => {
    const all = productionSources()
    expect(all.length, 'the source scan found almost nothing — is WEB_SRC right?').toBeGreaterThan(100)

    const owners = all.filter(isEncoderOwner)
    expect(owners, 'the kit is not where the rule says — the allowlist names nothing').toEqual(
      expect.arrayContaining(['lib/qr/kit/qr-style.ts', 'lib/qr/kit/qr-options.ts']),
    )
    // The real renderer, read by the real detector: both halves of the encoder,
    // somewhere in the kit — which of its files holds which may change on a sync.
    expect(owners.flatMap((path) => encoderUse(parse(path, readWebSource(path))))).toEqual(
      expect.arrayContaining(['imports qrcode', 'calls QRCode.toString', 'calls QRCode.create']),
    )

    // And the codes on the panel's pages reach it through `qrSvg`.
    const drawing = all.filter(
      (path) =>
        !isEncoderOwner(path) &&
        readWebSource(path).includes('qrSvg') &&
        qrSvgSizes({ file: parse(path, readWebSource(path)), load: () => null }).length > 0,
    )
    expect(drawing, 'no page draws a QR code through `qrSvg` any more — has the API changed?').toEqual(
      expect.arrayContaining(['components/ui/local-qr.tsx', 'features/branding/qr-style-section.tsx']),
    )
  })
})
