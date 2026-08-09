import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import { CARD_EFFECTS } from '../src/modules/settings/interfaces/branding-settings.interface';

/**
 * The backend's allowed effects and the panel's catalog must be the same set.
 *
 * They are two lists in two builds that ship together, so nothing at runtime
 * can ever reconcile them. A name in the catalog but not here means the picker
 * offers an effect the API then refuses, and the operator gets a validation
 * error naming no field. A name here but not in the catalog is merely dead, but
 * it is dead weight nobody will dare remove without knowing this.
 *
 * The catalog is read from disk rather than imported: it lives under `web/`,
 * behind that build's own `@/` path alias, and dragging the panel's module
 * resolution into the backend test run to answer a question about a list of
 * names would be a poor trade.
 *
 * It is read with the TypeScript parser — the same one that compiles the file —
 * and not with a regular expression over the text. That choice is deliberate
 * and was made after a line-shaped regex (`/^ {2}(\w+): \{$/gm`) was shown to
 * be defeated by four shapes a person can write without thinking twice: an
 * entry collapsed onto one line, a quoted key, a trailing comment after the
 * brace, and an entry parked inside a block comment. The first three make the
 * parse silently MISS an entry; the fourth makes it silently INVENT one that
 * the compiler does not see. Either way both sides of the comparison below can
 * still count the same number while disagreeing about which names those are,
 * and the panel ships an effect the API refuses.
 *
 * The alternative considered was a second, independent text parse — counting
 * `renderer:` and `name:` lines — and rejecting a mismatch. It was not taken:
 * it does not remove the failure mode, it only requires the author to trip two
 * text patterns instead of one, and both patterns still have to guess at what
 * an entry looks like. The AST does not guess. `typescript` is already a
 * dependency of this package, so the parse costs nothing to obtain.
 *
 * What the parse cannot see, the compiler cannot see either, which is the whole
 * point: a shape this file refuses to read is a shape that does not ship.
 */

const CATALOG_PATH = join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'branding',
  'card-effect-catalog.ts',
);

interface CatalogEntry {
  /** The record key, which is the effect id. */
  readonly id: string;
  /** Names of the fields the entry sets, for the structural check below. */
  readonly fields: readonly string[];
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

function findCatalogLiteral(source: ts.SourceFile): ts.ObjectLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== 'CARD_EFFECT_CATALOG') continue;
      if (!declaration.initializer) {
        assert.fail('CARD_EFFECT_CATALOG is declared without an initializer');
      }
      const literal = unwrap(declaration.initializer);
      if (!ts.isObjectLiteralExpression(literal)) {
        assert.fail(
          `CARD_EFFECT_CATALOG is a ${ts.SyntaxKind[literal.kind]}, not an object literal — this test can no longer read it`,
        );
      }
      return literal;
    }
  }
  assert.fail('card-effect-catalog.ts no longer declares CARD_EFFECT_CATALOG');
}

/** Name of a property key, for the shapes an effect id may legally be written in. */
function keyText(name: ts.PropertyName, position: number): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  // A computed or numeric key is not an effect id. Refusing it is the point:
  // skipping it would put the catalog and this test back out of step in silence.
  return assert.fail(
    `catalog entry #${position} has a ${ts.SyntaxKind[name.kind]} key, which is not an effect id`,
  );
}

function readCatalogEntries(): CatalogEntry[] {
  const source = ts.createSourceFile(
    CATALOG_PATH,
    readFileSync(CATALOG_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );

  return findCatalogLiteral(source).properties.map((property, index) => {
    // A spread or a shorthand would hide an id from this list, so neither is
    // quietly tolerated: the catalog is a flat record of literals by design.
    if (!ts.isPropertyAssignment(property)) {
      assert.fail(
        `catalog entry #${index} is a ${ts.SyntaxKind[property.kind]}; the catalog must stay a flat record of literal entries`,
      );
    }
    const id = keyText(property.name, index);
    const value = unwrap(property.initializer);
    if (!ts.isObjectLiteralExpression(value)) {
      assert.fail(`catalog entry '${id}' is a ${ts.SyntaxKind[value.kind]}, not an object literal`);
    }
    const fields = value.properties.flatMap((field) =>
      field.name && (ts.isIdentifier(field.name) || ts.isStringLiteral(field.name))
        ? [field.name.text]
        : [],
    );
    return { id, fields };
  });
}

describe('card effect catalog contract', () => {
  it('reads the catalog as the compiler reads it', () => {
    // Without this the comparison below could pass by comparing nothing to
    // nothing the moment the file's shape changes.
    const entries = readCatalogEntries();
    const ids = entries.map((entry) => entry.id);

    assert.ok(ids.length > 20, `expected the panel to offer more than 20 effects, read ${ids.length}`);
    assert.ok(ids.includes('aurora'), 'aurora is the default card effect and must be in the catalog');

    // Two names duplicated in one record is one effect lost at runtime and a
    // list that still looks the right length here.
    assert.equal(new Set(ids).size, ids.length, `duplicate effect ids in the catalog: ${ids.join(', ')}`);

    // Every effect states a display name and a renderer. An entry missing
    // either is not an effect, and its presence would mean this parse latched
    // onto some other object literal that merely happens to be assigned to
    // CARD_EFFECT_CATALOG.
    const incomplete = entries
      .filter((entry) => !entry.fields.includes('name') || !entry.fields.includes('renderer'))
      .map((entry) => entry.id);
    assert.deepEqual(incomplete, [], `catalog entries missing name or renderer: ${incomplete.join(', ')}`);
  });

  it('offers exactly the effects the API accepts', () => {
    const catalog = readCatalogEntries()
      .map((entry) => entry.id)
      .sort();
    // `NONE` is the operator choosing no animation. It is a valid value for the
    // field but not an effect, so the catalog does not carry an entry for it.
    const accepted = CARD_EFFECTS.filter((effect) => effect !== 'NONE').sort();

    assert.deepEqual(catalog, accepted);
  });

  it('accepts the absence of an effect', () => {
    assert.ok(CARD_EFFECTS.includes('NONE'));
  });
});
