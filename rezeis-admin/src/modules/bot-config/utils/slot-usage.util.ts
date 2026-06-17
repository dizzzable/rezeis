/**
 * Slot usage map (pure, no DI)
 * ────────────────────────────
 * Tells the Bot Emoji Studio *where* each semantic emoji slot is rendered so
 * an operator understands what a given `{{KEY}}` actually affects. Two sources
 * are merged at read time:
 *   1. CODE_SLOT_USAGE — slots the bot references in code (mini-profile, trial
 *      button, status/traffic dots) that no text scan could discover.
 *   2. a dynamic scan of operator copy (`BotText` values, screen texts) for
 *      `{{KEY}}` placeholders — surfaces operator-authored usage.
 */

/** Static, code-driven slot → block labels (kept next to the render sites). */
export const CODE_SLOT_USAGE: Readonly<Record<string, readonly string[]>> = {
  SUB_PROFILE: ['welcome.mini-profile'],
  SUB_DEVICES: ['welcome.mini-profile'],
  SUB_TRAFFIC: ['welcome.mini-profile'],
  SUB_EXPIRY: ['welcome.mini-profile'],
  STATUS_ACTIVE: ['welcome.subscription-card'],
  STATUS_LIMITED: ['welcome.subscription-card'],
  STATUS_EXPIRED: ['welcome.subscription-card'],
  STATUS_DISABLED: ['welcome.subscription-card'],
  TRAFFIC_OK: ['welcome.traffic-bar'],
  TRAFFIC_WARN: ['welcome.traffic-bar'],
  TRAFFIC_FULL: ['welcome.traffic-bar'],
  TRIAL: ['menu.trial-button'],
};

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/** Extract the distinct `{{KEY}}` placeholder keys referenced in a string. */
export function scanPlaceholderKeys(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(text)) !== null) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/**
 * Build a `slotKey → labels[]` usage index by merging the static code map with
 * a scan of the supplied copy sources. Each source contributes a label
 * (e.g. `text:welcome`) to every slot key its content references.
 */
export function buildSlotUsage(
  sources: ReadonlyArray<{ readonly label: string; readonly text: string }>,
): Record<string, string[]> {
  const usage: Record<string, Set<string>> = {};
  const add = (key: string, label: string): void => {
    (usage[key] ??= new Set<string>()).add(label);
  };

  for (const [key, labels] of Object.entries(CODE_SLOT_USAGE)) {
    for (const label of labels) add(key, label);
  }
  for (const source of sources) {
    for (const key of scanPlaceholderKeys(source.text)) add(key, source.label);
  }

  const out: Record<string, string[]> = {};
  for (const [key, labels] of Object.entries(usage)) {
    out[key] = [...labels].sort();
  }
  return out;
}
