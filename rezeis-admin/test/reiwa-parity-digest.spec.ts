import 'reflect-metadata';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { applyUploadResponseHeaders, MARKUP_UPLOAD_EXTENSIONS } from '../src/main';
import {
  APP_BACKGROUND_KINDS,
  APP_BACKGROUND_TEXTURES,
  BG_EFFECTS,
  BORDER_RADIUS_CLASSES,
  BRAND_LOGO_FRAMES,
  BRAND_PALETTE_SOURCES,
  CARD_EFFECT_SLOT_MODES,
  CARD_GRADIENT_SOURCES,
  CARD_LOGO_PRESETS,
  ICON_COLOR_MODES,
  NAV_DESTINATIONS,
  NAV_ESSENTIAL_DESTINATIONS,
  NAV_MAX_VISIBLE,
  PLAN_CARD_TEXT_MODES,
  SUBSCRIPTION_CARD_TEXT_MODES,
} from '../src/modules/settings/interfaces/branding-settings.interface';

/**
 * THE PANEL'S HALF OF THE CROSS-REPO PARITY DIGEST.
 *
 * reiwa (the subscriber cabinet) mirrors three surfaces of this panel:
 * the `/uploads` header policy, the card effect catalog, and the branding
 * vocabularies. Its guards used to read THIS repository's source text out of
 * a sibling checkout and skip when it was absent — which, in either
 * repository's CI, is always. So nothing anywhere enforced the parity except
 * a developer machine that happened to hold both trees: a one-sided edit to
 * any of these surfaces shipped green on both pipelines.
 *
 * The answer is a digest written down in BOTH repositories. reiwa states each
 * literal in the spec that guards the surface and computes it from
 * `test/support/panel-parity-manifest.ts`, its committed copy of the panel's
 * half. THIS file states the SAME three literals and computes them from the
 * panel's LIVE sources — so a change to the panel without a new literal now
 * fails THIS repository's own test run, and the failure message names the
 * reiwa constant that has to move in the same change.
 *
 * Neither CI can read the other, stated plainly: if the panel changes AND
 * this file's literal is dutifully updated AND reiwa is never touched, both
 * pipelines stay green while the two repositories hold different digests for
 * the same surface. What this buys is that the divergence cannot happen by
 * ACCIDENT — it takes an edit to a constant whose failure message asked for
 * the other repository by name.
 *
 * The digests are over MEANING, not bytes: object key order is normalised
 * away (a record is not a list), while every string, number, boolean, key
 * set and ARRAY ORDER is kept — reordering `MARKUP_UPLOAD_EXTENSIONS` or a
 * picker's options is a real change and moves the digest.
 */

// ── The digest machinery — a byte-for-byte mirror of reiwa's ────────────────

/**
 * Deterministic serialisation of the canonical form.
 *
 * Not `JSON.stringify`: that preserves insertion order for object keys, so
 * two sides which agree on every value but wrote them in a different order
 * would hash differently and the guard would fail on nothing.
 */
function canonicalise(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalise(element)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalise(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256, hex, of the canonical form of `value`. */
function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalise(value), 'utf8').digest('hex');
}

/** `sha256("")` — pinned so a vacuous read cannot agree with itself forever. */
const EMPTY_INPUT_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** `digestOf({})` — the other shape a vacuous read takes. */
const EMPTY_OBJECT_DIGEST =
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

/** `digestOf([])`. */
const EMPTY_ARRAY_DIGEST =
  '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

/**
 * A fixture with a known canonical form, so the two properties this design
 * rests on are pinned rather than assumed: object keys are SORTED (`a` before
 * `b`, `c` before `d`) and array order is KEPT (`1` before `"x"`). A
 * canonicaliser that dropped values, flattened structure or sorted arrays
 * would still produce a stable digest for every real surface — and would be
 * blind. Identical values live in reiwa's `panel-parity-digest.ts`.
 */
