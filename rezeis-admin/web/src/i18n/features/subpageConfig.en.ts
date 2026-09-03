/**
 * Lazy-loaded i18n feature bundle (en): subpageConfig
 * Namespace: subpageConfigPage
 */

export const en = {
  subpageConfigPage: {
    title: 'Subscription page',
    subtitle: 'Branding and apps for the rezeis-subpage. Changes apply immediately.',
    usingDefault:
      'No config saved yet — the built-in default is being served. Save to override it.',
    tabs: {
      general: 'General',
      clients: 'Clients',
      icons: 'Icons',
      translations: 'Translations',
      advanced: 'JSON',
    },
    translations: {
      title: 'Interface strings',
      description: 'Labels shown on the subscription page, per language.',
      empty: 'No translations in the config.',
    },
    icons: {
      title: 'Icon library',
      description: 'Named SVG icons referenced by platforms, blocks and buttons.',
      key: 'Key (latin letters only)',
      svg: 'SVG markup',
      add: 'Add icon',
      remove: 'Remove icon',
      keyError: 'Key must contain only latin letters (a–z, A–Z).',
      keyExists: 'An icon with this key already exists.',
    },
    clients: {
      addPlatform: 'Add platform',
      removePlatform: 'Remove platform',
      platformIcon: 'Platform icon',
      addApp: 'Add app',
      newApp: 'New app',
      featured: 'Featured',
      addBlock: 'Add block',
      addButton: 'Add button',
      icon: 'Icon',
      color: 'Color',
      blockTitle: 'Title',
      blockDescription: 'Description',
      buttonType: 'Button type',
      buttonLink: 'Link (use {{SUBSCRIPTION_LINK}} for the subscription URL)',
      buttonText: 'Button text',
      empty: 'No platforms yet — add one above.',
      types: {
        external: 'External link',
        subscriptionLink: 'Subscription deep-link',
        copyButton: 'Copy link',
      },
    },
    actions: {
      save: 'Save',
      reset: 'Reset changes',
      download: 'Download JSON',
    },
    branding: {
      title: 'Branding',
      description: 'Name, logo and support link shown on the page.',
      name: 'Name',
      logoUrl: 'Logo URL',
      supportUrl: 'Support URL',
    },
    base: {
      title: 'Page settings',
      description: 'Meta tags and what the page exposes.',
      metaTitle: 'Meta title',
      metaDescription: 'Meta description',
      showConnectionKeys: 'Show connection keys',
      hideGetLinkButton: 'Hide "Get link" button',
    },
    theme: {
      title: 'Theme',
      description: 'Colors of the subscription page — applied live from the panel.',
      primaryColor: 'Primary color',
      backgroundColor: 'Background',
      accentColor: 'Accent',
    },
    ui: {
      title: 'Layout',
      description: 'How the subscription info and installation guides are rendered.',
      infoBlock: 'Subscription info block',
      guideBlock: 'Installation guide block',
      infoBlockTypes: {
        collapsed: 'Collapsed',
        expanded: 'Expanded',
        cards: 'Cards',
        hidden: 'Hidden',
      },
      guideBlockTypes: {
        cards: 'Cards',
        accordion: 'Accordion',
        minimal: 'Minimal',
        timeline: 'Timeline',
      },
    },
    advanced: {
      title: 'Full config (JSON)',
      description:
        'Edit the whole config, including the app catalog (platforms), translations and svg icons. Invalid JSON blocks saving.',
    },
    toasts: {
      saved: 'Subscription page config saved',
      saveFailed: 'Failed to save config',
      reset: 'Changes reset',
      downloaded: 'Config downloaded (subpage-config.json)',
      fixJson: 'Fix the JSON errors before saving',
      invalid: 'Config is invalid',
    },
  },
  connectScreen: {
    title: 'Connect screen in the cabinet',
    description:
      'Where the "Connect" button on a subscription card goes: the external page, or a screen inside the cabinet.',
    label: 'Open the connect screen in the cabinet',
    hintOn:
      'The customer stays in the cabinet: the platform is detected, the chosen app is remembered, the link is one tap away.',
    hintOff:
      'As today: "Connect" opens the external subscription page. This position is also the rollback — no deploy needed.',
    turnedOn: 'Connect screen is on',
    turnedOff: 'Connect screen is off — the button opens the external page again',
    saveFailed: 'Could not save',
  },
};
