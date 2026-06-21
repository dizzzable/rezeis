/**
 * "Bot map" feature bundle (EN). Lazy-loaded via withFeatureBundle('botMap').
 * Wave 2 of the bot-studio-redesign spec — list view + inspectors.
 */
export const en = {
  botMapPage: {
    title: 'Bot map',
    subtitle:
      'Every bot screen and message in one list — see where each button leads, edit RU/EN copy in place.',
    refresh: 'Refresh',
    loadFailed: 'Failed to load the map',
    banner: {
      label: 'Banner',
      none: 'No banner set',
      pick: 'Pick from library',
      upload: 'Upload',
      uploaded: 'Banner uploaded',
      uploadFailed: 'Banner upload failed',
      tooLarge: 'File too large (max 8 MB)',
      clear: 'Remove banner',
      deleteFromLibrary: 'Delete from library',
      hint: 'When unset, the bot uses the global banner. PNG/JPEG/WEBP/GIF, up to 8 MB.',
    },
    tabs: {
      list: 'List',
      diagram: 'Diagram',
    },
    diagram: {
      placeholderTitle: 'Diagram — coming in the next wave',
      placeholderBody:
        'The visual canvas with nodes and edges ships in Wave 3. For now, every change goes through the list on the left — same data, just a different presentation.',
    },
    rail: {
      searchPlaceholder: 'Search a screen, button, notification type…',
      empty: 'No matches',
      total: 'Nodes: {{count}}',
      groups: {
        graph: 'Graph screens',
        reply: 'Main menu',
        'notification:expires': 'Notifications — Expiry',
        'notification:referral': 'Notifications — Referrals',
        'notification:partner': 'Notifications — Partners',
        'notification:promocode': 'Notifications — Promo codes',
        'notification:system': 'Notifications — System',
        'notification:other': 'Notifications — Other',
        terminal: 'Mini App pages',
      },
    },
    badges: {
      root: 'Start',
      published: 'Published',
      draft: 'Draft',
      active: 'Active',
      disabled: 'Disabled',
      buttons: '{{count}} buttons',
      noButtons: 'No buttons',
    },
    destination: {
      screen: '→ screen {{name}}',
      webApp: '→ Mini App {{route}}',
      url: '→ URL {{host}}',
      chat: '→ Support chat',
      callback: '→ Callback {{id}}',
      back: '→ Back to menu',
      invalid: '✕ Target unset',
      unsafeUrl: '✕ Unsafe URL',
    },
    inspector: {
      empty: 'Pick a node on the left to open its editor.',
      saved: 'Saved',
      saveFailed: 'Save failed',
      enFallback: 'When EN is empty, the bot delivers the RU copy.',
      emojiAria: 'Insert emoji',
    },
    graphScreen: {
      title: 'Bot graph screen',
      shortIdLabel: 'Screen identifier',
      isRoot: 'Start screen',
      textRu: 'Text (RU)',
      textEn: 'Text (EN)',
      placeholderRu: 'What the user sees on this screen…',
      placeholderEn: 'Same screen for English-speaking users…',
      buttonCountLabel: 'Buttons on this screen',
      tooltipFullEditor:
        "Edit this screen's buttons, media and actions on the Diagram tab.",
    },
    replyKeyboard: {
      title: 'Main menu (reply keyboard)',
      subtitle:
        'These buttons appear above the Telegram keyboard. Each button leads somewhere — a bot screen, the cabinet, or a chat.',
      buttonId: 'Button id',
      label: 'Label',
      action: 'Action',
      target: 'Target',
      visible: 'Visible',
      empty: 'No buttons yet — add them on the Diagram tab.',
      saveLabel: 'Save label',
    },
    notification: {
      title: 'Notification template',
      typeLabel: 'Event type',
      isActive: 'Template is active',
      titleRu: 'Title (RU)',
      titleEn: 'Title (EN)',
      bodyRu: 'Body (RU)',
      bodyEn: 'Body (EN)',
      placeholderTitleRu: 'Subject for Russian-speaking users',
      placeholderTitleEn: 'English subject line',
      placeholderBodyRu:
        'Notification body. Supports placeholders like {{name}}, {{plan}}, {{expiresAt}}.',
      placeholderBodyEn: 'Same body for English-speaking users.',
      buttonsTitle: 'Notification buttons',
      buttonsHint:
        'Buttons attach to the Telegram message. webApp targets deep-link the user into a cabinet route.',
      addButton: 'Add button',
      removeButton: 'Remove',
      kind: 'Kind',
      kindOptions: {
        webApp: 'Mini App',
        url: 'URL',
        callback: 'Callback',
      },
      labelRu: 'Label (RU)',
      labelEn: 'Label (EN)',
      targetWebApp: 'Mini App route (e.g. /renew)',
      targetUrl: 'Absolute HTTPS URL',
      targetCallback: 'callback_data (e.g. menu:main)',
      defaultTargetHint:
        'With no buttons, the system still deep-links into the most relevant cabinet section — see the diagram.',
      save: 'Save template',
    },
    terminal: {
      title: 'Mini App page',
      subtitle:
        'Read-only node: a cabinet route. Notification and graph buttons deep-link here. The page itself lives in the cabinet (reiwa) codebase.',
      route: 'Route',
      description: 'Description',
    },
  },
} as const
