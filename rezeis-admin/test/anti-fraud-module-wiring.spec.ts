import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AntiFraudModule } from '../src/modules/anti-fraud/anti-fraud.module';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import { AntiFraudTunablesService } from '../src/modules/anti-fraud/services/anti-fraud-tunables.service';
import { PanelDevicesClient } from '../src/modules/remnawave/services/panel-devices.client';
import { PanelInfraClient } from '../src/modules/remnawave/services/panel-infra.client';
import { RemnawaveVersionService } from '../src/modules/remnawave/services/remnawave-version.service';
import { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsModule } from '../src/modules/settings/settings.module';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * Every other spec in this change builds the detectors with `new` and hands
 * them a stub reader. That proves the logic and proves nothing about the one
 * new edge in the module graph: `AntiFraudModule` → `SettingsModule`.
 *
 * That edge has exactly two ways to be wrong, and both are fatal at boot rather
 * than degrading quietly:
 *
 *   1. a circular import — `SettingsModule` would be `undefined` inside
 *      `AntiFraudModule`'s decorator metadata, because the decorator captures
 *      the value at class-definition time and a require cycle leaves the
 *      not-yet-finished module's exports empty;
 *   2. an unregistered provider — the detectors take the reader as a required
 *      constructor argument, so Nest would refuse to instantiate them.
 *
 * Both are checked below. Standing up the real Nest container instead was tried
 * and rejected: `AntiFraudModule` reaches through `RemnawaveModule`, and
 * `SettingsModule` through `BotConfigModule`, into a spread of `AppModule`'s
 * global providers — all of it predating this change. A spec that has to
 * assemble half the application fails for reasons unrelated to anti-fraud, and
 * a test that fails for unrelated reasons stops being read.
 */
