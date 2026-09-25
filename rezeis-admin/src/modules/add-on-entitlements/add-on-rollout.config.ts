import { Logger } from '@nestjs/common';

import { ResetCapabilityMap, ResetStrategy } from './domain/reset-cycle-policy';

/**
 * The durable add-on entitlement model, stage by stage, and the three PANEL
 * SWITCHES that now decide it.
 *
 * THE SWITCHES LIVE IN THE PANEL — «Доп. услуги» → «Настройки» — since the
 * owner's decision of 24.09.2026 («при поломке проще выключить в панели»).
 * They are stored in the settings row (`Settings.addOnSettings`), written only
 * through `settings-row-write.util.ts`, and read by BOTH processes through
 * `SettingsService`'s row cache (`AddOnSwitchesService`): the API sees a
 * change at once, the worker within that cache's five seconds, and nobody
 * restarts anything. Until this release they were deployment-time variables,
 * because "the web and worker processes must change together" and a `.env`
 * line plus `docker compose up -d` was the only way to get that; the shared
 * row read through a five-second cache is now that way.
 *
 * AN EXPLICIT `.env` VALUE STILL WINS, in both directions. The 0.9.7.69 notes
 * told operators to write `ADDON_*` lines to switch stages off, and an install
 * that did keeps exactly what it wrote: the panel shows such a switch as
 * «Задано в .env», names the variable, and refuses to change it.
 *
 * Stages, and the switch that carries each one:
 *  1. `entitlementShadow` — subscriptions ENTER the term model (the ┐ «Новый учёт
 *                           background cutover and the renewal and  │  докупок»
 *                           upgrade term producers);                │
 *  2. `directPurchase`    — new add-on purchases are ledgered;      ┘
 *  4. `resetExpiry.<strategy>` — add-ons «до следующего сброса»;      «Докупка трафика до сброса»
 *  6. `deviceCleanupAuto` — automatic HWID reduction.                 «Удалять лишние устройства
 *                                                                      автоматически»
 * Stages 3 (the versioned projection sync) and 5 (add-ons sold with a
 * renewal) were deleted with their code on 24.09.2026. Neither was ever on
 * by default.
 *
 * WHAT A FLAG DOES NOT DECIDE. Once a subscription has a term, how that term
 * is rotated, aligned and expired follows the term row, never a flag: the
 * boundary sweep, the cutover's `ensureTermInTransaction`, the plan-change
 * rotation and the tail alignment read no flag at all. Turning stage 1 off
 * therefore stops NEW entrants; it does not strand the ones already in.
 */
export interface AddOnRolloutFlags {
  readonly entitlementShadow: boolean;
  readonly directPurchase: boolean;
  readonly deviceCleanupAuto: boolean;
  readonly resetExpiry: Readonly<Record<Exclude<ResetStrategy, 'NO_RESET'>, boolean>>;
  /**
   * «Часовой пояс Remnawave»: the zone Remnawave's scheduler resets traffic
   * in (`reset-cycle-policy.ts`); absent means UTC, its shipped default. It
   * travels in this snapshot so that an operation that read the flags once,
   * before its transaction, has the zone from the same read (review R2b-07).
   */
  readonly remnawaveTimeZone?: string;
}

/** The panel's switches, by the key the settings row stores each one under. */
export type AddOnSwitchName = 'durableAccounting' | 'deviceCleanupAuto' | 'trafficResetExpiry';

/** In the order the page draws them. */
export const ADD_ON_SWITCH_NAMES: readonly AddOnSwitchName[] = [
  'durableAccounting',
  'deviceCleanupAuto',
  'trafficResetExpiry',
];

/** Every `.env` variable that can still decide a stage over the panel. */
export type AddOnRolloutFlagName =
  | 'ADDON_ENTITLEMENT_SHADOW'
  | 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'
  | 'ADDON_DEVICE_CLEANUP_AUTO'
  | 'ADDON_RESET_EXPIRY_DAY'
  | 'ADDON_RESET_EXPIRY_WEEK'
  | 'ADDON_RESET_EXPIRY_MONTH'
  | 'ADDON_RESET_EXPIRY_MONTH_ROLLING';

