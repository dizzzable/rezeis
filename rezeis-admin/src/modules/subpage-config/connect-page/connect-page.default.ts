/**
 * connect-page.default
 * ────────────────────
 * The catalog an operator gets before they have edited anything.
 *
 * Written here rather than generated from the fork's default, which is what v1
 * shipped: a 31 KB blob, byte-identical to `remnawave/subscription-page`, carried
 * as an opaque string so the panel would not take an AGPL dependency. The panel
 * and the cabinet are MIT; a default is content, and content is the half of a
 * project that a licence is actually about. The store links below are facts —
 * an app's address in a store is not authorship — but every sentence is ours.
 *
 * ── What is deliberately not here ────────────────────────────────────────────
 *
 * NO APP LOGOS. The donor's library ships thirty-nine third-party marks pasted
 * out of the vendors' own sites. Redistributing somebody's logo in our default
 * is a trademark question nobody asked, and it is not needed: `iconKey` is
 * nullable, the screen renders an app without one, and an operator who wants
 * Happ's mark can paste it in a field built for that. The icons below are
 * generic and drawn here: a download arrow, a link, a rocket.
 *
 * NO TV PLATFORMS. `androidtv` and `appletv` exist in the schema and the live
 * page offers them, but we have no first-hand links for those builds, and a
 * default that sends a customer to a wrong download is worse than a default
 * that says nothing. The screen falls back to the platform picker when it has
 * no section for the device it detected.
 *
 * EVERY APP CAN BE CONNECTED WITHOUT A DEEP LINK. Each card carries "copy the
 * link" beside "add to app", because on the donor's own page the fallback is a
 * wall of text at the bottom titled "if the subscription was not added" — an
 * admission that the scheme does not always fire, filed where nobody looks.
 */
import type { ConnectPageConfig, LocalizedText } from './connect-page.schema';

const t = (ru: string, en: string): LocalizedText => ({ ru, en });

const STEP = {
  install: t('Установите приложение', 'Install the app'),
  add: t('Добавьте подписку', 'Add the subscription'),
  connect: t('Подключитесь', 'Connect'),
} as const;

const BODY = {
  installStore: t(
    'Откройте страницу приложения и установите его. Это бесплатно.',
    'Open the app page and install it. It is free.',
  ),
  installDirect: t(
    'Скачайте приложение по ссылке ниже и установите.',
    'Download the app below and install it.',
  ),
  addAuto: t(
    'Нажмите кнопку — приложение откроется и добавит подписку само.',
    'Tap the button: the app opens and adds the subscription itself.',
  ),
  addManual: t(
    'Скопируйте ссылку и добавьте её в приложении как новую подписку.',
    'Copy the link and add it in the app as a new subscription.',
  ),
  connect: t(
    'Откройте приложение, разрешите настройку VPN, выберите сервер и включите подключение.',
    'Open the app, allow the VPN configuration, pick a server and turn the connection on.',
  ),
} as const;

const LABEL = {
  add: t('Добавить в приложение', 'Add to the app'),
  copy: t('Скопировать ссылку', 'Copy the link'),
  appStore: t('App Store', 'App Store'),
  googlePlay: t('Google Play', 'Google Play'),
  apk: t('Скачать APK', 'Download APK'),
  releases: t('Скачать с GitHub', 'Download from GitHub'),
} as const;

interface AppSeed {
  readonly id: string;
  readonly name: string;
  readonly featured?: true;
  /** Store or download buttons, in the order the operator would offer them. */
  readonly downloads: ReadonlyArray<{ readonly label: LocalizedText; readonly url: string }>;
  /** Absent when the app has no scheme and the link has to be pasted by hand. */
  readonly scheme?: string;
}

/**
 * Three steps, always the same three.
 *
 * The donor's catalog lets every app invent its own step structure, which is
 * why its cards drift apart — one app explains where the TUN switch is, the next
 * does not. Install, add, connect is what every one of these apps actually
 * needs, and a shape shared by all of them is a shape an operator can edit
 * without re-reading the others.
 */
function app(seed: AppSeed) {
  const handover = seed.scheme
    ? [
        { kind: 'deepLink' as const, label: LABEL.add, template: seed.scheme },
        { kind: 'copyLink' as const, label: LABEL.copy },
      ]
    : [{ kind: 'copyLink' as const, label: LABEL.copy }];

  return {
    id: seed.id,
    name: seed.name,
    iconKey: null,
    featured: seed.featured === true,
    steps: [
      {
        title: STEP.install,
        body: seed.downloads.some((d) => d.url.includes('github.com'))
          ? BODY.installDirect
          : BODY.installStore,
        iconKey: 'download',
        buttons: seed.downloads.map((download) => ({
          kind: 'external' as const,
          label: download.label,
          url: download.url,
        })),
      },
      {
        title: STEP.add,
        body: seed.scheme ? BODY.addAuto : BODY.addManual,
        iconKey: 'link',
        buttons: handover,
      },
      {
        title: STEP.connect,
        body: BODY.connect,
        iconKey: 'rocket',
        buttons: [],
      },
    ],
  };
}

