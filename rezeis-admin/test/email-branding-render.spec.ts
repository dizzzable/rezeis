import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EmailTemplateRendererService } from '../src/modules/email/services/email-template-renderer.service';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Regression: the email layout used to read `serviceName` / `primaryColor`,
 * which the branding column never stores (it uses `brandName` / `primary`).
 * Every email therefore fell back to "Rezeis VPN" + blue. The renderer must
 * now pick up the operator's real brand.
 */
function makeRenderer(branding: Record<string, unknown>, notif: Record<string, unknown> = {}) {
  const prisma = {
    settings: {
      findFirst: async () => ({ brandingSettings: branding, systemNotifications: notif }),
    },
  } as unknown as PrismaService;
  return new EmailTemplateRendererService(prisma);
}

describe('EmailTemplateRendererService branding', () => {
  it('applies brandName + primary + logoUrl from the real branding keys', async () => {
    const renderer = makeRenderer({
      brandName: 'Acme VPN',
      primary: '#ff0000',
      logoUrl: 'https://cdn.example/logo.png',
    });

    const result = await renderer.render({
      templateType: '__verification_code__',
      variables: {},
      rawHtml: '<p>hello</p>',
      subject: 'Код подтверждения',
    });

    assert.ok(result !== null);
    assert.equal(result.subject, 'Код подтверждения');
    assert.ok(result.html.includes('Acme VPN'), 'brand name should appear');
    assert.ok(result.html.includes('#ff0000'), 'primary color should appear');
    assert.ok(result.html.includes('https://cdn.example/logo.png'), 'logo should appear');
    assert.ok(result.html.includes('<p>hello</p>'), 'raw body should be embedded');
  });

  it('falls back to the project brand (never the hidden panel name) when branding is empty', async () => {
    const renderer = makeRenderer({});
    const result = await renderer.render({
      templateType: '__test__',
      variables: {},
      rawHtml: '<p>x</p>',
    });
    assert.ok(result !== null);
    assert.equal(result.subject, 'Notification');
    // Default brand is the user-facing project ("Reiwa"), NOT "Rezeis".
    assert.ok(result.html.includes('Reiwa'));
    assert.ok(!result.html.includes('Rezeis'));
    assert.ok(result.html.includes('#22c55e'));
  });
});
