import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The offline queue double says which bullmq it copies — and that is the one installed.
 * ════════════════════════════════════════════════════════════════════════════════════
 * `test/helpers/bullmq-offline-queue.ts` answers `Queue.remove` the way a named
 * bullmq's `removeJob-2.lua` answers it. Its comment kept naming 5.76 after the
 * dependency moved to ^5.81.5, so a reader could not tell whether anyone had
 * looked at the script the panel actually ships since.
 *
 * `bullmq-late-enqueue.spec.ts` pins the answers themselves to the shipped
 * script; this pins the NAME: every version the double's text cites must be the
 * one in `node_modules`. The next upgrade turns this red until someone re-reads
 * the script and writes the new version in — which is the point.
 */

const projectRoot = join(__dirname, '..');
const helper = readFileSync(join(projectRoot, 'test', 'helpers', 'bullmq-offline-queue.ts'), 'utf8');
const installed = (
  JSON.parse(readFileSync(join(projectRoot, 'node_modules', 'bullmq', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('the offline queue double', () => {
  it('names the bullmq whose removeJob-2.lua it copies, and that is the installed one', () => {
    const cited = [...helper.matchAll(/\bbullmq (\d+\.\d+(?:\.\d+)?)/gi)].map((match) => match[1] ?? '');

    assert.ok(cited.length > 0, 'the double no longer says which bullmq it copies');
    const stale = cited.filter((version) => installed !== version && !installed.startsWith(`${version}.`));
    assert.deepEqual(
      stale,
      [],
      `test/helpers/bullmq-offline-queue.ts cites bullmq ${stale.join(', ')}, but ${installed} is installed — ` +
        're-read node_modules/bullmq/dist/cjs/commands/removeJob-2.lua and update the comment',
    );
  });
});
