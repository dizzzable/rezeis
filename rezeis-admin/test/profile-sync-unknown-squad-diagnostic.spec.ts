import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProfileSyncProcessor } from '../src/modules/profile-sync/profile-sync.processor';

/**
 * Turning the panel's `A039 Update user error` into something an operator can act on.
 *
 * REPRODUCED against a live Remnawave 3.3.2 before this was written: a PATCH
 * carrying a well-formed but non-existent squad uuid answers HTTP 500 with
 * `A039 Update user error` — no field, no value, no hint. The same PATCH with a
 * squad that exists answers 200, and a malformed uuid answers 400. So the 500 is
 * specifically "this uuid names nothing", and it is the panel's catch-all.
 *
 * That happens for an ordinary reason: a squad deleted or RECREATED in Remnawave
 * keeps its old uuid in the plan and in every subscription sold on it. Recreating
 * is the cruel one — same name, new uuid — so both screens look right while every
 * renewal fails. Squads are validated when a plan is SAVED and never again.
 *
 * The private method is reached directly. It is a diagnostic that runs only on
 * the failure path, and driving the whole update path to observe one string
 * would test the mocks rather than the decision.
 */

type Diagnostic = (
  internalSquads: readonly string[],
  externalSquad: string | null,
) => Promise<string>;

function build(infra: unknown) {
  const processor = new ProfileSyncProcessor(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    infra as never,
  );
  return (
    processor as unknown as { describeUnknownSquads: Diagnostic }
  ).describeUnknownSquads.bind(processor);
}

const ok = (uuids: readonly string[]) => ({
  kind: 'ok' as const,
  data: uuids.map((uuid) => ({ uuid, name: `squad ${uuid.slice(0, 4)}` })),
});

const KNOWN = 'aaaaaaaa-0000-4000-8000-000000000001';
const GONE = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('naming the squad the panel does not know', () => {
  it('says nothing when every squad still exists', async () => {
    const describe_ = build({
      getInternalSquadOptions: async () => ok([KNOWN]),
      getExternalSquadOptions: async () => ok([]),
    });

    assert.equal(await describe_([KNOWN], null), '');
  });

  it('names an internal squad the panel has forgotten', async () => {
    const describe_ = build({
      getInternalSquadOptions: async () => ok([KNOWN]),
      getExternalSquadOptions: async () => ok([]),
    });

    const hint = await describe_([KNOWN, GONE], null);

    assert.match(hint, /does not know/i);
    assert.ok(hint.includes(GONE), 'the uuid the operator has to fix is not in the message');
    assert.ok(!hint.includes(KNOWN), 'a squad that exists was accused too');
  });

  it('names a forgotten EXTERNAL squad as well', async () => {
    // The external squad rides the same PATCH and produces the same A039 —
    // verified against the live panel — so it must be covered by the same hint.
    const describe_ = build({
      getInternalSquadOptions: async () => ok([]),
      getExternalSquadOptions: async () => ok([]),
    });

    const hint = await describe_([], GONE);

    assert.ok(hint.includes(GONE));
  });

  it('reports "could not ask" as itself rather than accusing a squad', async () => {
    // Accusing a squad that exists sends an operator hunting through Remnawave
    // for a problem that is not there. "We could not ask" is its own answer.
    const describe_ = build({
      getInternalSquadOptions: async () => ({ kind: 'network' as const }),
      getExternalSquadOptions: async () => ok([]),
    });

    const hint = await describe_([GONE], null);

    assert.match(hint, /could not check/i);
    assert.ok(!hint.includes('does not know'), 'an unreachable panel was read as a verdict');
  });

  it('does not call the panel at all when no squads were sent', async () => {
    // The failure path must not add a panel round trip to updates that cannot
    // possibly have failed this way.
    let calls = 0;
    const describe_ = build({
      getInternalSquadOptions: async () => {
        calls += 1;
        return ok([]);
      },
      getExternalSquadOptions: async () => ok([]),
    });

    assert.equal(await describe_([], null), '');
    assert.equal(calls, 0);
  });

  it('stays quiet when the infra client is absent', async () => {
    const describe_ = build(undefined);
    assert.equal(await describe_([GONE], null), '');
  });

  it('never throws out of the failure path', async () => {
    // A diagnostic that throws would replace a useful panel error with a
    // useless one of ours, and it runs while something is already wrong.
    const describe_ = build({
      getInternalSquadOptions: async () => {
        throw new Error('boom');
      },
      getExternalSquadOptions: async () => ok([]),
    });

    assert.equal(await describe_([GONE], null), '');
  });
});
