import * as contractPanel321 from '@remnawave/contract-panel-3.2.1';
import * as contractPanel323 from '@remnawave/contract-panel-3.2.3';
import * as contractPanel33 from '@remnawave/contract-panel-3.3';
import * as contractPanel343 from '@remnawave/contract-panel-3.4.3';
import * as contractPanel344 from '@remnawave/contract-panel-3.4.4';

/**
 * Asks the PANEL'S OWN schemas whether they would accept a tag.
 *
 * The point is that it is not our regex. `plan-squad-propagation.spec.ts`
 * asserts against this before asserting the DTO's verdict, so a fixture that
 * stopped being a genuine violation — or a rule copied down wrong — fails the
 * test instead of quietly making it agree with itself.
 *
 * EVERY RELEASE THE FLEET RUNS is asked, each through the contract that release
 * ships (per https://docs.rw/sdk/typescript-sdk/), and they must agree: the rule
 * the DTO restates is only one rule while they do. A release that changes it
 * throws here with the verdicts side by side, which is the finding.
 *
 * `PATCH /api/users` names its profile by a numeric `id` under every 3.x
 * `RequestBodySchema`, so a valid one is supplied to isolate the tag's verdict.
 */
interface TagProbe {
  readonly panel: string;
  safeParse(tag: string): boolean;
}

interface Schema {
  safeParse(value: unknown): { success: boolean };
}

function threeX(panel: string, contract: unknown): TagProbe {
  const schema = (contract as { UpdateUserCommand: { RequestBodySchema: Schema } }).UpdateUserCommand
    .RequestBodySchema;
  return { panel, safeParse: (tag) => schema.safeParse({ id: 1, tag }).success };
}

const PROBES: readonly TagProbe[] = [
  threeX('3.2.0–3.2.1', contractPanel321),
  threeX('3.2.3', contractPanel323),
  threeX('3.3.x', contractPanel33),
  threeX('3.4.0–3.4.3', contractPanel343),
  threeX('3.4.4', contractPanel344),
];

export function isUpstreamTagForTest(tag: string): boolean {
  const verdicts = PROBES.map((probe) => ({ panel: probe.panel, accepted: probe.safeParse(tag) }));
  const accepted = verdicts.filter((verdict) => verdict.accepted).length;
  if (accepted !== 0 && accepted !== verdicts.length) {
    throw new Error(
      `the panel releases disagree about tag ${JSON.stringify(tag)}: ${JSON.stringify(verdicts)}`,
    );
  }
  return accepted === verdicts.length;
}
