import { UpdateUserCommand } from '@remnawave/backend-contract';

/**
 * Asks the PANEL'S OWN schema whether it would accept a tag.
 *
 * The point is that it is not our regex. `plan-squad-propagation.spec.ts`
 * asserts against this before asserting the DTO's verdict, so a fixture that
 * stopped being a genuine violation — or a rule copied down wrong — fails the
 * test instead of quietly making it agree with itself.
 *
 * `UpdateUserCommand.RequestSchema` is the shipped contract for `PATCH
 * /api/users` on both versions this project targets. It also carries a
 * `uuid` field, so a valid one is supplied to isolate the tag's verdict.
 */
const CONTRACT_PROBE_UUID = '11111111-1111-4111-8111-111111111111';

export function isUpstreamTagForTest(tag: string): boolean {
  return UpdateUserCommand.RequestSchema.safeParse({ uuid: CONTRACT_PROBE_UUID, tag }).success;
}
