import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserNotificationsService } from '../src/modules/notifications/services/user-notifications.service';

/**
 * A plan named `Pro <Max>` used to make a message undeliverable, for ever
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The Telegram body is sent with `parse_mode: HTML`. The TITLE was escaped
 * wholesale; the BODY was not, and its placeholders carry the three least
 * trustworthy strings in the system — a Telegram display name, a plan name an
 * operator typed, and a profile username from the panel.
 *
 * A bare `<` in any of them earns `400 can't parse entities: Unsupported start
 * tag`, and the durable relay then retries a message that can never succeed.
 * It mattered from this release on, because the new expiry templates are what
 * put a plan name and a panel username into a body for the first time.
 *
 * The fix escapes the VALUES and not the template: operators author markup in
 * the body, and the custom-emoji pass that runs afterwards emits `<tg-emoji>`
 * tags, so escaping the whole string would break both.
 */

type Rendered = { title: string; body: string; html: string };

function buildService() {
  const service = new UserNotificationsService(
    { settings: { findUnique: async () => null } } as never,
    { getByType: async () => null } as never,
    { notifyUser: async () => undefined } as never,
    { sendToUser: async () => undefined } as never,
    // Identity: the emoji pass is not what this file is about, and a double
    // that rewrote the text would hide whether the escaping happened.
    {
      substituteTelegramHtml: async (t: string) => t,
      substituteFallbacks: async (t: string) => t,
    } as never,
    { enqueue: async () => true } as never,
    { info: () => undefined, warn: () => undefined } as never,
  );
  return service as unknown as {
    renderFromTemplate(
      template: { title: string; body: string; titleEn: string | null; bodyEn: string | null },
      payload: unknown,
      userName: string | null,
      locale: string,
    ): Promise<Rendered>;
  };
}

const TEMPLATE = {
  title: 'Подписка истекает',
  body: 'Привет, {{name}}!\n<b>Тариф:</b> {{plan}}\nПрофиль: {{profile}}',
  titleEn: null,
  bodyEn: null,
};

describe('values reaching Telegram as HTML are escaped', () => {
  it('escapes a plan name that looks like a tag', async () => {
    const service = buildService();

    const rendered = await service.renderFromTemplate(
      TEMPLATE,
      { plan: 'Pro <Max>', profile: 'rz_1' },
      'Иван',
      'ru',
    );

    assert.equal(rendered.html.includes('<Max>'), false);
    assert.equal(rendered.html.includes('Pro &lt;Max&gt;'), true);
  });

  it('escapes an ampersand, which is the quieter half of the same bug', async () => {
    const service = buildService();

    const rendered = await service.renderFromTemplate(
      TEMPLATE,
      { plan: 'A&B', profile: 'rz_1' },
      'Иван',
      'ru',
    );

    assert.equal(rendered.html.includes('A&amp;B'), true);
  });

  it('escapes the customer name, which nobody types and anybody can set', async () => {
    const service = buildService();

    const rendered = await service.renderFromTemplate(
      TEMPLATE,
      { plan: 'Standard', profile: 'rz_1' },
      '<script>',
      'ru',
    );

    assert.equal(rendered.html.includes('<script>'), false);
  });

  it('leaves the template’s own markup alone', async () => {
    // THE constraint that rules out escaping the whole body. Operators author
    // markup here, and the emoji pass emits `<tg-emoji>` tags after this runs.
    const service = buildService();

    const rendered = await service.renderFromTemplate(
      TEMPLATE,
      { plan: 'Standard', profile: 'rz_1' },
      'Иван',
      'ru',
    );

    assert.equal(rendered.html.includes('<b>Тариф:</b>'), true);
  });

  it('keeps the plain body unescaped, because it is not parsed as HTML', async () => {
    // The cabinet feed and web-push render text, not markup. Escaping there
    // would show the customer a literal `&lt;` — the mirror-image defect.
    const service = buildService();

    const rendered = await service.renderFromTemplate(
      TEMPLATE,
      { plan: 'Pro <Max>', profile: 'rz_1' },
      'Иван',
      'ru',
    );

    assert.equal(rendered.body.includes('Pro <Max>'), true);
  });
});