const HAPP_IOS = {
  id: 'happ',
  name: 'Happ',
  featured: true,
  downloads: [{ label: LABEL.appStore, url: 'https://apps.apple.com/app/happ-proxy-utility/id6504287215' }],
  scheme: 'happ://add/{{SUBSCRIPTION_LINK}}',
} as const satisfies AppSeed;

const HIDDIFY = {
  id: 'hiddify',
  name: 'Hiddify',
  downloads: [{ label: LABEL.releases, url: 'https://github.com/hiddify/hiddify-app/releases' }],
  scheme: 'hiddify://import/{{SUBSCRIPTION_LINK}}',
} as const satisfies AppSeed;

const STREISAND = {
  id: 'streisand',
  name: 'Streisand',
  downloads: [{ label: LABEL.appStore, url: 'https://apps.apple.com/app/streisand/id6450534064' }],
  scheme: 'streisand://import/{{SUBSCRIPTION_LINK}}',
} as const satisfies AppSeed;

/**
 * Simple, generic, and drawn here.
 *
 * Two-colour stroke icons at 24×24 with `currentColor`, so they take the
 * cabinet's own text colour in every one of its themes rather than carrying a
 * palette of their own.
 */
const ICONS: Record<string, string> = {
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  rocket:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13c-1.5 1.5-2 5-2 6 1 0 4.5-.5 6-2"/><path d="M19 3c-4 0-8 2-11 7l-1 3 4 4 3-1c5-3 7-7 7-11 0-1-1-2-2-2z"/><circle cx="14.5" cy="9.5" r="1.5"/></svg>',
  phone:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
  monitor:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
};

export const DEFAULT_CONNECT_PAGE_CONFIG: ConnectPageConfig = {
  version: 2,
  // Off until an operator turns it on: this replaces a working flow.
  connectScreenEnabled: false,
  icons: ICONS,
  platforms: [
    {
      id: 'ios',
      title: t('iPhone и iPad', 'iPhone and iPad'),
      iconKey: 'phone',
      apps: [
        app(HAPP_IOS),
        app({
          id: 'v2raytun',
          name: 'v2RayTun',
          downloads: [{ label: LABEL.appStore, url: 'https://apps.apple.com/app/v2raytun/id6476628951' }],
          scheme: 'v2raytun://import/{{SUBSCRIPTION_LINK}}',
        }),
        app(STREISAND),
        app({
          id: 'shadowrocket',
          name: 'Shadowrocket',
          downloads: [{ label: LABEL.appStore, url: 'https://apps.apple.com/app/shadowrocket/id932747118' }],
        }),
      ],
    },
    {
      id: 'android',
      title: t('Android', 'Android'),
      iconKey: 'phone',
      apps: [
        app({
          ...HAPP_IOS,
          downloads: [
            { label: LABEL.googlePlay, url: 'https://play.google.com/store/apps/details?id=com.happproxy' },
            {
              label: LABEL.apk,
              url: 'https://github.com/Happ-proxy/happ-android/releases/latest/download/Happ.apk',
            },
          ],
        }),
        app({
          id: 'v2raytun',
          name: 'v2RayTun',
          downloads: [
            {
              label: LABEL.googlePlay,
              url: 'https://play.google.com/store/apps/details?id=com.v2raytun.android',
            },
          ],
          scheme: 'v2raytun://import/{{SUBSCRIPTION_LINK}}',
        }),
        app({
          ...HIDDIFY,
          downloads: [
            { label: LABEL.googlePlay, url: 'https://play.google.com/store/apps/details?id=app.hiddify.com' },
            { label: LABEL.releases, url: 'https://github.com/hiddify/hiddify-app/releases' },
          ],
        }),
        app({
          id: 'clash-meta',
          name: 'Clash Meta',
          downloads: [
            { label: LABEL.releases, url: 'https://github.com/MetaCubeX/ClashMetaForAndroid/releases' },
          ],
          // The one template in the whole default whose placeholder sits in a
          // query parameter — and therefore the one that must be encoded. It is
          // kept here on purpose: a default that exercises both substitution
          // rules is a default that would break loudly if only one of them were
          // implemented.
          scheme: 'clash://install-config?url={{SUBSCRIPTION_LINK}}',
        }),
      ],
    },
    {
      id: 'windows',
      title: t('Windows', 'Windows'),
      iconKey: 'monitor',
      apps: [
        app({ ...HIDDIFY, featured: true }),
        app({
          id: 'v2rayn',
          name: 'v2rayN',
          downloads: [{ label: LABEL.releases, url: 'https://github.com/2dust/v2rayN/releases' }],
        }),
      ],
    },
    {
      id: 'macos',
      title: t('macOS', 'macOS'),
      iconKey: 'monitor',
      apps: [
        app(HAPP_IOS),
        app(HIDDIFY),
        app(STREISAND),
      ],
    },
    {
      id: 'linux',
      title: t('Linux', 'Linux'),
      iconKey: 'monitor',
      apps: [
        app({ ...HIDDIFY, featured: true }),
        app({
          id: 'nekoray',
          name: 'Nekoray',
          downloads: [{ label: LABEL.releases, url: 'https://github.com/MatsuriDayo/nekoray/releases' }],
        }),
      ],
    },
  ],
};
