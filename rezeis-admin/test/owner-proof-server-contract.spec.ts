import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as vm from 'node:vm';

import * as ts from 'typescript';

import { assertPanelProfileOwnership } from '../src/modules/profile-sync/profile-sync.processor';

/**
 * THE SUBSCRIPTIONS PAGE READS THE SERVER'S WORDS; THIS KEEPS THE TWO IN STEP.
 *
 * Both operator reports on «Подписки» — the panel-link repair and the duplicate
 * merge — receive every ownership refusal under one code, `notOwned`, with a
 * reason. The page tells "belongs to somebody else" from "nothing proves whose
 * it is" by READING that reason (`web/src/features/subscriptions/owner-proof.ts`),
 * and the server builds the reason in `assertPanelProfileOwnership`. The page's
 * own test pins COPIES of the server's sentences, so a reworded refusal would
 * leave both trees green while every unproven profile fell back under "belongs
 * to somebody else", with no way forward shown. Here the server's function and
 * the page's classifier run together: a reword on either side that breaks the
 * split goes red in the suite the person rewording the server runs.
 *
 * The page's module is transpiled and run as it stands rather than imported:
 * `web/` is an ES-module package, which this CommonJS test process cannot
 * require reliably. So the module must stay free of runtime imports, and the
 * loader below refuses one by name rather than failing on an undefined
 * `require`.
 */

const OWNER_PROOF = join(__dirname, '..', 'web', 'src', 'features', 'subscriptions', 'owner-proof.ts');

interface OwnerProofModule {
  readonly OWNER_UNPROVEN: string;
  readonly ownerProofKind: (kind: string, reason: string | null) => string;
}

function loadOwnerProof(): OwnerProofModule {
  const { outputText } = ts.transpileModule(readFileSync(OWNER_PROOF, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true },
    fileName: OWNER_PROOF,
  });
  assert.doesNotMatch(
    outputText,
    /\brequire\(/,
    'owner-proof.ts gained a runtime import; this spec runs it on its own, so keep it self-contained',
  );
  const loaded = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(outputText, { module: loaded, exports: loaded.exports }, { filename: OWNER_PROOF });
  const { OWNER_UNPROVEN, ownerProofKind } = loaded.exports;
  assert.equal(typeof OWNER_UNPROVEN, 'string', 'owner-proof.ts no longer exports OWNER_UNPROVEN');
  assert.equal(typeof ownerProofKind, 'function', 'owner-proof.ts no longer exports ownerProofKind');
  return loaded.exports as unknown as OwnerProofModule;
}

const CUSTOMER = 'cmcustomer00000000000000c1';
const SOMEBODY_ELSE = 'cmsomebody00000000000000s1';

/** A description the way the naming service writes one, ending in the given marker lines. */
function description(...markerLines: readonly string[]): string {
  return ['name: Ivan Petrov', 'login: ivan', 'username: ivan_tg', ...markerLines].join('\n');
}

/** What `assertPanelProfileOwnership` throws for this description and this customer. */
function refusalFor(text: string | null): string {
  try {
    assertPanelProfileOwnership('ivan_tg', text, CUSTOMER);
  } catch (err) {
    return (err as Error).message;
  }
  return assert.fail(`expected a refusal for ${JSON.stringify(text)}`);
}

/**
 * The reason as each report sends it: the link repair sends the message as it
 * is (`panel-link-reconciliation.service.ts`), the merge adds a sentence
 * (`duplicate-subscription-merge.service.ts`).
 */
function asSent(message: string): readonly string[] {
  return [message, `${message}. Nothing was changed.`];
}

describe('the subscriptions page reads the refusals the server actually sends', () => {
  it('the harness tells a proven profile from a refused one', () => {
    assert.doesNotThrow(() =>
      assertPanelProfileOwnership('ivan_tg', description(`reiwa_id: ${CUSTOMER}`), CUSTOMER),
    );
  });

  it('a profile with no marker line is "not proven", in both reports', () => {
    const { OWNER_UNPROVEN, ownerProofKind } = loadOwnerProof();
    const noMarkerLine = [
      null,
      '',
      description(),
      // The display name is the customer's own text and cannot BE the marker line.
      `name: reiwa_id: ${CUSTOMER}\nlogin: ivan`,
    ];
    for (const text of noMarkerLine) {
      for (const reason of asSent(refusalFor(text))) {
        assert.equal(ownerProofKind('notOwned', reason), OWNER_UNPROVEN, reason);
      }
    }
  });

  it('marker lines that name different customers are "not proven", in both reports', () => {
    const { OWNER_UNPROVEN, ownerProofKind } = loadOwnerProof();
    for (const reason of asSent(refusalFor(description(`reiwa_id: ${CUSTOMER}`, `reiwa_id: ${SOMEBODY_ELSE}`)))) {
      assert.equal(ownerProofKind('notOwned', reason), OWNER_UNPROVEN, reason);
    }
  });

  it('each "not proven" refusal tells the operator the way through that the card offers now', () => {
    // The card accepts more than it did (19.09.2026): a verified web-account
    // e-mail, and — with no proof at all — the operator's own confirmation. A
    // line naming somebody else refuses there too, so that one has to be
    // corrected first.
    assert.match(
      refusalFor(description()),
      /a matching Telegram id, e-mail or verified web-account e-mail proves it, and with none of them you can confirm it yourself/,
    );
    assert.match(
      refusalFor(description(`reiwa_id: ${CUSTOMER}`, `reiwa_id: ${SOMEBODY_ELSE}`)),
      /Correct the lines in Remnawave first: nothing links a profile while a line names somebody else/,
    );
  });

  it('a marker naming somebody else stays "belongs to somebody else", in both reports', () => {
    const { ownerProofKind } = loadOwnerProof();
    for (const reason of asSent(refusalFor(description(`reiwa_id: ${SOMEBODY_ELSE}`)))) {
      assert.equal(ownerProofKind('notOwned', reason), 'notOwned', reason);
    }
  });
});
