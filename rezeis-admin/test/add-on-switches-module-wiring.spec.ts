import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AddOnSwitchesModule } from '../src/modules/add-on-entitlements/switches/add-on-switches.module';
import { AddOnSwitchesService } from '../src/modules/add-on-entitlements/switches/add-on-switches.service';

/**
 * Every reader of the add-on switches can actually reach them
 * ═══════════════════════════════════════════════════════════
 * The stages of the durable add-on model are panel switches, and every service
 * that reads one takes `AddOnSwitchesService` as an `@Optional()` constructor
 * parameter — optional only so the unit specs can build those services by
 * hand. The price of `@Optional()` is that a module which declares such a
 * reader WITHOUT importing `AddOnSwitchesModule` boots perfectly well: Nest
 * injects `undefined`, the reader falls back to `.env` and the defaults, and
 * the switch on the page silently does nothing in that module. `tsc` cannot
 * see it, and neither can any spec that builds the service by hand.
 *
 * So the check is structural, modelled on `reiwa-relay-module-wiring.spec.ts`:
 * find the classes that take `AddOnSwitchesService` in their constructor by
 * reading the tree (not from a list — a list is exactly what the next reader
 * would not be on), find the modules that DECLARE any of them, and require
 * each such module to SEE `AddOnSwitchesModule` the way Nest resolves it: an
 * import of its own, or a module it imports that re-exports it. An import of
 * an import is not enough. `PaymentsModule` imports `AddOnEntitlementsModule`,
 * which imports the switches without re-exporting them; mere reachability
 * would call `PaymentsModule` wired with its own import deleted, while Nest
 * would inject `undefined` into every payments reader.
 */

const SRC_ROOT = join(__dirname, '..', 'src');

function walk(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, suffix));
    else if (entry.endsWith(suffix)) out.push(full);
  }
  return out;
}

/** Class names whose source names `AddOnSwitchesService` as a parameter type. */
function readerClassNames(): string[] {
  const names = new Set<string>();
  for (const file of walk(SRC_ROOT, '.ts')) {
    const source = readFileSync(file, 'utf8');
    if (!/:\s*AddOnSwitchesService\b/.test(source)) continue;
    for (const match of source.matchAll(/export class (\w+)/g)) names.add(match[1]!);
  }
  return [...names];
}

type Ctor = new (...args: never[]) => object;

const isCtor = (value: unknown): value is Ctor => typeof value === 'function';

/** The module class of an `imports`/`exports` entry: a dynamic module carries its own. */
function moduleOf(entry: unknown): unknown {
  return entry !== null && typeof entry === 'object' && 'module' in entry ? (entry as { module: unknown }).module : entry;
}

/** A module, not a provider: `@Module` writes these keys, `@Injectable` none of them. */
function isModule(value: unknown): boolean {
  return (
    isCtor(value) &&
    ['imports', 'providers', 'controllers', 'exports'].some((key) => Reflect.getMetadata(key, value) !== undefined)
  );
}

/**
 * The modules whose exports `root` can inject — Nest's rule: every module it
 * imports, and every module one of those RE-EXPORTS, recursively. Not the
 * imports of its imports.
 */
function visibleModules(root: unknown): Set<unknown> {
  const visible = new Set<unknown>();
  const queue: unknown[] = ((Reflect.getMetadata('imports', root as object) ?? []) as unknown[]).map(moduleOf);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || visible.has(current)) continue;
    visible.add(current);
    for (const exported of (Reflect.getMetadata('exports', current as object) ?? []) as unknown[]) {
      const target = moduleOf(exported);
      if (isModule(target)) queue.push(target);
    }
  }
  return visible;
}

function readsSwitches(declared: unknown): boolean {
  if (!isCtor(declared)) return false;
  const params = (Reflect.getMetadata('design:paramtypes', declared) ?? []) as unknown[];
  return params.includes(AddOnSwitchesService);
}