const CANONICAL_FIXTURE = { b: [1, 'x'], a: { d: true, c: null } };
const CANONICAL_FIXTURE_FORM = '{"a":{"c":null,"d":true},"b":[1,"x"]}';
const CANONICAL_FIXTURE_DIGEST =
  '49bd9631390b56109ef9a77080d397067fdd5bfde2d9f67de64a11d73af2e3d3';

// ── The three literals — the answers, written down first ────────────────────

/**
 * SHA-256 of the canonical form of the `/uploads` policy
 * (`MARKUP_UPLOAD_EXTENSIONS` + `applyUploadResponseHeaders` in `src/main.ts`).
 *
 * Identical to `UPLOAD_POLICY_DIGEST` in `reiwa/test/api/upload-relay-headers.test.ts`,
 * which computes the same number from its committed copy of the policy.
 */
const UPLOAD_POLICY_DIGEST =
  '5867b819cfbca6d974151cfd1a2d2ee1dfd3bb81b49927e7537e1941c26ff958';

/**
 * SHA-256 of the canonical form of the card effect catalog
 * (`CARD_EFFECT_CATALOG` in `web/src/features/branding/card-effect-catalog.ts`).
 *
 * Identical to `CARD_EFFECT_PARITY_DIGEST` in `reiwa/test/web/card-effect-catalog-parity.test.ts`.
 */
const CARD_EFFECT_PARITY_DIGEST =
  '69ffc62564630a2eb08bc5973930057b0599d573cc1896c4f46fd603de459ba2';

/**
 * SHA-256 of the canonical form of the branding vocabularies (the interface,
 * the DTO and the form schema).
 *
 * Identical to `BRANDING_VOCABULARY_DIGEST` in `reiwa/test/web/branding-vocabulary-panel-parity.test.ts`.
 */
const BRANDING_VOCABULARY_DIGEST =
  'd54362979e50c22b44cd11c46ef892728f8b204dba56ca00eb72f5ca55356c59';

/**
 * The message printed when a digest moves. It has to carry a REMEDY: two hex
 * strings with no remedy is a puzzle. It names the new value, this file's own
 * constant, and — the entire point — the constant in reiwa that has to change
 * in the same commit.
 */
function driftMessage(
  computed: string,
  ownConstant: string,
  reiwaConstant: string,
  reiwaFile: string,
  panelSources: readonly string[],
): string {
  return [
    'the committed digest no longer matches the panel content it is over.',
    '',
    `  computed now: ${computed}`,
    '',
    'Something in one of these changed:',
    ...panelSources.map((source) => `  - ${source}`),
    '',
    'TO FIX, IN ONE CHANGE, ON BOTH SIDES:',
    '  1. confirm the change above is intended — this digest is the only',
    '     thing that makes a one-sided edit to this surface visible;',
    `  2. set ${ownConstant} = "${computed}"`,
    '     in rezeis-admin/test/reiwa-parity-digest.spec.ts;',
    `  3. set ${reiwaConstant} to the SAME value`,
    `     in reiwa's ${reiwaFile},`,
    '     and mirror the content change itself in reiwa/test/support/panel-parity-manifest.ts.',
    '',
    'Step 3 is not optional and nothing else enforces it: neither repository\'s',
    'CI can read the other. Skip it and the two halves of this policy drift',
    'apart with both pipelines green.',
  ].join('\n');
}

/** The vacuity floor every surface digest is asserted against. */
function assertNotEmptyDigest(digest: string, surface: string): void {
  for (const vacuous of [EMPTY_INPUT_DIGEST, EMPTY_OBJECT_DIGEST, EMPTY_ARRAY_DIGEST]) {
    assert.notEqual(
      digest,
      vacuous,
      `the pinned ${surface} digest is the digest of nothing — this guard is hashing an empty input`,
    );
  }
}

/** The canonicaliser itself, pinned once, the same way reiwa pins it. */
function assertCanonicaliserPinned(): void {
  assert.equal(canonicalise(CANONICAL_FIXTURE), CANONICAL_FIXTURE_FORM);
  assert.equal(digestOf(CANONICAL_FIXTURE), CANONICAL_FIXTURE_DIGEST);
}

