import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  auditConnectPageConfig,
  connectPageConfigSchema,
  encodingFor,
  normalizeConnectPageConfig,
  type ConnectPageConfig,
} from '../src/modules/subpage-config/connect-page/connect-page.schema';

/**
 * The catalog, checked where the person who can fix it is still looking at it.
 *
 * v1 declared the whole catalog as `z.record(z.string(), z.unknown())` — nothing
 * about it was checked, deliberately, because the real validation lived
 * downstream in the (AGPL) subscription page. With the cabinet as the only
 * renderer there is no downstream: every rule below is a way to save something
 * that parses and then shows a paying customer a blank card.
 */

function config(overrides: Partial<ConnectPageConfig> = {}): ConnectPageConfig {
  return {
    version: 2,
    icons: { happ: '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>' },
    platforms: [
      {
        id: 'ios',
        title: { ru: 'iOS', en: 'iOS' },
        iconKey: null,
        apps: [
          {
            id: 'happ',
            name: 'Happ',
            iconKey: 'happ',
            featured: true,
            steps: [
              {
                title: { ru: 'Добавьте подписку', en: 'Add subscription' },
                body: null,
                iconKey: null,
                buttons: [
                  {
                    kind: 'deepLink',
                    label: { ru: 'Добавить', en: 'Add' },
                    template: 'happ://add/{{SUBSCRIPTION_LINK}}',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  } as ConnectPageConfig;
}

const parse = (value: unknown) => connectPageConfigSchema.safeParse(value);

describe('where the placeholder sits decides how it is substituted', () => {
  it('substitutes into a path raw', () => {
    for (const template of [
      'happ://add/{{SUBSCRIPTION_LINK}}',
      'v2raytun://import/{{SUBSCRIPTION_LINK}}',
      'streisand://import/{{SUBSCRIPTION_LINK}}',
      'hiddify://import/{{SUBSCRIPTION_LINK}}',
    ]) {
      assert.equal(encodingFor(template), 'raw', template);
    }
  });

  it('percent-encodes into a query parameter', () => {
    // THE DEFECT THIS PREVENTS. Substituted raw, the `?`, `&`, `=` and `#`
    // inside a subscription URL truncate the parameter: the app opens and adds
    // nothing, which everyone reads as "the deep link is broken".
    assert.equal(encodingFor('clash://install-config?url={{SUBSCRIPTION_LINK}}'), 'component');
    assert.equal(encodingFor('x://y?a=1&url={{SUBSCRIPTION_LINK}}'), 'component');
  });

  it('reads the position, not a list of apps', () => {
    // A question mark AFTER the placeholder leaves it in the path, and an app
    // nobody has heard of gets the right answer without being listed anywhere.
    assert.equal(encodingFor('newapp://add/{{SUBSCRIPTION_LINK}}?src=cabinet'), 'raw');
  });

  it('stamps the answer into the config instead of leaving it to be re-derived', () => {
    // The cabinet is a different image. The same rule written on both sides of
    // an image boundary is the shape that has already drifted apart on us.
    const stamped = normalizeConnectPageConfig(
      config({
        platforms: [
          {
            ...config().platforms[0],
            apps: [
              {
                ...config().platforms[0].apps[0],
                steps: [
                  {
                    ...config().platforms[0].apps[0].steps[0],
                    buttons: [
                      {
                        kind: 'deepLink',
                        label: { en: 'Add' },
                        template: 'clash://install-config?url={{SUBSCRIPTION_LINK}}',
                        encode: 'raw',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const button = stamped.platforms[0].apps[0].steps[0].buttons[0];
    assert.equal(button.kind, 'deepLink');
    assert.equal(
      button.kind === 'deepLink' ? button.encode : null,
      'component',
      'an authored value is a conclusion, and a stored conclusion that contradicts its premise is worse than none',
    );
  });
});

describe('a link is not allowed to be a script', () => {
  it('refuses schemes that execute', () => {
    for (const template of [
      'javascript:alert("{{SUBSCRIPTION_LINK}}")',
      'data:text/html,{{SUBSCRIPTION_LINK}}',
      'vbscript:x{{SUBSCRIPTION_LINK}}',
    ]) {
      const result = parse(
        config({
          platforms: [
            {
              ...config().platforms[0],
              apps: [
                {
                  ...config().platforms[0].apps[0],
                  steps: [
                    {
                      ...config().platforms[0].apps[0].steps[0],
                      buttons: [{ kind: 'deepLink', label: { en: 'Add' }, template }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
      assert.equal(result.success, false, `${template} must be refused`);
    }
  });

  it('refuses a template with no placeholder or with two', () => {
    for (const template of [
      'happ://add/',
      'happ://add/{{SUBSCRIPTION_LINK}}/{{SUBSCRIPTION_LINK}}',
    ]) {
      const result = parse(
        config({
          platforms: [
            {
              ...config().platforms[0],
              apps: [
                {
                  ...config().platforms[0].apps[0],
                  steps: [
                    {
                      ...config().platforms[0].apps[0].steps[0],
                      buttons: [{ kind: 'deepLink', label: { en: 'Add' }, template }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
      assert.equal(result.success, false, `${template} must be refused`);
    }
  });

  it('keeps a store link to http(s)', () => {
    const result = parse(
      config({
        platforms: [
          {
            ...config().platforms[0],
            apps: [
              {
                ...config().platforms[0].apps[0],
                steps: [
                  {
                    ...config().platforms[0].apps[0].steps[0],
                    buttons: [{ kind: 'external', label: { en: 'App Store' }, url: 'itms://x' }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    assert.equal(result.success, false);
  });
});

describe('the shape itself', () => {
  it('accepts a catalog that would actually work', () => {
    assert.equal(parse(config()).success, true);
  });

  it('refuses a platform the cabinet cannot detect', () => {
    // The screen picks a platform automatically, so it can only pick from what
    // it knows how to detect. An invented id authors a section nobody is shown.
    const bad = config();
    (bad.platforms[0] as { id: string }).id = 'windows11';

    assert.equal(parse(bad).success, false);
  });

  it('refuses unknown top-level keys instead of carrying them along', () => {
    // v1 used `.passthrough()` so the fork could add fields without an admin
    // release. There is no fork now, and a silently carried key is a field
    // somebody believes is doing something.
    assert.equal(parse({ ...config(), baseTranslations: {} }).success, false);
  });

  it('refuses a platform with no apps', () => {
    assert.equal(parse(config({ platforms: [{ ...config().platforms[0], apps: [] }] })).success, false);
  });
});

describe('what parses perfectly and still shows nothing', () => {
  it('catches a platform that recommends nothing', () => {
    const draft = config();
    draft.platforms[0].apps[0].featured = false;

    const issues = auditConnectPageConfig(draft);

    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /no recommended app/i);
  });

  it('catches a platform that recommends two', () => {
    const draft = config();
    draft.platforms[0].apps.push({ ...draft.platforms[0].apps[0], id: 'streisand', name: 'Streisand' });

    const issues = auditConnectPageConfig(draft);

    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /recommends 2 apps/i);
  });

  it('catches an app nobody can actually connect with', () => {
    // THE FAILURE THIS SCREEN EXISTS TO PREVENT, and it parses perfectly: three
    // tidy steps, two store buttons, and no way to hand the subscription over.
    const draft = config();
    draft.platforms[0].apps[0].steps[0].buttons = [
      { kind: 'external', label: { en: 'App Store' }, url: 'https://apps.apple.com/app/id1' },
    ];

    const issues = auditConnectPageConfig(draft);

    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /no way to hand over the subscription/i);
  });

  it('catches two apps sharing an id, which is what remembering a choice hangs on', () => {
    const draft = config();
    draft.platforms[0].apps.push({ ...draft.platforms[0].apps[0], featured: false });

    const issues = auditConnectPageConfig(draft);

    assert.ok(issues.some((issue) => /share the id/i.test(issue.message)));
  });

  it('catches an icon that is not in the library', () => {
    const draft = config();
    draft.platforms[0].apps[0].iconKey = 'missing';

    const issues = auditConnectPageConfig(draft);

    assert.ok(issues.some((issue) => /not in the icon library/i.test(issue.message)));
  });

  it('catches a store link carrying the subscription placeholder', () => {
    // A store link is public and shared by everyone; the placeholder in it would
    // put one customer's subscription into a URL handed to all of them.
    const draft = config();
    draft.platforms[0].apps[0].steps[0].buttons.push({
      kind: 'external',
      label: { en: 'Store' },
      url: 'https://store.example/{{SUBSCRIPTION_LINK}}',
    });

    const issues = auditConnectPageConfig(draft);

    assert.ok(issues.some((issue) => /must not carry/i.test(issue.message)));
  });

  it('refuses an icon key that only the prototype chain answers to', () => {
    // `constructor` is a valid slug, and the membership check used `in`, which
    // walks the prototype chain — so this catalog audited CLEAN, saved, and
    // handed the cabinet `Object` itself where an SVG string belongs. Every
    // member of `Object.prototype` is a slug: `toString`, `valueOf`, the lot.
    for (const key of ['constructor', 'toString', 'valueOf']) {
      const draft = config();
      draft.icons = {};
      draft.platforms[0].apps[0].iconKey = key;

      const issues = auditConnectPageConfig(draft);

      assert.ok(
        issues.some((issue) => issue.message.includes(`Icon "${key}" is not in the icon library`)),
        `${key} was accepted as an icon key: ${JSON.stringify(issues)}`,
      );
    }
  });

  it('says nothing about a catalog that is fine', () => {
    assert.deepEqual(auditConnectPageConfig(config()), []);
  });
});
