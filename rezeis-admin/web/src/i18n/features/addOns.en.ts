/**
 * Lazy-loaded i18n feature bundle (en): addOns
 *
 * Contains namespaces: addOnSwitches.
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
          'Allows selling add-ons set to “Until next reset”: such an add-on ends at the plan’s next traffic reset.',
        caution: 'Keep it off for now: the match with Remnawave’s traffic reset times is still being checked.',
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
        does: '“Until next reset” add-ons are no longer offered or sold.',
        keep1: 'Add-ons already sold “until the reset” end at their reset.',
      },
    },
  },
} as const