// ── Surface 1: the /uploads header policy ───────────────────────────────────

interface LiveUploadHeader {
  readonly name: string;
  readonly value: string;
  readonly markupOnly: boolean;
}

/**
 * Derive the header list BEHAVIOURALLY, by calling the live helper against a
 * recording `res` — once for a markup extension and once for a file the
 * policy does not mark. A header that appears in both calls applies to every
 * upload; one that appears only for markup is the `Content-Disposition`
 * download-forcing header. This is stronger than reading the source text:
 * a change to the helper's condition or its header values lands here even
 * when the shape of the function does not move.
 */
function liveUploadHeaders(): LiveUploadHeader[] {
  const record = (path: string): Map<string, string> => {
    const set = new Map<string, string>();
    applyUploadResponseHeaders(
      {
        setHeader: (name: string, value: string): void => {
          set.set(name, value);
        },
      },
      path,
    );
    return set;
  };

  const markup = record('brand/logo.svg');
  const inline = record('brand/logo.png');

  const names = new Set([...markup.keys(), ...inline.keys()]);
  // Codepoint order, not `localeCompare`: the comparator must give the same
  // answer on every machine and CI image, or the digest would depend on the
  // runner's locale. For these ASCII header names the two agree anyway.
  return [...names]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => ({
      name,
      value: markup.get(name) ?? inline.get(name) ?? '',
      markupOnly: markup.has(name) && !inline.has(name),
    }));
}

// ── Surface 2: the card effect catalog ──────────────────────────────────────

const CATALOG_PATH = join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'branding',
  'card-effect-catalog.ts',
);

interface LiveSlider {
  readonly min: number;
  readonly max: number;
  readonly default: number | null;
}

interface LiveCardEffect {
  readonly renderer: string;
  readonly fullOutputGamut: boolean;
  readonly sliders: Readonly<Record<string, LiveSlider>>;
}

/** Strip `satisfies` / `as` / parentheses to reach the literal underneath. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringOf(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  const value = unwrap(node);
  return ts.isStringLiteralLike(value) ? value.text : null;
}

/**
 * The numeric value of a literal, including a negated one. `-90` is a prefix
 * unary expression over `90`; reading only `NumericLiteral` would silently
 * drop the minima of every slider that opens below zero.
 */
function numberOf(node: ts.Expression): number | null {
  const value = unwrap(node);
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) {
    const operand = unwrap(value.operand);
    if (ts.isNumericLiteral(operand)) return -Number(operand.text);
  }
  return null;
}

function keyText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

/**
 * Read `CARD_EFFECT_CATALOG` the way the compiler reads it.
 *
 * The catalog lives under `web/`, behind that build's own `@/` path alias, so
 * it is parsed from disk rather than imported — the same deliberate choice
 * `test/card-effect-catalog-contract.spec.ts` already makes. The AST, not a
 * regex: a line-shaped pattern over this file was shown (in that spec's
 * history) to silently miss or invent entries, and a guard that cannot see a
 * shape is a guard that certifies nothing.
 *
 * Only what reiwa's mirror holds survives into the digest: `renderer`,
 * `fullOutputGamut`, and every `type: 'slider'` control's `min`/`max`/`default`
 * keyed by the prop it drives. `name`, `palette` and non-slider controls are
 * deliberately not compared — a palette recolour is not a parity change.
 */