/**
 * THE DEFAULTS, IN ONE PLACE: what a switch is while nobody has set it — in
 * the panel or in `.env`.
 *
 *  - «Новый учёт докупок» and «Удалять лишние устройства автоматически» are
 *    ON: the owner's decision of 24.09.2026, shipped once renewals, upgrades
 *    and plan changes gated on the term row, payments brought subscriptions in
 *    lazily, and the background cutover existed (`EntitlementCutoverJobService`).
 *  - «Докупка трафика до сброса» is ON since 25.09.2026, once the panel's
 *    reset instants (`reset-cycle-policy.ts`) predicted every reset a live
 *    Remnawave 3.2.3, 3.3.2 and 3.4.4 made (`reset-schedule-lab-parity.spec.ts`).
 *    Add-ons sold before keep their dates; an `ADDON_RESET_EXPIRY_*=false` in
 *    `.env` still keeps the stage off.
 *
 * A stored value is only ever the operator's own choice: the row keeps no key
 * for a switch nobody touched, so a later change of THIS table reaches every
 * install that left the switch alone.
 */
export const ADD_ON_SWITCH_DEFAULTS: Readonly<Record<AddOnSwitchName, boolean>> = {
  durableAccounting: true,
  deviceCleanupAuto: true,
  trafficResetExpiry: true,
};

/**
 * Which variables stand for which switch. Each variable belongs to exactly one
 * switch; the stages they name are resolved one variable at a time, so a line
 * that sets only `ADDON_ENTITLEMENT_SHADOW` decides stage 1 and leaves stage 2
 * to the switch — which the panel then shows as «Задано в .env» all the same.
 */
export const ADD_ON_SWITCH_VARIABLES: Readonly<Record<AddOnSwitchName, readonly AddOnRolloutFlagName[]>> = {
  durableAccounting: ['ADDON_ENTITLEMENT_SHADOW', 'ADDON_ENTITLEMENT_DIRECT_PURCHASE'],
  deviceCleanupAuto: ['ADDON_DEVICE_CLEANUP_AUTO'],
  trafficResetExpiry: [
    'ADDON_RESET_EXPIRY_DAY',
    'ADDON_RESET_EXPIRY_WEEK',
    'ADDON_RESET_EXPIRY_MONTH',
    'ADDON_RESET_EXPIRY_MONTH_ROLLING',
  ],
};

/** Every variable this module reads, switch by switch. */
export const ADD_ON_ROLLOUT_FLAG_NAMES: readonly AddOnRolloutFlagName[] = ADD_ON_SWITCH_NAMES.flatMap(
  (name) => ADD_ON_SWITCH_VARIABLES[name],
);

/**
 * What the settings row holds: the operator's own values only. An absent key
 * means "never set", which is the default in {@link ADD_ON_SWITCH_DEFAULTS}.
 */
export type StoredAddOnSwitches = Readonly<Partial<Record<AddOnSwitchName, boolean>>>;

/**
 * The stored switches out of the `addOnSettings` column. Only a real boolean
 * counts: the writer stores nothing else, and anything that is not one is
 * treated as never set rather than guessed at.
 */
export function readStoredAddOnSwitches(raw: unknown): StoredAddOnSwitches {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const stored: Partial<Record<AddOnSwitchName, boolean>> = {};
  for (const name of ADD_ON_SWITCH_NAMES) {
    const value = record[name];
    if (typeof value === 'boolean') stored[name] = value;
  }
  return stored;
}

/**
 * «Часовой пояс Remnawave» out of the same `addOnSettings` column: the key
 * `remnawaveTimeZone`, an IANA name; anything else reads as unset (UTC). The
 * setting's own writer validates it; this reader only refuses to guess.
 */
