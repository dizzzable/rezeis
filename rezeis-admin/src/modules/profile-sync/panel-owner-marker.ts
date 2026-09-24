/**
 * The two marker lines in a Remnawave profile description — `reiwa_id` (whose
 * the profile is) and `subscription_id` (which of their subscriptions it was
 * provisioned for) — the one place that writes them and the one place that
 * reads them.
 *
 * `RemnawaveProfileNamingService` writes the description one field per line —
 * `name`, `login`, `username`, then `reiwa_id: <user id>` and
 * `subscription_id: <subscription id>` — and four places decide whose a
 * profile is from the `reiwa_id` line: the CREATE path
 * (`ProfileSyncProcessor.findOwnPanelProfile`), the automatic panel-link check
 * and the duplicate-subscription merge (both through
 * `assertPanelProfileOwnership`), and the Remnawave importer. The display name
 * on the first line is the customer's own text — a Telegram first name can be
 * `reiwa_id: <somebody>` — so both ends are defended here:
 *
 *  • the WRITER never lets a value it interpolates end a line: every line
 *    break any reader, editor or UI treats as one is folded into a space;
 *  • the READER takes a value only from a line that IS the marker, and only
 *    when every such line names the same one.
 *
 * THE `subscription_id` LINE NARROWS, IT NEVER PROVES. Ownership is still the
 * `reiwa_id` line's alone; the second line only stops an AUTOMATIC link from
 * handing a customer's profile to the wrong one of their subscriptions. A
 * profile with no such line — every profile made before 0.9.7.70 until its
 * next ordinary sync rewrites the description — links as before. Remnawave
 * declares `description` as a plain string with no length limit on 3.2.1 to
 * 3.4.4 (the `CreateUserCommand`/`UpdateUserCommand` contracts and the
 * OpenAPI documents in `rezeis/icon/`), so the extra line costs one row of text
 * and nothing is cut.
 */

/**
 * Every character that ends a line somewhere — Unicode's mandatory breaks: LF,
 * CR, VT, FF, NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR. A run of them folds
 * into one space.
 */
const LINE_BREAKS = /[\n\r\v\f\x85\p{Zl}\p{Zp}]+/gu;

/** A value interpolated into the description, kept on ONE line. */
export function descriptionFieldValue(value: string): string {
  return value.replace(LINE_BREAKS, ' ');
}

/** The marker line naming `userId` as the profile's owner. */
export function ownerMarkerLine(userId: string): string {
  return `reiwa_id: ${descriptionFieldValue(userId)}`;
}

/**
 * A line that IS the marker. Anchored to the whole trimmed line on purpose:
 * `name: reiwa_id: <someone>` is a display name, not a marker. The capture is
 * wider than a cuid (`-`, `_`) because it is compared for EQUALITY: an id
 * captured short would read as a different owner.
 */
const OWNER_MARKER_LINE = /^reiwa_id:[ \t]*([A-Za-z0-9_-]+)$/;

/** Every owner the description's marker lines name, in order, repeats included. */
export function readProfileOwnerMarkers(description: unknown): string[] {
  if (typeof description !== 'string') return [];
  const owners: string[] = [];
  for (const line of description.split('\n')) {
    const match = OWNER_MARKER_LINE.exec(line.trim());
    if (match !== null) owners.push(match[1]);
  }
  return owners;
}

/**
 * The owner a profile description PROVES, or `null`.
 *
 * Every marker line has to name the same id. No marker line proves nothing,
 * and neither do two lines naming different owners.
 */
export function readProfileOwnerMarker(description: unknown): string | null {
  const owners = new Set(readProfileOwnerMarkers(description));
  if (owners.size !== 1) return null;
  const [owner] = owners;
  return owner;
}

/** The line naming the subscription the profile was provisioned for. */
export function subscriptionMarkerLine(subscriptionId: string): string {
  return `subscription_id: ${descriptionFieldValue(subscriptionId)}`;
}

/** A line that IS the subscription marker, anchored like {@link OWNER_MARKER_LINE}. */
const SUBSCRIPTION_MARKER_LINE = /^subscription_id:[ \t]*([A-Za-z0-9_-]+)$/;

/** Every subscription the description's `subscription_id` lines name, in order. */
export function readProfileSubscriptionMarkers(description: unknown): string[] {
  if (typeof description !== 'string') return [];
  const subscriptions: string[] = [];
  for (const line of description.split('\n')) {
    const match = SUBSCRIPTION_MARKER_LINE.exec(line.trim());
    if (match !== null) subscriptions.push(match[1]);
  }
  return subscriptions;
}

/**
 * Whether the description's `subscription_id` lines let an AUTOMATIC link give
 * this profile to `subscriptionId`.
 *
 * No such line allows it: the profile predates the line, and ownership is the
 * `reiwa_id` line's question. Every line naming this subscription allows it.
 * A line naming any other subscription refuses — lines that disagree with each
 * other included, because one of them is then somebody else's.
 */
export function subscriptionMarkerAllows(description: unknown, subscriptionId: string): boolean {
  return readProfileSubscriptionMarkers(description).every((named) => named === subscriptionId);
}