function liveCardEffectCatalog(): Readonly<Record<string, LiveCardEffect>> {
  const source = ts.createSourceFile(
    CATALOG_PATH,
    readFileSync(CATALOG_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let literal: ts.ObjectLiteralExpression | null = null;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== 'CARD_EFFECT_CATALOG') continue;
      if (declaration.initializer === undefined) continue;
      const candidate = unwrap(declaration.initializer);
      if (ts.isObjectLiteralExpression(candidate)) literal = candidate;
    }
  }
  assert.ok(literal, `no CARD_EFFECT_CATALOG object literal in ${CATALOG_PATH}`);

  const catalog: Record<string, LiveCardEffect> = {};
  for (const property of literal.properties) {
    assert.ok(
      ts.isPropertyAssignment(property),
      `panel catalog holds a ${ts.SyntaxKind[property.kind]}; it must stay a flat record of literal entries`,
    );
    const id = keyText(property.name);
    assert.ok(id, 'panel catalog entry has a key this test cannot read');

    const value = unwrap(property.initializer);
    assert.ok(ts.isObjectLiteralExpression(value), `panel catalog entry '${id}' is not an object literal`);

    let renderer: string | null = null;
    let fullOutputGamut = false;
    let sliders: Record<string, LiveSlider> = {};
    for (const field of value.properties) {
      if (!ts.isPropertyAssignment(field)) continue;
      const fieldName = keyText(field.name);
      if (fieldName === 'renderer') {
        const literalValue = unwrap(field.initializer);
        if (ts.isStringLiteral(literalValue)) renderer = literalValue.text;
      } else if (fieldName === 'fullOutputGamut') {
        fullOutputGamut = unwrap(field.initializer).kind === ts.SyntaxKind.TrueKeyword;
      } else if (fieldName === 'controls') {
        const controls = unwrap(field.initializer);
        assert.ok(
          ts.isArrayLiteralExpression(controls),
          `panel catalog entry '${id}' does not declare its controls as an array literal`,
        );
        sliders = {};
        for (const element of controls.elements) {
          const control = unwrap(element);
          if (!ts.isObjectLiteralExpression(control)) continue;

          let prop: string | null = null;
          let type: string | null = null;
          let min: number | null = null;
          let max: number | null = null;
          let fallback: number | null = null;
          for (const controlField of control.properties) {
            if (!ts.isPropertyAssignment(controlField)) continue;
            const controlFieldName = keyText(controlField.name);
            const controlValue = unwrap(controlField.initializer);
            if (controlFieldName === 'prop' && ts.isStringLiteral(controlValue)) {
              prop = controlValue.text;
            } else if (controlFieldName === 'type' && ts.isStringLiteral(controlValue)) {
              type = controlValue.text;
            } else if (controlFieldName === 'min') {
              min = numberOf(controlValue);
            } else if (controlFieldName === 'max') {
              max = numberOf(controlValue);
            } else if (controlFieldName === 'default') {
              fallback = numberOf(controlValue);
            }
          }
          if (type !== 'slider' || prop === null) continue;

          // Refused rather than skipped: a slider whose bounds this cannot
          // read would drop out of the digest in silence, and silence is what
          // the mirror must never be checked with.
          assert.ok(
            min !== null && max !== null,
            `panel slider '${id}.${prop}' declares no numeric min/max this test can read`,
          );
          sliders[prop] = { min, max, default: fallback };
        }
      }
    }
    assert.ok(renderer, `panel catalog entry '${id}' declares no string renderer`);
    catalog[id] = { renderer, fullOutputGamut, sliders };
  }
  return catalog;
}

// ── Surface 3: the branding vocabularies ────────────────────────────────────

const FORM_SCHEMA_PATH = join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'branding',
  'branding-form-schema.ts',
);
const DTO_PATH = join(
  __dirname,
  '..',
  'src',
  'modules',
  'settings',
  'dto',
  'update-branding-settings.dto.ts',
);

/**
 * `export const NAME = ['a', 'b'] as const` → `['a', 'b']`.
 *
 * The form schema lives under `web/` behind the SPA's module resolution, so
 * like the catalog it is read from disk with the compiler's own parser.
 */
