import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { advertisingConfig } from '../src/common/config/advertising.config';
import { resolveEmailImageUrl } from '../src/common/config/public-site-url.util';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ReiwaAdvertisingLinkConfigService } from '../src/modules/advertising/services/reiwa-advertising-link-config.service';
import { BroadcastDeliveryService } from '../src/modules/broadcast/services/broadcast-delivery.service';
import { EmailTemplateRendererService } from '../src/modules/email/services/email-template-renderer.service';

/**
 * EVERY PICTURE IN A CUSTOMER EMAIL HAS AN ADDRESS A MAIL CLIENT CAN FETCH —
 * AND THE LOGO'S IS THE CABINET'S WHENEVER THE CABINET'S ADDRESS IS KNOWN.
 *
 * A logo uploaded on «WEB Reiwa» is stored as `/uploads/branding/<file>`:
 * root-relative, which the cabinet and the panel resolve against their own
 * origin and an inbox resolves against nothing. The layout put it into
 * `<img src>` exactly as stored, so every letter of an install with an uploaded
 * logo opened with a broken image.
 *
 * The first repair built it on the panel's public site, which put the admin
 * domain into every letter. The cabinet serves the very same file itself
 * (reiwa `app.get('/uploads/branding/:file')`, disk-cached), so the logo is
 * fetched from the cabinet — resolved as the footer link and the ad links are
 * (`email-footer-links-the-cabinet.spec.ts`) — and from the panel only when no
 * cabinet address is known at all.
 */

const PANEL = 'panel.example.com';

const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
});

/**
 * `domain` is the panel's REZEIS_DOMAIN, `env` the rest of its .env, and
 * `published` what the cabinet's `/api/v1/public-config` says (`null`: the
 * cabinet cannot be reached).
 */
function install(domain: string | null, env: Record<string, string> = {}, published: string | null = null): void {
  process.env = { ...originalEnvironment };
  delete process.env.REIWA_WEB_BASE_URL;
  delete process.env.MINIAPP_CUSTOM_URL;
  if (domain === null) delete process.env.REZEIS_DOMAIN;
  else process.env.REZEIS_DOMAIN = domain;
  Object.assign(process.env, env);
  globalThis.fetch = async () => {
    if (published === null) throw new Error('reiwa is offline');
    return new Response(JSON.stringify({ webBaseUrl: published }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function letterWithLogo(logoUrl: string): Promise<string> {
  const prisma = {
    settings: {
      findFirst: async () => ({
        brandingSettings: { brandName: 'Acme VPN', logoUrl },
        systemNotifications: {},
      }),
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

function imageSources(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\ssrc="([^"]*)"/g)].map((match) => match[1]);
}

describe('the logo at the top of a customer email', () => {
  it('is fetched from the cabinet, which serves the same file, and the letter never names the panel', async () => {
    install(PANEL, {}, 'https://cab.example.com');
    const html = await letterWithLogo('/uploads/branding/logo.png');

    assert.deepEqual(imageSources(html), ['https://cab.example.com/uploads/branding/logo.png']);
    assert.ok(!html.includes(PANEL), 'the letter carries the admin domain');
  });

  it('is fetched from the cabinet address in .env when the cabinet cannot be asked', async () => {
    install(PANEL, { MINIAPP_CUSTOM_URL: 'https://mini.example.com/' });
    const html = await letterWithLogo('/uploads/branding/logo.png');

    assert.deepEqual(imageSources(html), ['https://mini.example.com/uploads/branding/logo.png']);
  });

  it('is fetched from the panel only when no cabinet address is known', async () => {
    install(PANEL);
    const html = await letterWithLogo('/uploads/branding/logo.png');

    assert.deepEqual(imageSources(html), [`https://${PANEL}/uploads/branding/logo.png`]);
  });

  it('is fetched from the panel when the cabinet does not serve that path', () => {
    // The cabinet relays `/uploads/branding/<one flat file>` and nothing else,
    // so any other path would be a broken image on the cabinet's host. The
    // branding reader lets no other root-relative logo through today; the
    // image resolver does not rely on that.
    install(PANEL);
    const cabinet = 'https://cab.example.com';

    assert.equal(resolveEmailImageUrl('/uploads/emoji/a.webp', cabinet), `https://${PANEL}/uploads/emoji/a.webp`);
    assert.equal(
      resolveEmailImageUrl('/uploads/branding/nested/logo.png', cabinet),
      `https://${PANEL}/uploads/branding/nested/logo.png`,
    );
    assert.equal(resolveEmailImageUrl('/uploads/branding/logo.png', cabinet), `${cabinet}/uploads/branding/logo.png`);
  });

  it('is used as it is when it already is an absolute address', async () => {
    install(PANEL, {}, 'https://cab.example.com');
    const html = await letterWithLogo('https://cdn.example/logo.png');

    assert.deepEqual(imageSources(html), ['https://cdn.example/logo.png']);
  });

  it('is left out, not broken, when neither the cabinet nor the panel has a public address', async () => {
    // `localhost` and a docker service name reach nobody's mail client.
    install('localhost');
    const html = await letterWithLogo('/uploads/branding/logo.png');

    assert.deepEqual(imageSources(html), []);
    assert.ok(html.includes('Acme VPN'), 'the header lost the brand name');
  });

  it('shows the panel only as an image source, never as text, in the fallback', async () => {
    install(PANEL);
    const html = await letterWithLogo('/uploads/branding/logo.png');

    const withoutSources = html.replace(/\ssrc="[^"]*"/g, '');
    assert.ok(!withoutSources.includes(PANEL), 'the panel domain appears outside an image source');
  });
});

describe('the pack pictures a broadcast email embeds', () => {
  it('are fetched from the panel, where emoji uploads live', async () => {
    install(PANEL);
    const packs = [
      {
        id: 'pack-1',
        name: 'Pack',
        emojis: [{ slug: 'party', name: 'Party', imageUrl: '/uploads/emoji/a.webp', fallback: '🎉' }],
      },
    ];
    // Only the pack reader is used on this path; nothing else is touched.
    const unused = null as never;
    const service = new BroadcastDeliveryService(
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      { listPacks: async () => packs } as never,
      undefined,
    );

    const map = await (
      service as unknown as { emailEmojiMap(): Promise<ReadonlyMap<string, { imageUrl: string | null }>> }
    ).emailEmojiMap();

    assert.equal(map.get('party')?.imageUrl, `https://${PANEL}/uploads/emoji/a.webp`);
  });
});
