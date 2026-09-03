/**
 * connect-page-api
 * ────────────────
 * The editor's view of the connect-screen catalog.
 *
 * The API validates this exhaustively on the way in — schema, icon sanitizer,
 * and an audit for catalogs that parse but cannot be used. The schema here is
 * shaped for the FORM, not for correctness: it accepts half-written rows,
 * because an operator adding a platform has an empty platform for a moment and
 * an editor that refuses to hold one is an editor that cannot be typed into.
 *
 * Correctness is the server's answer, and the editor asks for it (`validate`)
 * rather than re-deriving it. Two validators for one config drift, and the one
 * in the browser is the one that would quietly become the more permissive.
 */
import { z } from 'zod';

import { api } from '@/lib/api';

export const PLATFORM_IDS = [
  'ios',
  'android',
  'windows',
  'macos',
  'linux',
  'androidtv',
  'appletv',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const BUTTON_KINDS = ['external', 'deepLink', 'copyLink'] as const;
export type ButtonKind = (typeof BUTTON_KINDS)[number];

/** The token an operator writes where the customer's own link belongs. */
export const SUBSCRIPTION_LINK_TOKEN = '{{SUBSCRIPTION_LINK}}';

const localizedText = z.record(z.string(), z.string());
export type LocalizedText = z.infer<typeof localizedText>;

const buttonSchema = z
  .object({
    kind: z.string(),
    label: localizedText,
    url: z.string().optional(),
    template: z.string().optional(),
    /** Derived by the server; shown, never edited. */
    encode: z.string().optional(),
  })
  .passthrough();
export type ConnectButton = z.infer<typeof buttonSchema>;

const stepSchema = z
  .object({
    title: localizedText,
    body: localizedText.nullable().optional(),
    iconKey: z.string().nullable().optional(),
    buttons: z.array(buttonSchema),
  })
  .passthrough();
export type ConnectStep = z.infer<typeof stepSchema>;

const appSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    iconKey: z.string().nullable().optional(),
    featured: z.boolean(),
    steps: z.array(stepSchema),
  })
  .passthrough();
export type ConnectApp = z.infer<typeof appSchema>;

const platformSchema = z
  .object({
    id: z.string(),
    title: localizedText,
    iconKey: z.string().nullable().optional(),
    apps: z.array(appSchema),
  })
  .passthrough();
export type ConnectPlatform = z.infer<typeof platformSchema>;

export const connectPageConfigSchema = z
  .object({
    // Not `z.literal(2)`: a version this editor has not met should not turn the
    // whole page into a permanent skeleton.
    version: z.number(),
    connectScreenEnabled: z.boolean().optional(),
    icons: z.record(z.string(), z.string()),
    platforms: z.array(platformSchema),
  })
  .passthrough();
export type ConnectPageConfig = z.infer<typeof connectPageConfigSchema>;

export interface ConnectPageIssue {
  readonly path: string;
  readonly message: string;
}

const issueSchema = z.object({ path: z.string(), message: z.string() });

export const CONNECT_PAGE_KEYS = { all: ['admin', 'connect-page'] as const } as const;

export const connectPageApi = {
  async get(): Promise<{ config: ConnectPageConfig; stored: boolean; corrupted: string | null }> {
    const response = await api.get('/admin/connect-page');
    return z
      .object({
        config: connectPageConfigSchema,
        stored: z.boolean(),
        // Present but unreadable is NOT the same as never saved: both hand back
        // the built-in default, and editing what looks like your catalog and
        // pressing Save destroys the real one.
        corrupted: z.string().nullable().catch(null),
      })
      .parse(response.data);
  },

  async validate(config: ConnectPageConfig): Promise<{ ok: boolean; issues: ConnectPageIssue[] }> {
    const response = await api.post('/admin/connect-page/validate', { config });
    return z
      .object({ ok: z.boolean(), issues: z.array(issueSchema) })
      .parse(response.data);
  },

  async replace(config: ConnectPageConfig): Promise<{
    config: ConnectPageConfig;
    cleanedIcons: Record<string, string[]>;
  }> {
    const response = await api.put('/admin/connect-page', { config });
    return z
      .object({
        config: connectPageConfigSchema,
        cleanedIcons: z.record(z.string(), z.array(z.string())),
      })
      .parse(response.data);
  },
};

/**
 * Pull the issue list out of whatever the API refused with.
 *
 * A save that fails validation is a 400 carrying the same `{path, message}`
 * rows `validate` returns, and showing them beside the fields is the whole
 * point of returning them — a toast that says "invalid" sends the operator
 * hunting through forty rows.
 */
export function issuesFromError(error: unknown): ConnectPageIssue[] {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (typeof data !== 'object' || data === null) return [];
  const parsed = z
    .object({ issues: z.array(issueSchema).optional() })
    .safeParse(data);
  return parsed.success ? (parsed.data.issues ?? []) : [];
}

// ── Draft helpers ────────────────────────────────────────────────────────────
//
// Everything below edits a draft immutably. Written as small functions rather
// than inline spreads because the nesting is four deep and an inline spread at
// that depth is where an editor quietly starts mutating the query cache.

export function moveItem<T>(items: readonly T[], from: number, delta: number): T[] {
  const to = from + delta;
  if (to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  return items.map((item, i) => (i === index ? value : item));
}

export function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

/** A slug that is stable, lowercase, and unique among its siblings. */
export function slugify(value: string, taken: readonly string[]): string {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'app';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Apply an edit to one app and keep "exactly one recommended" true.
 *
 * The audit refuses a platform that recommends two apps, and the screen has to
 * open on one of them — so ticking a second has to untick the first. Doing it
 * here rather than leaving it to the operator means they never have to go and
 * find which app was previously recommended in order to change their mind.
 */
export function setAppAt(
  apps: readonly ConnectApp[],
  index: number,
  next: ConnectApp,
): ConnectApp[] {
  return apps.map((app, i) => {
    if (i === index) return next;
    return next.featured ? { ...app, featured: false } : app;
  });
}

export const emptyButton = (kind: ButtonKind): ConnectButton => ({
  kind,
  label: { ru: '', en: '' },
  ...(kind === 'external' ? { url: '' } : {}),
  ...(kind === 'deepLink' ? { template: `://add/${SUBSCRIPTION_LINK_TOKEN}` } : {}),
});

export const emptyStep = (): ConnectStep => ({
  title: { ru: '', en: '' },
  // `null`, not an empty pair. A description is optional, but an empty object
  // is a PRESENT value that fails "at least one language must carry text" — so
  // every newly added step was unsaveable until something was typed into a
  // field the operator had no reason to fill.
  body: null,
  iconKey: null,
  buttons: [],
});

export const emptyApp = (taken: readonly string[]): ConnectApp => ({
  id: slugify('app', taken),
  name: '',
  iconKey: null,
  featured: false,
  steps: [emptyStep()],
});