function readStringArrayConst(path: string, name: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      assert.ok(declaration.initializer !== undefined, `no \`${name}\` initializer in ${path}`);
      const initializer = unwrap(declaration.initializer);
      assert.ok(
        ts.isArrayLiteralExpression(initializer),
        `\`${name}\` in ${path} is no longer an array literal`,
      );
      const values = initializer.elements.map(
        (element) => stringOf(element) ?? '<non-literal>',
      );
      assert.ok(
        values.length > 0,
        `\`${name}\` in ${path} parsed as empty — an empty vocabulary would pass every comparison below`,
      );
      assert.ok(
        !values.includes('<non-literal>'),
        `\`${name}\` in ${path} holds a member this test cannot read`,
      );
      return values;
    }
  }
  assert.fail(`no \`${name}\` declaration in ${path}`);
}

/** The keys of `export const NAME = { key: …, … }` — the form's own dropdown order. */
function readObjectKeysConst(path: string, name: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      assert.ok(declaration.initializer !== undefined, `no \`${name}\` initializer in ${path}`);
      const initializer = unwrap(declaration.initializer);
      assert.ok(
        ts.isObjectLiteralExpression(initializer),
        `\`${name}\` in ${path} is no longer an object literal`,
      );
      const keys = initializer.properties.map((property) => {
        assert.ok(
          ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
          `\`${name}\` in ${path} holds a ${ts.SyntaxKind[property.kind]}; this test can only read a flat record`,
        );
        const key = keyText(property.name);
        assert.ok(key, `\`${name}\` in ${path} has a key this test cannot read`);
        return key;
      });
      assert.ok(keys.length > 0, `\`${name}\` in ${path} parsed as empty`);
      return keys;
    }
  }
  assert.fail(`no \`${name}\` declaration in ${path}`);
}

/**
 * The DTO's raw text, for the two facts the mirror holds about it: how many
 * `borderRadius` properties carry `@IsBorderRadiusClass()` (the layer that
 * tells the OPERATOR their input was wrong — lose the decorator and a bad
 * class is silently repaired on read), and every inline `@IsIn([...])`
 * vocabulary (the theme-mode discriminators, which the DTO spells out rather
 * than importing a named list).
 */
