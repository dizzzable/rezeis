import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ReiwaRelayModule } from '../src/modules/notifications/reiwa-relay.module';
import { ReiwaRelayQueueService } from '../src/modules/notifications/services/reiwa-relay-queue.service';

/**
 * A provider is resolved by the module that DECLARES it
 * ═════════════════════════════════════════════════════
 * `ReiwaCacheInvalidatorService` is declared in three places, not one:
 * `BotConfigModule` exports it, and `BotFlowModule` and `LegalDocumentsModule`
 * each declare their own copy on the reasoning that a stateless env-built
 * dispatcher is cheaper to duplicate than to import a whole bot editor for.
 *
 * That reasoning holds right up until the service gains a dependency. Giving it
 * one — the relay queue producer — broke both local declarations at once, and
 * broke them in the worst available way: `tsc` is perfectly happy, every test
 * that constructs the service by hand is perfectly happy, and the only thing
 * that ever says otherwise is Nest refusing to boot in production.
 *
 * So the check is structural rather than behavioural. Find the classes that
 * take `ReiwaRelayQueueService` in their constructor, find the modules that
 * DECLARE any of them, and require each such module to reach
 * `ReiwaRelayModule` through its own import graph.
 *
 * Both halves start from the file tree rather than from a list, because a list
 * is exactly what the next locally-declared copy would not be on. Only the
 * modules that name a consumer are actually imported — importing the whole
 * tree to answer a question about four files costs half a minute and drags in
 * every module's load-time side effects.
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

/** Class names whose source names `ReiwaRelayQueueService` as a constructor param. */
function consumerClassNames(): string[] {
  const names = new Set<string>();
  for (const file of walk(SRC_ROOT, '.ts')) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('ReiwaRelayQueueService')) continue;
    // `private readonly x: ReiwaRelayQueueService` / `x: ReiwaRelayQueueService,`
    if (!/:\s*ReiwaRelayQueueService\b/.test(source)) continue;
    for (const match of source.matchAll(/export class (\w+)/g)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

type Ctor = new (...args: never[]) => object;

const isCtor = (value: unknown): value is Ctor => typeof value === 'function';

/** Every module reachable from `root` through `imports`, including itself. */
function reachableImports(root: unknown): Set<unknown> {
  const seen = new Set<unknown>([root]);
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    const imports = (Reflect.getMetadata('imports', current as object) ?? []) as unknown[];
    for (const imported of imports) {
      // `forwardRef()` and `.register()` results are objects, not classes; a
      // dynamic module carries its own `module` key.
      const target =
        imported !== null && typeof imported === 'object' && 'module' in imported
          ? (imported as { module: unknown }).module
          : imported;
      if (target === undefined || target === null || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

function needsRelayQueue(provider: unknown): boolean {
  if (!isCtor(provider)) return false;
  const params = (Reflect.getMetadata('design:paramtypes', provider) ?? []) as unknown[];
  return params.includes(ReiwaRelayQueueService);
}

describe('every module that declares a relay-queue consumer can resolve it', () => {
  it('finds the consumer classes by reading the tree, not from a hand-kept list', () => {
    const names = consumerClassNames();
    assert.ok(
      names.includes('ReiwaCacheInvalidatorService'),
      `the invalidator must be detected as a consumer; found ${names.join(', ')}`,
    );
    assert.ok(
      names.includes('UserNotificationsService'),
      `the notification fanout must be detected as a consumer; found ${names.join(', ')}`,
    );
  });

  it('imports ReiwaRelayModule wherever a declared provider needs the queue', async () => {
    const consumers = consumerClassNames();
    const candidates = walk(SRC_ROOT, '.module.ts').filter((file) => {
      const source = readFileSync(file, 'utf8');
      return consumers.some((name) => source.includes(name));
    });

    const offenders: string[] = [];
    let checked = 0;
    for (const file of candidates) {
      const loaded = (await import(file)) as Record<string, unknown>;
      for (const [exportName, exported] of Object.entries(loaded)) {
        if (!isCtor(exported)) continue;
        const providers = Reflect.getMetadata('providers', exported) as unknown[] | undefined;
        if (providers === undefined) continue;
        const declared = providers.filter(needsRelayQueue);
        if (declared.length === 0) continue;
        checked += 1;
        if (!reachableImports(exported).has(ReiwaRelayModule)) {
          const names = declared.map((c) => (c as Ctor).name).join(', ');
          offenders.push(`${exportName} declares ${names} but cannot reach ReiwaRelayModule`);
        }
      }
    }

    // A scan that finds nothing agrees with an empty tree forever. Three
    // modules declare the invalidator and one declares the fanout.
    assert.ok(
      checked >= 3,
      `expected to find the modules that declare relay-queue consumers, found ${checked}`,
    );
    assert.deepStrictEqual(offenders, []);
  });

  it('would notice a module that declared a consumer without the import', () => {
    // The scan above is only worth its runtime if it can go red. Exercise it
    // against a synthetic module rather than trusting that the tree happens to
    // be clean today.
    class LocalConsumer {
      public constructor(_queue: ReiwaRelayQueueService) {}
    }
    Reflect.defineMetadata('design:paramtypes', [ReiwaRelayQueueService], LocalConsumer);

    class ForgetfulModule {}
    Reflect.defineMetadata('providers', [LocalConsumer], ForgetfulModule);
    Reflect.defineMetadata('imports', [], ForgetfulModule);

    const providers = Reflect.getMetadata('providers', ForgetfulModule) as unknown[];
    assert.equal(providers.filter(needsRelayQueue).length, 1, 'the consumer must be detected');
    assert.equal(
      reachableImports(ForgetfulModule).has(ReiwaRelayModule),
      false,
      'and the missing import must be reported',
    );
  });

  it('follows imports transitively, so an indirect route still counts', () => {
    class Middle {}
    Reflect.defineMetadata('imports', [ReiwaRelayModule], Middle);
    class Outer {}
    Reflect.defineMetadata('imports', [Middle], Outer);

    assert.equal(reachableImports(Outer).has(ReiwaRelayModule), true);
  });
});