export function readStoredRemnawaveTimeZone(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>)['remnawaveTimeZone'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const LOGGER = new Logger('AddOnRolloutFlags');

/** `name=value` pairs already warned about, so a per-call read warns once. */
const warnedUnknownValues = new Set<string>();

/** What an operator writes for ON, and for OFF — compared lower-cased and trimmed. */
const ON_SPELLINGS: ReadonlySet<string> = new Set(['true', '1', 'on', 'yes']);
const OFF_SPELLINGS: ReadonlySet<string> = new Set(['false', '0', 'off', 'no']);

/**
 * One variable as an override: `true` or `false` when `.env` decides the
 * stage, `null` when it leaves the stage to the panel switch.
 *
 * `true`, `1`, `on` or `yes` is ON and `false`, `0`, `off` or `no` is OFF,
 * case-insensitively and with surrounding whitespace ignored. Unset or empty
 * leaves it to the switch. Anything else leaves it to the switch too, with a
 * warning naming the variable — once per distinct value, because the flags are
 * read per call.
 *
 * THE OFF SPELLINGS ARE THE ONES THAT MATTER. With a default that is ON, an
 * explicit value was the only way an operator could turn a stage off, and the
 * old reader (`value === 'true' || value === '1'`) could not express that at
 * all. A `False`, an `off` or a `no` that silently kept a stage ON would be the
 * one rollback that does not roll back.
 */
export function readEnvOverride(value: string | undefined, name: string = 'ADDON_*'): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return null;
  if (ON_SPELLINGS.has(normalized)) return true;
  if (OFF_SPELLINGS.has(normalized)) return false;
  const key = `${name}=${value}`;
  if (!warnedUnknownValues.has(key)) {
    warnedUnknownValues.add(key);
    LOGGER.warn(
      `${name}="${value}" is not a recognised value (true, 1, on, yes; false, 0, off, no); ` +
        'the switch on the panel\'s «Доп. услуги» page decides instead',
    );
  }
  return null;
}

/** The switch a variable belongs to. */
const SWITCH_OF: Readonly<Record<AddOnRolloutFlagName, AddOnSwitchName>> = Object.fromEntries(
  ADD_ON_SWITCH_NAMES.flatMap((name) => ADD_ON_SWITCH_VARIABLES[name].map((variable) => [variable, name])),
) as Record<AddOnRolloutFlagName, AddOnSwitchName>;

/** One variable, resolved: its explicit `.env` value, else its switch, else the default. */
function resolveVariable(
  variable: AddOnRolloutFlagName,
  stored: StoredAddOnSwitches,
  env: NodeJS.ProcessEnv,
): boolean {
  const switchName = SWITCH_OF[variable];
  return readEnvOverride(env[variable], variable) ?? stored[switchName] ?? ADD_ON_SWITCH_DEFAULTS[switchName];
}

/**
 * The stages as the code runs them: `.env` over the stored switch over the
 * default, one variable at a time. Pure — the caller reads the row
 * (`AddOnSwitchesService.flags`); an empty `stored` is what an install that
 * never touched a switch has, and what a service built by hand in a spec gets.
 */
export function resolveAddOnRolloutFlags(
  stored: StoredAddOnSwitches = {},
  env: NodeJS.ProcessEnv = process.env,
  extras: { readonly remnawaveTimeZone?: string | null } = {},
): AddOnRolloutFlags {
  const flag = (variable: AddOnRolloutFlagName): boolean => resolveVariable(variable, stored, env);
  const zone = typeof extras.remnawaveTimeZone === 'string' ? extras.remnawaveTimeZone.trim() : '';
  return {
    entitlementShadow: flag('ADDON_ENTITLEMENT_SHADOW'),
    directPurchase: flag('ADDON_ENTITLEMENT_DIRECT_PURCHASE'),
    deviceCleanupAuto: flag('ADDON_DEVICE_CLEANUP_AUTO'),
    resetExpiry: {
      DAY: flag('ADDON_RESET_EXPIRY_DAY'),
      WEEK: flag('ADDON_RESET_EXPIRY_WEEK'),
      MONTH: flag('ADDON_RESET_EXPIRY_MONTH'),
      MONTH_ROLLING: flag('ADDON_RESET_EXPIRY_MONTH_ROLLING'),
    },
    ...(zone === '' ? {} : { remnawaveTimeZone: zone }),
  };
}

