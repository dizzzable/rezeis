// CommonJS interop, as `update-checker.service.ts` reads it: `package.json`
// lives outside the TS source root. Same depth from `src/` and from `dist/`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PACKAGE_JSON: { readonly version?: string } = require('../../../package.json');

/** This panel's release, as the cabinet and the operator are told it. */
export const PANEL_VERSION: string = (PACKAGE_JSON.version ?? '0.0.0').trim();

/**
 * The capabilities THIS PANEL announces to the cabinet — the reverse carrier
 * (pair reliability, 26.09.2026). Same rules as the cabinet's ids
 * (`cabinet-capabilities.ts`): `panel.<kebab-name>[.v2…]`, one meaning for
 * ever, and one id in both repositories within the same pair of releases.
 *
 * The carrier shipped EMPTY (0.9.7.71), because a signal has to exist on the
 * older side before anybody can use it: without this block a panel that lacks a
 * capability cannot be told apart from one that simply does not announce any,
 * which is exactly why the cabinet side of the pair needs implied sets. The
 * first feature a cabinet must not use against an older panel is below, and the
 * cabinet hides it until it reads the id (reiwa `panelCan`).
 */
export const PANEL_CAPABILITY = {
  /**
   * `POST /api/internal/web-auth/password-reset/subscription` takes a login
   * alone: the `link` field is optional and ignored, and no subscription is
   * read. A cabinet that reads this id shows the login-only recovery screen and
   * sends no link; one that does not keeps the screen that asks for the link,
   * which an older panel requires.
   */
  loginRecovery: 'panel.login-recovery',
} as const;

export const PANEL_CAPABILITIES: readonly string[] = Object.values(PANEL_CAPABILITY);

/** The `panel` block of the settings-poll answer (`InternalConfigVersionsController`). */
export interface PanelAnnouncement {
  readonly version: string;
  readonly capabilities: readonly string[];
}

export function panelAnnouncement(): PanelAnnouncement {
  return { version: PANEL_VERSION, capabilities: [...PANEL_CAPABILITIES] };
}