describe('AntiFraudModule wiring', () => {
  it('imports SettingsModule as a real class — an import cycle would leave it undefined', () => {
    const imports = Reflect.getMetadata('imports', AntiFraudModule) as readonly unknown[];
    assert.ok(Array.isArray(imports));
    assert.ok(
      !imports.includes(undefined),
      'an undefined entry in the imports array is the signature of a require cycle',
    );
    assert.equal(typeof SettingsModule, 'function');
    assert.ok(
      imports.includes(SettingsModule),
      'the detectors read panel-stored tunables, so SettingsModule must be imported',
    );
    // ...and the cycle would have to be symmetric to matter, so check the other
    // direction too: settings must not reach back into anti-fraud.
    const settingsImports = Reflect.getMetadata('imports', SettingsModule) as readonly unknown[];
    assert.ok(!settingsImports.includes(AntiFraudModule));
    assert.ok(!settingsImports.includes(undefined));
  });

  it('registers the tunables reader and injects it into every detector that reads it', () => {
    const providers = Reflect.getMetadata('providers', AntiFraudModule) as readonly unknown[];
    assert.ok(
      providers.includes(AntiFraudTunablesService),
      'an unregistered reader is a boot-time crash, not a degraded detector',
    );
    // Required, never `@Optional()`. If it were optional, a wiring mistake would
    // stop being a loud startup failure and become a detector reading nothing.
    for (const detector of [SharingDetectors, RemnawaveDetectors, SubscriptionUaDetectors]) {
      const params = Reflect.getMetadata('design:paramtypes', detector) as readonly unknown[];
      assert.ok(
        params.includes(AntiFraudTunablesService),
        `${detector.name} must take the tunables reader by injection`,
      );
    }
  });

  it('takes the panel through the contract-driven clients, and no version service', () => {
    // The panel clients are provided AND exported by `RemnawaveModule`, so
    // injecting them by class token is all this module has to do. The assertion
    // that matters is the SECOND half: `RemnawaveVersionService` must not be a
    // constructor argument of anything here any more.
    //
    // Every gate it fed asked which of 2.7 / 2.8 / 3.x the panel is, and this
    // build serves 3.x only — a 2.x panel is refused once, centrally, by
    // `LegacyPanelRefusal`. Worse, those gates answered "stand down" for an
    // UNKNOWN version, which is the state a healthy panel passes through on a
    // token blip, so a detector went quiet exactly when it was least able to
    // tell that from a clean panel. Re-introducing the dependency here is how
    // that comes back.
    type Named = { readonly name: string };
    const byDetector: ReadonlyArray<[Named, readonly Named[]]> = [
      [SharingDetectors, [PanelDevicesClient, PanelInfraClient]],
      [RemnawaveDetectors, [PanelDevicesClient, PanelInfraClient]],
      [SubscriptionUaDetectors, [PanelInfraClient]],
      [AntiFraudService, [PanelDevicesClient]],
    ];
    for (const [detector, required] of byDetector) {
      const params = Reflect.getMetadata(
        'design:paramtypes',
        detector as object,
      ) as readonly unknown[];
      for (const client of required) {
        assert.ok(
          params.includes(client),
          `${detector.name} must take ${client.name} by injection`,
        );
      }
      assert.ok(
        !params.includes(RemnawaveVersionService),
        `${detector.name} must not read panel capabilities any more`,
      );
    }
  });

  it('resolves defaults through the real reader over the real settings service', async () => {
    // The two classes wired to each other for real — no `resolve` double, no
    // `getAntiFraudTunablesRuntime` double — over a settings row that does not
    // exist. This is the path a fresh install takes on its first detector run.
    const settingsService = new SettingsService(
      { settings: { findFirst: async () => null } } as never,
      {} as unknown as IconUploadService,
      { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
    );
    const resolved = await new AntiFraudTunablesService(settingsService).resolve();

    assert.equal(resolved.sharing.ipWindowMinutes, 10);
    assert.equal(resolved.sharing.maxNodesPerRun, 25);
    assert.equal(resolved.sharing.enableHwidOverage, true);
    assert.equal(resolved.trafficAbuse.minGb, 200);
    assert.equal(resolved.trafficAbuse.medianMultiplier, 4);
    assert.equal(resolved.trafficAbuse.maxNodesPerRun, 25);
    // Two layers, not three: no ANTIFRAUD_UA_* variable exists, so this is the
    // built-in default with nothing under it — and it is OFF.
    assert.equal(resolved.subscriptionUa.enableSubscriptionUaTunnel, false);
    assert.equal(resolved.subscriptionUa.uaEvidenceWindowMinutes, 60);
    assert.equal(resolved.subscriptionUa.uaRequestPageSize, 500);
  });
});

/**
 * A detector nobody calls
 * ───────────────────────
 * `SubscriptionUaDetectors` was written, tested, and provided by the module —
 * and left out of `AntiFraudService.runDetectors`, so it never ran once. It is
 * the ninth recorded instance in this project of a correct decision whose branch
 * production never reaches, and the previous eight are why this is a test rather
 * than a note.
 *
 * The invariant is derived from the return TYPE, not from a naming convention,
 * because that is what actually separates the two plans:
 *
 *   `Promise<readonly FraudSignalCandidate[]>`  → the detector plan. Its output
 *      accuses a customer; the plan is also what decides that code's evidence
 *      class, its hysteresis gate and whether an empty run may auto-resolve it.
 *      A method missing from here does not degrade — it does not run.
 *   `Promise<readonly OperationalAlert[]>`      → the alert plan. Its output is
 *      an infrastructure fact for the operator event channel.
 *
 * Both directions are asserted. A method absent from its plan is the bug above;
 * a plan entry naming a method that no longer exists is a run that throws on
 * every tick.
 */
const DETECTORS_DIR = join(__dirname, '..', 'src', 'modules', 'anti-fraud', 'detectors');
const SERVICE_FILE = join(
  __dirname,
  '..',
  'src',
  'modules',
  'anti-fraud',
  'services',
  'anti-fraud.service.ts',
);

describe('every detector that exists is reached by a detector run', () => {
  it('runs every method that produces fraud candidates', () => {
    const declared = declaredMethods('FraudSignalCandidate');
    assert.ok(declared.length >= 7, `parsed only ${declared.length} candidate-producing methods`);

    assert.deepStrictEqual(
      declared,
      planEntries('plan').map((e) => e.name).sort(),
      'A public method returning FraudSignalCandidate[] that is not in `runDetectors`\'s ' +
        '`plan` is a detector that never runs — it produces no signal, its code is ' +
        'never gated, and it can never auto-resolve. Register it (with an `evidence` ' +
        'class) or delete it.',
    );
  });

  it('runs every method that produces operational alerts', () => {
    assert.deepStrictEqual(
      declaredMethods('OperationalAlert'),
      planEntries('alertPlan').map((e) => e.name).sort(),
      'A public method returning OperationalAlert[] that is not in `alertPlan` never ' +
        'reaches the operator event channel.',
    );
  });

  it('calls the method each plan entry names, so `name` cannot label the wrong run', () => {
    for (const entry of [...planEntries('plan'), ...planEntries('alertPlan')]) {
      assert.equal(
        entry.called,
        entry.name,
        `plan entry "${entry.name}" actually calls ${entry.called}() — the name is what ` +
          'every warning, log line and failure message in the run reports',
      );
    }
  });

  it('offers every registered code in the operator’s exemption picker', () => {
    // `FRAUD_DETECTOR_CODES` is the ONLY place an operator can pick a code when
    // granting an exemption. A code the run plan files but that list omits is a
    // condition nobody can ever clear a customer of — the same shape as the
    // unregistered detector above, one surface further out. Read out of the SPA
    // source rather than duplicated, so a copy cannot agree with itself while
    // the page drifts.
    const planCodes = [...new Set(planEntries('plan').flatMap((e) => e.codes))].sort();
    assert.deepStrictEqual(
      planCodes,
      [...readExemptionCodePicker()].sort(),
      'The run plan and web/src/features/fraud/fraud-api.ts FRAUD_DETECTOR_CODES disagree. ' +
        'A registered code missing from the picker cannot be exempted; a picker entry no ' +
        'detector produces is a dead tick-box.',
    );
  });

  it('classifies the subscription-UA detector as observational', () => {
    // Not cosmetic. `codesRequiringSustainedEvidence` derives the hysteresis gate
    // from this field, and `runDetectors` uses it to decide that an empty result
    // from a panel read is not evidence the condition cleared. Marked
    // `authoritative`, switching this detector off — or a panel outage — would
    // auto-resolve every open SUBSCRIPTION_UA_TUNNEL signal.
    const entry = planEntries('plan').find((e) => e.name === 'detectSubscriptionUaTunnel');
    assert.ok(entry, 'detectSubscriptionUaTunnel is not in the run plan');
    assert.equal(entry.evidence, 'observational');
    assert.deepStrictEqual(entry.codes, ['SUBSCRIPTION_UA_TUNNEL']);
  });
});

const EXEMPTION_PICKER_FILE = join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'fraud',
  'fraud-api.ts',
);