/** Whatever answers "what are the flags right now" — `AddOnSwitchesService` in the running panel. */
export interface AddOnRolloutFlagReader {
  flags(): Promise<AddOnRolloutFlags>;
}

/**
 * The flags as they stand now, through `reader`. A service built by hand
 * without one — the unit specs construct them positionally — gets `.env` and
 * the defaults alone, which is what every such spec has always run with.
 * The running panel never takes that branch: every module that declares a
 * reader of the flags imports `AddOnSwitchesModule`, and
 * `test/add-on-switches-module-wiring.spec.ts` holds it to that.
 */
export function readAddOnRolloutFlags(reader: AddOnRolloutFlagReader | undefined): Promise<AddOnRolloutFlags> {
  return reader === undefined ? Promise.resolve(resolveAddOnRolloutFlags()) : reader.flags();
}

/** One switch as the page shows it. */
export interface AddOnSwitchState {
  readonly name: AddOnSwitchName;
  /** ON for every stage it carries: what the code runs with right now. */
  readonly enabled: boolean;
  readonly defaultEnabled: boolean;
  /** The operator's own value, or `null` while the switch was never set. */
  readonly stored: boolean | null;
  /**
   * The explicit `.env` values that decide it instead of the panel. While any
   * exists the switch cannot be changed from the panel.
   */
  readonly env: ReadonlyArray<{ readonly variable: AddOnRolloutFlagName; readonly enabled: boolean }>;
}

export function describeAddOnSwitches(
  stored: StoredAddOnSwitches,
  env: NodeJS.ProcessEnv = process.env,
): readonly AddOnSwitchState[] {
  return ADD_ON_SWITCH_NAMES.map((name) => {
    const variables = ADD_ON_SWITCH_VARIABLES[name];
    const overrides: Array<{ readonly variable: AddOnRolloutFlagName; readonly enabled: boolean }> = [];
    for (const variable of variables) {
      const value = readEnvOverride(env[variable], variable);
      if (value !== null) overrides.push({ variable, enabled: value });
    }
    return {
      name,
      enabled: variables.every((variable) => resolveVariable(variable, stored, env)),
      defaultEnabled: ADD_ON_SWITCH_DEFAULTS[name],
      stored: stored[name] ?? null,
      env: overrides,
    };
  });
}

/** A change the operator asked for: only the switches named. */
export type AddOnSwitchChanges = Partial<Record<AddOnSwitchName, boolean>>;

export type AddOnSwitchUpdatePlan =
  | {
      readonly kind: 'WRITE';
      readonly next: StoredAddOnSwitches;
      /** The switches whose value actually moves. */
      readonly changed: readonly AddOnSwitchName[];
    }
  | {
      readonly kind: 'SET_IN_ENV';
      readonly switchName: AddOnSwitchName;
      readonly variables: readonly AddOnRolloutFlagName[];
    }
  | { readonly kind: 'OFF_NOT_CONFIRMED'; readonly switchName: AddOnSwitchName };

/**
 * What a change does to the stored switches — decided against the row as it
 * stands UNDER THE LOCK, so two operators saving at once cannot slip an
 * unconfirmed switch-off past each other.
 *
 *  - A switch `.env` decides is refused whole, naming its variables: storing a
 *    value the panel cannot apply would only surprise whoever later removes
 *    the line.
 *  - Turning a switch OFF needs `confirmOff`: the page asks first, in a dialog
 *    that says what switching off does NOT undo, and a client that skipped it
 *    is refused here rather than trusted.
 *  - Anything else is stored as given, the default's value included: it is
 *    the operator's choice from now on.
 */
