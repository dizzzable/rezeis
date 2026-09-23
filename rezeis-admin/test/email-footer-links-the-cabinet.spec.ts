import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { advertisingConfig } from '../src/common/config/advertising.config';
import { resolveCabinetSiteUrl } from '../src/common/config/public-site-url.util';
import { ReiwaAdvertisingLinkConfigService } from '../src/modules/advertising/services/reiwa-advertising-link-config.service';
import { EmailTemplateRendererService } from '../src/modules/email/services/email-template-renderer.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * THE WEBSITE IN A CUSTOMER EMAIL'S FOOTER IS THE CABINET, NEVER THE PANEL.
 *
 * Every branded email — codes, reset links, notifications, broadcasts — ends
 * with a footer that prints the brand, a website link and the support address.
 * The website was built from `REZEIS_DOMAIN`, which is the ADMIN panel's public
 * domain (`docs/environment.md`: «Публичный домен админки»). So every customer
 * who received a letter was shown, as a clickable link, the address of the
 * operator's admin panel — the one surface an operator keeps out of customers'
 * sight.
 *
 * The footer now names the cabinet, resolved by the ONE resolver the ad links
 * use (`ReiwaAdvertisingLinkConfigService`): the address the cabinet itself
 * publishes first, then `REIWA_WEB_BASE_URL` → `MINIAPP_CUSTOM_URL`. The .env
 * pair ships commented out, so an install on defaults only ever had a link
 * because the cabinet publishes one. With no address anywhere the footer
 * carries no link at all: a missing link costs nothing, the wrong one
 * advertises the panel.
 */

const PANEL = 'panel.example.com';

const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
});

/**
 * A letter's footer, with `env` as the panel's environment and `published` as
 * what the cabinet's `/api/v1/public-config` says (`null`: the cabinet cannot
 * be reached). The resolver is the real one, built from the real config.
 */
async function footerLetter(env: Record<string, string>, published: string | null = null): Promise<string> {
  process.env = { ...originalEnvironment, REZEIS_DOMAIN: PANEL };
  delete process.env.REIWA_WEB_BASE_URL;
  delete process.env.MINIAPP_CUSTOM_URL;
  Object.assign(process.env, env);
  globalThis.fetch = async () => {
    if (published === null) throw new Error('reiwa is offline');
    return new Response(JSON.stringify({ webBaseUrl: published }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const prisma = {
    settings: {
      findFirst: async () => ({ brandingSettings: { brandName: 'Acme VPN' }, systemNotifications: {} }),
    },
  } as unknown as PrismaService;
  const cabinetLinks = new ReiwaAdvertisingLinkConfigService(advertisingConfig());
  const result = await new EmailTemplateRendererService(prisma, cabinetLinks).render({
    templateType: '__verification_code__',
    variables: {},
    rawHtml: '<p>123456</p>',
    subject: 'Код подтверждения',
  });
  assert.ok(result !== null);
  return result.html;
}

describe('the website a customer email links to', () => {
  it('is the address the cabinet publishes, with nothing in .env', async () => {
    const html = await footerLetter({}, 'https://cab.example.com/');

    assert.ok(html.includes('href="https://cab.example.com"'), 'the footer does not link the cabinet');
    assert.ok(!html.includes(PANEL), 'the letter shows the admin panel domain');
  });

  it('prefers what the cabinet publishes over a value in .env, as the ads do', async () => {
    const html = await footerLetter({ REIWA_WEB_BASE_URL: 'https://old.example.com' }, 'https://cab.example.com');

    assert.ok(html.includes('href="https://cab.example.com"'), html);
    assert.ok(!html.includes('old.example.com'));
  });

  it('is the .env address when the cabinet cannot be reached', async () => {
    const html = await footerLetter({ REIWA_WEB_BASE_URL: 'https://app.example.com/' });

    assert.ok(html.includes('href="https://app.example.com"'), 'the footer does not link the cabinet');
    assert.ok(!html.includes(PANEL), 'the letter shows the admin panel domain');
  });

  it('falls back to the Mini App address, as the advertising links do', async () => {
    const html = await footerLetter({ MINIAPP_CUSTOM_URL: 'https://mini.example.com' });

    assert.ok(html.includes('href="https://mini.example.com"'));
    assert.ok(!html.includes(PANEL));
  });

  it('is left out when no cabinet address is known', async () => {
    // The panel's own domain is never the fallback.
    const html = await footerLetter({});

    assert.ok(!html.includes(PANEL), 'the letter shows the admin panel domain');
    assert.ok(!/<a href="https?:\/\//.test(html), 'the footer still carries a website link');
  });

  it('is left out when the configured value is not a web address', async () => {
    // The value lands in an `href`; only http(s) is ever written there.
    const html = await footerLetter({ REIWA_WEB_BASE_URL: 'javascript:alert(1)' });

    assert.ok(!html.includes('javascript:'));
    assert.ok(!html.includes(PANEL));
  });
});

describe('the .env part of the cabinet address', () => {
  it('takes REIWA_WEB_BASE_URL before MINIAPP_CUSTOM_URL', () => {
    process.env = {
      ...originalEnvironment,
      REIWA_WEB_BASE_URL: 'https://app.example.com',
      MINIAPP_CUSTOM_URL: 'https://mini.example.com',
    };

    assert.equal(resolveCabinetSiteUrl(), 'https://app.example.com');
    assert.equal(advertisingConfig().webBaseUrl, 'https://app.example.com');
  });
});