/** The codes the SPA's exemption dialog can draw a tick-box for. */
function readExemptionCodePicker(): readonly string[] {
  const source = readFileSync(EXEMPTION_PICKER_FILE, 'utf8');
  const declaration = source.indexOf('export const FRAUD_DETECTOR_CODES');
  assert.ok(declaration >= 0, `FRAUD_DETECTOR_CODES not found in ${EXEMPTION_PICKER_FILE}`);
  const open = source.indexOf('[', declaration);
  const close = source.indexOf(']', open);
  assert.ok(close > open, 'FRAUD_DETECTOR_CODES literal is not bracket-balanced');
  const codes = [...source.slice(open, close).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length > 5, `parsed ${codes.length} codes — the parse, not the list, is wrong`);
  return codes;
}

/** Public detector methods returning `Promise<readonly <element>[]>`, sorted. */
function declaredMethods(element: string): readonly string[] {
  const names: string[] = [];
  for (const file of readdirSync(DETECTORS_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(DETECTORS_DIR, file), 'utf8');
    const pattern = new RegExp(
      String.raw`public async (\w+)\s*\([^)]*\)\s*:\s*Promise<readonly ${element}\[\]>`,
      'g',
    );
    for (const match of source.matchAll(pattern)) names.push(match[1]);
  }
  return names.sort();
}

interface ParsedPlanEntry {
  readonly name: string;
  /** The method the entry's `run` thunk actually invokes. */
  readonly called: string;
  readonly codes: readonly string[];
  readonly evidence: string | null;
}

/** The entries of `runDetectors`'s `plan` / `alertPlan` array literal. */
function planEntries(variable: string): readonly ParsedPlanEntry[] {
  const source = readFileSync(SERVICE_FILE, 'utf8');
  const declaration = source.indexOf(`const ${variable}`);
  assert.ok(declaration >= 0, `${variable} not found in ${SERVICE_FILE}`);
  // `= [`, not the first `[` — the type annotation (`DetectorPlanEntry[]`) gets
  // there first and would yield an empty, everything-agrees parse.
  const assignment = source.indexOf('= [', declaration);
  assert.ok(assignment > declaration, `${variable} is not assigned an array literal`);
  const open = assignment + 2;
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  assert.ok(close > open, `${variable} array literal is not bracket-balanced`);
  const body = source.slice(open, close + 1);

  const entries: ParsedPlanEntry[] = [];
  for (const match of body.matchAll(/name:\s*'([^']+)'/g)) {
    const from = match.index ?? 0;
    // Everything up to the next `name:`, so each field is read out of its own entry.
    const nextName = body.slice(from + match[0].length).search(/name:\s*'/);
    const chunk = body.slice(from, nextName < 0 ? undefined : from + match[0].length + nextName);
    const called = /run:\s*\(\)\s*=>\s*this\.\w+\.(\w+)\(/.exec(chunk);
    const evidence = /evidence:\s*'([^']+)'/.exec(chunk);
    entries.push({
      name: match[1],
      called: called ? called[1] : '(no run thunk parsed)',
      codes: [...chunk.matchAll(/codes:\s*\[([^\]]*)\]/g)]
        .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)])
        .map((m) => m[1]),
      evidence: evidence ? evidence[1] : null,
    });
  }
  // A parse that silently found nothing would agree with everything.
  assert.ok(entries.length > 0, `parsed no entries out of ${variable}`);
  return entries;
}