function liveDtoFacts(): {
  readonly borderRadius: { readonly declarations: number; readonly validators: number };
  readonly isInVocabularies: readonly (readonly string[])[];
} {
  const dto = readFileSync(DTO_PATH, 'utf8');
  const declarations = (dto.match(/public borderRadius[!?]?:/g) ?? []).length;
  const validators = (dto.match(/@IsBorderRadiusClass\(\)/g) ?? []).length;

  // Each list is SORTED and so is the outer list: `@IsIn` is a set membership
  // test, so the order a decorator writes its members in changes nothing an
  // operator or a subscriber can see.
  const isInVocabularies = [...dto.matchAll(/@IsIn\(\[([^\]]*)\]/g)]
    .map((match) =>
      match[1]
        .split(',')
        .map((piece) => piece.trim().replace(/^['"`]|['"`]$/g, ''))
        .filter((piece) => piece.length > 0)
        .sort(),
    )
    .sort((left, right) => (left.join(',') < right.join(',') ? -1 : left.join(',') > right.join(',') ? 1 : 0));

  return { borderRadius: { declarations, validators }, isInVocabularies };
}

// ── The specs ───────────────────────────────────────────────────────────────

describe('reiwa parity digest', () => {
  describe('upload policy surface', () => {
    it('states the digest literal twice, over something', () => {
      // THE ANSWER, restated. If someone edits the constant at the top to
      // match a changed policy, this line objects — which is the whole point
      // of writing the expected value down twice.
      assert.equal(
        UPLOAD_POLICY_DIGEST,
        '5867b819cfbca6d974151cfd1a2d2ee1dfd3bb81b49927e7537e1941c26ff958',
      );

      assertCanonicaliserPinned();

      // NON-VACUITY of this surface's INPUT: a helper that set no headers, or
      // an extension list that read back empty, hashes to one of the three
      // digests below and would then agree with itself forever.
      const headers = liveUploadHeaders();
      assert.ok(
        MARKUP_UPLOAD_EXTENSIONS.length > 0,
        'MARKUP_UPLOAD_EXTENSIONS is empty — /uploads forces nothing to download',
      );
      assert.ok(headers.length > 0, 'applyUploadResponseHeaders set no headers at all');
      const form = canonicalise({ markupExtensions: [...MARKUP_UPLOAD_EXTENSIONS], headers });
      assert.ok(form.length > 200, 'the canonical upload policy came out empty');
      assert.ok(form.includes('".svg"'), 'the canonical upload policy lost its extensions');
      assertNotEmptyDigest(UPLOAD_POLICY_DIGEST, 'upload policy');
    });

    it('computes the digest from the LIVE /uploads policy', () => {
      const computed = digestOf({
        markupExtensions: [...MARKUP_UPLOAD_EXTENSIONS],
        headers: liveUploadHeaders(),
      });
      assert.equal(
        computed,
        UPLOAD_POLICY_DIGEST,
        driftMessage(computed, 'UPLOAD_POLICY_DIGEST', 'UPLOAD_POLICY_DIGEST', 'test/api/upload-relay-headers.test.ts', [
          'rezeis-admin/src/main.ts — MARKUP_UPLOAD_EXTENSIONS, applyUploadResponseHeaders',
        ]),
      );
    });
  });

  describe('card effect surface', () => {
    it('states the digest literal twice, over something', () => {
      assert.equal(
        CARD_EFFECT_PARITY_DIGEST,
        '69ffc62564630a2eb08bc5973930057b0599d573cc1896c4f46fd603de459ba2',
      );

      assertCanonicaliserPinned();

      // NON-VACUITY: a catalog that parsed as nothing would hash to one of
      // the three below and agree with itself forever.
      const catalog = liveCardEffectCatalog();
      assert.ok(
        Object.keys(catalog).length > 20,
        `expected the panel to offer more than 20 effects, read ${Object.keys(catalog).length}`,
      );
      const form = canonicalise(catalog);
      assert.ok(form.length > 5000, 'the canonical panel catalog came out empty');
      assert.ok(form.includes('"renderer"'), 'the canonical panel catalog lost its renderers');
      assert.ok(form.includes('"sliders"'), 'the canonical panel catalog lost its sliders');
      assertNotEmptyDigest(CARD_EFFECT_PARITY_DIGEST, 'card effect');
    });

    it('computes the digest from the LIVE card effect catalog', () => {
      const computed = digestOf(liveCardEffectCatalog());
      assert.equal(
        computed,
        CARD_EFFECT_PARITY_DIGEST,
        driftMessage(computed, 'CARD_EFFECT_PARITY_DIGEST', 'CARD_EFFECT_PARITY_DIGEST', 'test/web/card-effect-catalog-parity.test.ts', [
          'rezeis-admin/web/src/features/branding/card-effect-catalog.ts — CARD_EFFECT_CATALOG',
        ]),
      );
    });
  });

  describe('branding vocabulary surface', () => {
    it('states the digest literal twice, over something', () => {
      assert.equal(
        BRANDING_VOCABULARY_DIGEST,
        'd54362979e50c22b44cd11c46ef892728f8b204dba56ca00eb72f5ca55356c59',
      );

      assertCanonicaliserPinned();

      // NON-VACUITY: 22 vocabularies in the mirror; a reader that lost the
      // interface, the form schema or the DTO hashes to one of the three
      // below and agrees with itself forever.
      const vocabularies = liveBrandingVocabularies();
      assert.equal(
        Object.keys(vocabularies).length,
        22,
        'the number of mirrored branding vocabularies moved — update this count and BOTH repositories',
      );
      for (const [name, values] of Object.entries(vocabularies)) {
        assert.ok(values.length > 0, `\`${name}\` read back empty`);
      }
      const dtoFacts = liveDtoFacts();
      assert.ok(
        dtoFacts.isInVocabularies.length > 1,
        "the DTO's inline @IsIn vocabularies read back as none",
      );
      assertNotEmptyDigest(BRANDING_VOCABULARY_DIGEST, 'branding vocabulary');
    });

    it('computes the digest from the LIVE branding vocabularies', () => {
      const computed = digestOf({
        vocabularies: liveBrandingVocabularies(),
        navMaxVisible: NAV_MAX_VISIBLE,
        dtoBorderRadius: liveDtoFacts().borderRadius,
        dtoIsInVocabularies: liveDtoFacts().isInVocabularies,
      });
      assert.equal(
        computed,
        BRANDING_VOCABULARY_DIGEST,
        driftMessage(computed, 'BRANDING_VOCABULARY_DIGEST', 'BRANDING_VOCABULARY_DIGEST', 'test/web/branding-vocabulary-panel-parity.test.ts', [
          'rezeis-admin/src/modules/settings/interfaces/branding-settings.interface.ts',
          'rezeis-admin/src/modules/settings/dto/update-branding-settings.dto.ts',
          'rezeis-admin/web/src/features/branding/branding-form-schema.ts',
        ]),
      );
    });
  });
});

/**
 * The 22 vocabularies the mirror holds: fourteen named constants from the
 * interface (imported LIVE — they are backend sources, and a rename then
 * fails this spec's own compilation rather than a parse), seven from the
 * SPA's form schema and one derived map read from disk, and the numbers the
 * DTO states as text. Key names must match reiwa's manifest exactly; key
 * ORDER does not matter (canonicalise sorts keys).
 */
function liveBrandingVocabularies(): Readonly<Record<string, readonly string[]>> {
  return {
    bgEffects: [...BG_EFFECTS],
    appBackgroundKinds: [...APP_BACKGROUND_KINDS],
    appBackgroundTextures: [...APP_BACKGROUND_TEXTURES],
    iconColorModes: [...ICON_COLOR_MODES],
    subscriptionCardTextModes: [...SUBSCRIPTION_CARD_TEXT_MODES],
    planCardTextModes: [...PLAN_CARD_TEXT_MODES],
    cardEffectSlotModes: [...CARD_EFFECT_SLOT_MODES],
    cardLogoPresets: [...CARD_LOGO_PRESETS],
    brandLogoFrames: [...BRAND_LOGO_FRAMES],
    navDestinations: [...NAV_DESTINATIONS],
    navEssentials: [...NAV_ESSENTIAL_DESTINATIONS],
    brandPaletteSources: [...BRAND_PALETTE_SOURCES],
    cardGradientSources: [...CARD_GRADIENT_SOURCES],
    borderRadiusClasses: [...BORDER_RADIUS_CLASSES],
    formBgEffects: readStringArrayConst(FORM_SCHEMA_PATH, 'BRANDING_BG_EFFECTS'),
    formIconColorModes: readStringArrayConst(FORM_SCHEMA_PATH, 'BRANDING_ICON_COLOR_MODES'),
    formSubscriptionCardTextModes: readStringArrayConst(
      FORM_SCHEMA_PATH,
      'BRANDING_SUBSCRIPTION_CARD_TEXT_MODES',
    ),
    formPlanCardTextModes: readStringArrayConst(FORM_SCHEMA_PATH, 'BRANDING_PLAN_CARD_TEXT_MODES'),
    formAppBackgroundKinds: readStringArrayConst(FORM_SCHEMA_PATH, 'BRANDING_APP_BG_KINDS'),
    formAppBackgroundTextures: readStringArrayConst(FORM_SCHEMA_PATH, 'BRANDING_APP_BG_TEXTURES'),
    formNavDestinations: readStringArrayConst(FORM_SCHEMA_PATH, 'BRANDING_NAV_DESTINATIONS'),
    // Derived in the form from the radii map rather than restated, so read
    // the map's keys — which is what the panel's own dropdown offers.
    formBorderRadiusClasses: readObjectKeysConst(FORM_SCHEMA_PATH, 'CORNER_RADII_BY_LEGACY_CLASS'),
  };
}
