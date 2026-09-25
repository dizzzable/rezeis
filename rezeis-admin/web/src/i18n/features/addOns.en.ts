/**
 * Lazy-loaded i18n feature bundle (en): addOns
 *
 * Contains namespaces: addOnSwitches, addOnLifetimeRule.
 *
 * The words of the «Settings» tab on the Add-ons page: the switches of the
 * add-on accounting. A lazy bundle rather than `en.ts`/`ru.ts`: the core
 * dictionary loads before the first paint and `check:build-graph` measures
 * it, while these strings are needed on this one page.
 */

export const en = {
  addOnSwitches: {
    tab: 'Settings',
    title: 'Add-on accounting',
    subtitle:
      'How the add-ons customers buy behave. A change applies within a few seconds; the panel needs no restart.',
    loadFailed: 'Could not load the add-on accounting settings.',
    retry: 'Retry',
    saved: 'Saved',
    saveFailed: 'Could not save',
    defaultOn: 'On by default',
    defaultOff: 'Off by default',
    setInEnv: 'Set in .env: {{variables}}',
    setInEnvHint:
      'Not changeable here: a line in the panel’s .env file decides it. To manage the switch from here, delete that line and run docker compose up -d.',
    // What happens once the line is deleted: the panel takes the value saved in
    // it, or the default when none was saved.
    setInEnvAfterStored:
      'If you delete the line from .env, after the restart the value saved in the panel applies: “{{value}}”.',
    setInEnvAfterDefault:
      'If you delete the line from .env, after the restart the panel’s value applies — by default “{{value}}”.',
    setInEnvKeepOff: 'To keep it off, do not delete the line.',
    valueOn: 'on',
    valueOff: 'off',
    noPermission: 'Only a role with Add-ons → Edit can change these switches.',
    errors: {
      setInEnv: 'This switch is set in the panel’s .env and cannot be changed here.',
      offNotConfirmed: 'Switching off has to be confirmed.',
    },
    switches: {
      durableAccounting: {
        label: 'New add-on accounting',
        description:
          'An add-on bought in the cabinet gets an end date — the end of the subscription — instead of raising the limit for good. Subscriptions move into the new accounting in the background.',
      },
      deviceCleanupAuto: {
        label: 'Remove extra devices automatically',
        description:
          'When a device add-on ends, the devices over the new limit are removed by themselves, newest first. Off: the reduction waits for approval on the Delivery tab.',
      },
      trafficResetExpiry: {
        label: 'Traffic add-ons until the reset',
        description:
          'On a plan with a traffic reset, a traffic add-on lasts until Remnawave’s nearest traffic reset and is removed 30 minutes after it; if the subscription ends first, until the subscription ends. On a plan without a reset, until the subscription ends.',
        caution:
          'Reset times follow the “Remnawave time zone” below: it must match the TZ line of the Remnawave server, or add-ons are removed at the wrong hour.',
      },
    },
    confirmOff: {
      title: 'Switch off “{{label}}”?',
      doesTitle: 'What changes:',
      keepsTitle: 'What switching off does NOT undo:',
      cancel: 'Cancel',
      confirm: 'Switch off',
      durableAccounting: {
        does:
          'Subscriptions no longer move into the new accounting, and new add-ons raise the limit for good again, with no end date.',
        keep1: 'Subscriptions already in the new accounting stay in it.',
        keep2: 'Add-ons already sold end on their dates.',
        keep3: 'The panel still owns those subscriptions’ limits: a limit changed directly in Remnawave is put back.',
      },
      deviceCleanupAuto: {
        does: 'Device reductions will wait for approval on the Delivery tab.',
        keep1: 'Devices already removed do not come back.',
        keep2: 'Device add-ons already sold end on their dates, and new devices over the limit do not connect.',
      },
      trafficResetExpiry: {
        does: 'New traffic add-ons are sold until the subscription ends instead of until the reset.',
        keep1: 'Add-ons already sold “until the reset” end at their reset.',
      },
    },
    // «Remnawave time zone» — the field under the switches and the daily
    // reset check's warning beside it.
    remnawaveTimeZone: {
      label: 'Remnawave time zone',
      hint:
        'The zone whose clock the Remnawave server resets traffic by: the TZ line in the Remnawave server’s .env file, or UTC when there is none. It sets the time of every reset: when “until the reset” add-ons are removed and what reset time the customer sees. The day of a “Monthly (by creation date)” reset does not depend on it — Remnawave’s database decides that, always in UTC (the database’s own zone must not be changed).',
      placeholder: 'UTC',
      defaultValue: 'Not set — UTC',
      save: 'Save',
      saved: 'Remnawave time zone saved',
      invalid: 'There is no such time zone. Enter its name, for example Europe/Moscow or UTC.',
      mismatchTitle: 'Remnawave’s resets do not match this zone',
      mismatchLine:
        'The “{{strategy}}” reset ran at {{observed}}, while this zone expects it at {{expected}}. Remnawave seems to run in {{offset}}.',
      mismatchHint: 'Check the TZ line in the Remnawave server’s .env and enter the same zone here.',
      strategies: {
        DAY: 'Every day',
        WEEK: 'Every week',
        MONTH: 'Monthly (calendar, on the 1st)',
        MONTH_ROLLING: 'Monthly (by creation date)',
      },
    },
  },
  // The «Lifetime» line of the add-on dialog: the panel decides it, the
  // operator no longer chooses (the owner's decision of 24.09.2026).
  addOnLifetimeRule: {
    traffic:
      'Lasts until the plan’s next traffic reset and is removed 30 minutes after it (the reset runs on Remnawave’s clock: {{zone}}). On a plan without resets, or when the subscription ends first, until the end of the subscription.',
    trafficOff:
      'Lasts until the end of the subscription. With the “Traffic add-ons until the reset” switch on (Settings tab), until the next reset on plans that reset.',
    devices: 'Extra devices last until the end of the subscription.',
  },
} as const