describe('every module that declares a reader of the add-on switches can resolve them', () => {
  it('finds the readers by reading the tree, not from a hand-kept list', () => {
    const names = readerClassNames();
    // One per module that imports the switches today, and the controller.
    for (const expected of [
      'PaymentSubscriptionMutationService',
      'AddOnEligibilityService',
      'EntitlementBoundaryService',
      'AddOnPurchaseService',
      'AdminAddOnSwitchesController',
    ]) {
      assert.ok(names.includes(expected), `${expected} must be detected as a reader; found ${names.join(', ')}`);
    }
  });

  it('imports AddOnSwitchesModule wherever a declared provider or controller reads the switches', async () => {
    const readers = readerClassNames();
    const candidates = walk(SRC_ROOT, '.module.ts')
      // Never the composition root: importing it runs the whole environment
      // schema (see `reiwa-relay-module-wiring.spec.ts`), and a reader belongs
      // in a feature module anyway.
      .filter((file) => !file.endsWith('app.module.ts'))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return readers.some((name) => source.includes(name));
      });

    const offenders: string[] = [];
    const checkedModules: string[] = [];
    for (const file of candidates) {
      const loaded = (await import(file)) as Record<string, unknown>;
      for (const [exportName, exported] of Object.entries(loaded)) {
        if (!isCtor(exported)) continue;
        const providers = (Reflect.getMetadata('providers', exported) ?? []) as unknown[];
        const controllers = (Reflect.getMetadata('controllers', exported) ?? []) as unknown[];
        const declared = [...providers, ...controllers].filter(readsSwitches);
        if (declared.length === 0) continue;
        checkedModules.push(exportName);
        // The switches' own module declares the service it injects.
        const declaresTheService = providers.includes(AddOnSwitchesService);
        if (!visibleModules(exported).has(AddOnSwitchesModule) && !declaresTheService) {
          const names = declared.map((c) => (c as Ctor).name).join(', ');
          offenders.push(`${exportName} declares ${names} but does not see AddOnSwitchesModule's exports`);
        }
      }
    }

    // Non-vacuity: the three modules that declare readers today, and the
    // switches' own module (its controller), were actually examined.
    for (const expected of ['PaymentsModule', 'AddOnsModule', 'AddOnEntitlementsModule', 'AddOnSwitchesModule']) {
      assert.ok(checkedModules.includes(expected), `${expected} must have been checked; checked ${checkedModules.join(', ')}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('reads the stages only through the switches: no bare resolver, no reader left out, no raw ADDON_* variable', () => {
    const CONFIG = 'modules/add-on-entitlements/add-on-rollout.config.ts';
    const SERVICE = 'modules/add-on-entitlements/switches/add-on-switches.service.ts';
    const offenders: string[] = [];
    let readers = 0;
    for (const file of walk(SRC_ROOT, '.ts')) {
      const relativePath = file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
      if (relativePath === CONFIG) continue;
      const source = readFileSync(file, 'utf8');
      source.split(/\r?\n/).forEach((text, index) => {
        const at = `${relativePath}:${index + 1}`;
        // `.env` and the defaults alone: the switch on the page ignored.
        if (/\bresolveAddOnRolloutFlags\(/.test(text) && relativePath !== SERVICE) offenders.push(`${at} resolves without the switches`);
        for (const call of text.matchAll(/\breadAddOnRolloutFlags\(([^)]*)\)/g)) {
          readers += 1;
          if (call[1]!.trim() !== 'this.addOnSwitches') offenders.push(`${at} reads the flags without its reader: ${call[0]}`);
        }
        if (/process\.env(\.|\[')ADDON_(ENTITLEMENT|DEVICE|RESET)/.test(text)) offenders.push(`${at} reads a stage variable directly`);
      });
    }
    assert.ok(readers >= 10, `only ${readers} reads of the flags found — the scan has gone blind`);
    assert.deepEqual(offenders, []);
  });

  it('declares AddOnSwitchesService in ONE module only, so both processes share one reader', () => {
    const declaring = walk(SRC_ROOT, '.module.ts').filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /providers:\s*\[[^\]]*\bAddOnSwitchesService\b/s.test(source);
    });
    assert.deepEqual(
      declaring.map((file) => file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/')),
      ['modules/add-on-entitlements/switches/add-on-switches.module.ts'],
    );
  });
});
