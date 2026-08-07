import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Dependency security floor
 * ─────────────────────────
 * Five Trivy alerts were open against the published image at once, and every
 * one of them was a transitive package sitting one patch release below its
 * fix. Two of the five were held there by this repository itself: `overrides`
 * carried `fast-uri: "3.1.4"` and `js-yaml: "4.3.0"`, exact versions added to
 * force an upgrade at some earlier moment. An exact override is not a floor,
 * it is a ceiling — the day the pinned version becomes the vulnerable one, the
 * pin is what keeps it installed, and `npm update` cannot move it.
 *
 * So this file asserts two separate things:
 *
 *   1. no lockfile in this repository resolves one of these packages below the
 *      version that fixed it, and
 *   2. the overrides that exist for them stay expressed as ranges, so the next
 *      patch is picked up instead of frozen out.
 *
 * The floor is keyed by major, because a lockfile legitimately holds several
 * majors of the same package side by side (jsdom pulls undici 7 while the app
 * uses undici 8) and each line has its own fix. A major absent from the table
 * is not asserted: this guards the versions we know were vulnerable, it does
 * not claim to know about versions that did not exist when it was written.
 */

type Floor = {
  readonly package: string;
  readonly major: number;
  readonly min: string;
  readonly advisory: string;
};

const FLOORS: readonly Floor[] = [
  {
    package: 'socket.io-parser',
    major: 4,
    min: '4.2.7',
    advisory: 'CVE-2026-69185 — a packet declaring zero attachments leaves the ' +
      'reconstructor armed, so every following binary frame is buffered forever',
  },
  {
    package: 'ip-address',
    major: 10,
    min: '10.3.1',
    advisory: 'CVE-2026-69192 (also 69198, 54272) — leading-zero octets decoded ' +
      'as decimal while the resolver reads them as octal',
  },
  {
    package: 'fast-uri',
    major: 3,
    min: '3.1.5',
    advisory: 'CVE-2026-18446 — a backslash authority introducer parses as path, ' +
      'so fast-uri and the WHATWG parser disagree about the host',
  },
  {
    package: 'js-yaml',
    major: 4,
    min: '4.3.1',
    advisory: 'GHSA — quadratic CPU consumption resolving !!omap',
  },
  {
    package: 'brace-expansion',
    major: 5,
    min: '5.0.9',
    advisory: 'GHSA — denial of service via unbounded intermediate arrays',
  },
  {
    package: 'postcss',
    major: 8,
    min: '8.5.23',
    advisory: 'GHSA-fxqj-rqcc-2cmp — attacker-controlled sourceMappingURL reads ' +
      'arbitrary .map files when `from` is unset',
  },
  {
    package: 'undici',
    major: 7,
    min: '7.29.0',
    advisory: 'GHSA-8xcm-r25x-g524 and others — response desynchronization and ' +
      'cross-user disclosure',
  },
];

/**
 * Packages this repository forces to a version its dependents did not ask for.
 * The value has to keep a range operator: an exact pin here is what turned two
 * fixed versions back into vulnerable ones.
 */
const RANGED_OVERRIDES: readonly string[] = ['brace-expansion', 'fast-uri', 'js-yaml'];

const LOCKFILES: readonly string[] = ['package-lock.json', 'web/package-lock.json'];
const MANIFESTS: readonly string[] = ['package.json', 'web/package.json'];

const repositoryRoot = path.resolve(__dirname, '..');

function readJson(relativePath: string): Record<string, unknown> {
  const absolute = path.join(repositoryRoot, relativePath);
  return JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
}

/** Concrete `x.y.z` from a lockfile — never a range, so a numeric compare is enough. */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

type Installed = { readonly path: string; readonly version: string };

function collectInstalled(lockfile: string, packageName: string): Installed[] {
  const lock = readJson(lockfile);
  const packages = (lock['packages'] ?? {}) as Record<string, { version?: string }>;
  const found: Installed[] = [];
  for (const [entryPath, node] of Object.entries(packages)) {
    const segments = entryPath.split('node_modules/');
    if (segments.length < 2) {
      continue;
    }
    if (segments[segments.length - 1] !== packageName) {
      continue;
    }
    const version = node.version;
    if (typeof version === 'string' && version.length > 0) {
      found.push({ path: entryPath, version });
    }
  }
  return found;
}

describe('dependency security floor', () => {
  for (const lockfile of LOCKFILES) {
    for (const floor of FLOORS) {
      it(`${lockfile}: ${floor.package}@${floor.major}.x stays at or above ${floor.min}`, () => {
        const installed = collectInstalled(lockfile, floor.package).filter(
          (entry) => Number.parseInt(entry.version.split('.')[0] ?? '', 10) === floor.major,
        );

        // Not every package is present in every tree, and that is fine —
        // the assertion is about the copies that ARE resolved.
        for (const entry of installed) {
          assert.ok(
            compareVersions(entry.version, floor.min) >= 0,
            `${lockfile} resolves ${entry.path} to ${floor.package}@${entry.version}, ` +
              `below the ${floor.min} that fixed ${floor.advisory}`,
          );
        }
      });
    }
  }

  for (const manifest of MANIFESTS) {
    it(`${manifest}: forced versions are ranges, not frozen pins`, () => {
      const overrides = (readJson(manifest)['overrides'] ?? {}) as Record<string, unknown>;
      for (const packageName of RANGED_OVERRIDES) {
        const value = overrides[packageName];
        if (value === undefined) {
          continue;
        }
        assert.equal(
          typeof value,
          'string',
          `${manifest} overrides ${packageName} with a non-string value`,
        );
        assert.match(
          value as string,
          /^[\^~]|^>=/,
          `${manifest} pins ${packageName} to the exact version ${String(value)}. ` +
            'An exact override is a ceiling: when that version turns out to be the ' +
            'vulnerable one, nothing can move off it. Use a range such as ' +
            `"^${String(value)}".`,
        );
      }
    });
  }
});