export function planAddOnSwitchUpdate(input: {
  readonly stored: StoredAddOnSwitches;
  readonly changes: AddOnSwitchChanges;
  readonly confirmOff: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): AddOnSwitchUpdatePlan {
  const env = input.env ?? process.env;
  const next: Partial<Record<AddOnSwitchName, boolean>> = { ...input.stored };
  const changed: AddOnSwitchName[] = [];
  for (const name of ADD_ON_SWITCH_NAMES) {
    const requested = input.changes[name];
    if (requested === undefined) continue;
    const variables = ADD_ON_SWITCH_VARIABLES[name].filter(
      (variable) => readEnvOverride(env[variable], variable) !== null,
    );
    if (variables.length > 0) return { kind: 'SET_IN_ENV', switchName: name, variables };
    const current = input.stored[name] ?? ADD_ON_SWITCH_DEFAULTS[name];
    if (current && !requested && !input.confirmOff) return { kind: 'OFF_NOT_CONFIRMED', switchName: name };
    if (current !== requested) changed.push(name);
    next[name] = requested;
  }
  return { kind: 'WRITE', next, changed };
}

/**
 * The reset-cycle capability map a flags snapshot allows. A strategy is
 * `ENABLED` only when its stage-4 flag is on; everything else is DISABLED.
 * `NO_RESET` never has a boundary.
 *
 * ONE SNAPSHOT PER OPERATION. The stages are switches now, flipped while the
 * panel runs, so an operation that needs the flags twice resolves them ONCE and
 * derives everything it needs from that one value. Two reads could straddle a
 * flip and disagree with each other inside a single fulfilment.
 *
 * WHO READS THIS MAP. The split stated on {@link resolveIntakeResetCapabilities}
 * below — intake-gated map for the selling sides, flag-pure map for what was
 * already sold — is the whole story since 25.09.2026:
 *
 *   - `EntitlementBoundaryService` reads the MONTH_ROLLING capability to fetch
 *     and stamp the rolling anchor when a term activates. Flag-pure is the
 *     point there: closing direct purchase must not stop the anchoring of
 *     goods that were already sold.
 *   - The FULFILMENT no longer reads any map. It used to derive this one again
 *     at capture and mint the epoch from it, which held only while nothing
 *     moved between checkout and capture — and with stage 4 a panel switch,
 *     a flip in between turned a «до сброса» quote into the PERMANENT legacy
 *     increment. The checkout now writes its answer into the payment's marker
 *     (`domain/add-on-quote.ts`) and `applyAddOnViaLedger` binds to that,
 *     whatever the switches say by then.
 */
export function resolveResetCapabilities(flags: AddOnRolloutFlags): ResetCapabilityMap {
  const map: Partial<Record<ResetStrategy, 'ENABLED'>> = {};
  if (flags.resetExpiry.DAY) map.DAY = 'ENABLED';
  if (flags.resetExpiry.WEEK) map.WEEK = 'ENABLED';
  if (flags.resetExpiry.MONTH) map.MONTH = 'ENABLED';
  if (flags.resetExpiry.MONTH_ROLLING) map.MONTH_ROLLING = 'ENABLED';
  return map;
}

/**
 * The reset-cycle capability map as the money INTAKE may use it — the single
 * seam that decides whether a `UNTIL_NEXT_RESET` add-on may be SOLD.
 *
 * It is {@link resolveResetCapabilities} narrowed by ONE extra condition:
 * `directPurchase` must be on. That flag guards the intake
 * (`PaymentSubscriptionMutationService.applyAddOnViaLedger`) which is the only
 * code that binds a purchased entitlement to a reset epoch. With it off, a
 * «до конца подписки» add-on is the legacy increment, so nothing «до сброса»
 * is quoted at all; one quoted while it was on is still ledgered at capture.
 *
 * Both selling sides read THIS function and nothing else:
 *  - `AddOnEligibilityService.getResetCapabilities` (the offer), and
 *  - `AddOnPurchaseService.checkout` (the direct-purchase checkout).
 * They used to disagree by omission — the offer withheld, the checkout did not
 * ask — which is exactly how a crafted or stale checkout sold a temporary
 * top-up that was fulfilled permanently.
 *
 * Deliberately SEPARATE from {@link resolveResetCapabilities}: expiry and the
 * anchoring of prior goods must not depend on whether intake is open, so that
 * resolver stays flag-pure; fusing the two would strand paid entitlements the
 * day an operator closes direct purchase.
 */
export function resolveIntakeResetCapabilities(flags: AddOnRolloutFlags): ResetCapabilityMap {
  if (!flags.directPurchase) return {};
  return resolveResetCapabilities(flags);
}
