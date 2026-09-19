/**
 * The `reiwa_id` ownership marker in a Remnawave profile description — the one
 * place that writes it and the one place that reads it.
 *
 * `RemnawaveProfileNamingService` writes the description one field per line —
 * `name`, `login`, `username`, then `reiwa_id: <user id>` — and four places
 * decide whose a profile is from that last line: the CREATE path
 * (`ProfileSyncProcessor.findOwnPanelProfile`), the panel-link reconciliation
 * and the duplicate-subscription merge (both through
 * `assertPanelProfileOwnership`), and the Remnawave importer. The display name
 * on the first line is the customer's own text — a Telegram first name can be
 * `reiwa_id: <somebody>` — so both ends are defended here:
 *
 *  • the WRITER never lets a value it interpolates end a line: every line
 *    break any reader, editor or UI treats as one is folded into a space;
 *  • the READER takes an owner only from a line that IS the marker, and only
 *    when every such line names the same owner.
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
