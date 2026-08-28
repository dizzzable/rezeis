import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { LEGAL_DOCUMENT_KEYS } from '../src/modules/legal-documents/services/legal-documents.service';

/**
 * The list of legal documents is declared three times in this repo — the
 * Postgres enum, the service, and the admin SPA — and each copy decides
 * something different.
 *
 *   THE ENUM decides what the column can hold. A key the service offers and the
 *   enum does not is a write that fails at the database, on the operator's save.
 *
 *   THE SERVICE decides what is asked for at sign-up: `listRequiredKeys`
 *   filters this array by the active rows, so a document missing from it is
 *   never required no matter how active it is — switched on in the admin UI and
 *   quietly consented to by nobody.
 *
 *   THE SPA decides what an operator can edit. A key it does not know is a
 *   document with nowhere to write its body, and the activation gate refuses an
 *   empty body — so the document can never be turned on at all.
 *
 * Each of those failures looks like a different bug, which is why they are
 * pinned together rather than assumed to move together.
 */

function readDeclaredKeys(relativePath: string, pattern: RegExp): readonly string[] {
  const source = readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
  const match = pattern.exec(source);
  assert.ok(match !== null, `no key list found in ${relativePath}`);
  return match[1]
    .split(/[,\s]+/)
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry.length > 0 && entry !== '//');
}

/**
 * The enum's members, with its `///` doc comments removed first.
 *
 * Necessary rather than tidy: those comments contain ordinary prose, and a word
 * written in capitals inside one is indistinguishable from a member to any
 * pattern that reads the block as a whole.
 */
function readEnumKeys(): readonly string[] {
  const schema = readFileSync(resolve(__dirname, '..', 'prisma/schema.prisma'), 'utf8');
  const block = /enum LegalDocumentKey \{([\s\S]*?)\}/.exec(schema);
  assert.ok(block !== null, 'no LegalDocumentKey enum in the schema');
  return block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('/'))
    .map((line) => line.replace(/\s.*$/, ''));
}

describe('legal document keys', () => {
  it('are the same set in the Postgres enum and the service', () => {
    // Set, not order: PostgreSQL appends enum labels and the column is only
    // ever compared for equality, so the enum has no order to agree with.
    const enumKeys = readEnumKeys();
    assert.deepStrictEqual([...enumKeys].sort(), [...LEGAL_DOCUMENT_KEYS].sort());
  });

  it('are the same list, in the same order, in the service and the admin SPA', () => {
    // Order matters here: both render documents in the order their own array
    // declares, and two orders means the editor and the cabinet list the same
    // documents differently.
    const spaKeys = readDeclaredKeys(
      'web/src/features/legal-documents/legal-documents-api.ts',
      /LEGAL_DOCUMENT_KEYS = \[([^\]]*)\]/,
    );
    assert.deepStrictEqual(spaKeys, [...LEGAL_DOCUMENT_KEYS]);
  });

  it('include the privacy policy the device signals need somewhere to be declared', () => {
    // Not a restatement of the constant: it pins WHY the third key exists. The
    // cabinet derives an install id and a device digest, and a service that
    // does that has to be able to say so somewhere an operator controls.
    assert.ok(LEGAL_DOCUMENT_KEYS.includes('PRIVACY_POLICY'));
  });

  it('give every key a title the admin editor can render', () => {
    // The editor builds its labels from the key
    // (`legalDocumentsPage.documents.<camelCase>.title`), so a key without an
    // entry renders as its own translation path — a card headed
    // "legalDocumentsPage.documents.privacyPolicy.title".
    const bundle = readFileSync(
      resolve(__dirname, '..', 'web/src/i18n/features/legalDocuments.en.ts'),
      'utf8',
    );
    for (const key of LEGAL_DOCUMENT_KEYS) {
      const slug = key
        .toLowerCase()
        .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      assert.ok(bundle.includes(`${slug}: {`), `no editor label for ${key}`);
    }
  });
});
