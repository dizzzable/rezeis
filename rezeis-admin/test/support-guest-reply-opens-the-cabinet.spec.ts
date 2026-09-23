import 'reflect-metadata';

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { Logger } from '@nestjs/common';

import { advertisingConfig } from '../src/common/config/advertising.config';
import { ReiwaAdvertisingLinkConfigService } from '../src/modules/advertising/services/reiwa-advertising-link-config.service';
import { SupportNotificationsService } from '../src/modules/support-tickets/services/support-notifications.service';

/**
 * «ОТКРЫТЬ ПЕРЕПИСКУ» IN THE GUEST-REPLY EMAIL OPENS THE CONVERSATION IN THE CABINET.
 *
 * A visitor who wrote to support from the site without signing in, and left an
 * email, is sent «Поддержка ответила на ваше обращение» when an operator
 * replies. The letter is meant to carry a button back into that conversation:
 * the cabinet's `/support/guest?resume=<token>` page, where the token — issued
 * by the panel for this very email — restores the thread on any device.
 *
 * The button's address was read from `brandingSettings.websiteUrl`, which
 * nothing in the product writes: no form, no DTO field, not in the branding
 * reader. So on every install the letter went out without the button, and the
 * visitor had no way back but to find the chat on the site again.
 *
 * The address is now the cabinet's, from the ONE resolver the ad links and the
 * letter footer use (`ReiwaAdvertisingLinkConfigService`): what the cabinet
 * publishes first, then `REIWA_WEB_BASE_URL` → `MINIAPP_CUSTOM_URL`. Both of
 * those ship commented out, so reading .env alone left a default install with
 * no button at all. With no address anywhere there is still no button — and
 * never the panel's own domain.
 *
 * The letter carries a live way into a conversation, so it is sent directly
 * and never parked in the mail queue (Redis keeps a job for a day, a failed
 * one for a week) — as password-reset links are. Directly, but not once: a
 * transient SMTP failure is retried in-process, and the new link replaces the
 * previous letter's only once a letter carrying it actually went out.
 */

const PANEL = 'panel.example.com';
const originalEnvironment = process.env;
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env = originalEnvironment;
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

interface Install {
  /** The panel's .env besides REZEIS_DOMAIN. */
  readonly env?: Record<string, string>;
  /** What the cabinet's `/api/v1/public-config` says; `null`: it cannot be reached. */
  readonly published?: string | null;
  /** The branding row, whatever an install really holds. */
  readonly brandingSettings?: Record<string, unknown>;
  /** SMTP as the SMTP card has it; on unless said otherwise. */
  readonly smtp?: 'on' | 'off';
  /**
   * The guest's access (`expiresAt`: the TTL from the conversation's start or
   * from the last operator reply) had ended before this reply.
   */
  readonly guestExpired?: boolean;
  /** Renewing the access on this reply (`extendAccessOnOperatorReply`) fails. */
  readonly renewalFails?: boolean;
  readonly ticketStatus?: 'OPEN' | 'WAITING_REPLY' | 'CLOSED';
  /** Send attempts that fail before one succeeds; `Infinity`: none ever does. */
  readonly failingAttempts?: number;
  /** A failing attempt throws instead of answering `success: false`. */
  readonly failureThrows?: boolean;
  /** Storing the new link fails after the letter went out. */
  readonly activationFails?: boolean;
}

interface Outcome {
  /** Every attempt to hand the letter to the mail server. */
  readonly attempts: Array<{ readonly to: string; readonly rawHtml?: string }>;
  /** The letter that went out, if one did. */
  readonly delivered: Array<{ readonly to: string; readonly rawHtml?: string }>;
  /** Letters handed to the BullMQ mail queue instead. */
  readonly queued: number;
  /** Letter tokens minted — nothing is written for these. */
  readonly minted: number;
  /** Tokens made THE letter link; each retires the previous letter's link. */
  readonly activated: string[];
  /** 'renewed', 'sent', 'failed' and 'activated', in the order they happened. */
  readonly events: string[];
  /** Each renewal of the guest's access this reply asked for, and whether it took. */
  readonly renewals: boolean[];
  readonly warnings: string[];
}

/**
 * The service over `install`, and an outcome that fills in as it runs. The
 * retry schedule is left as the service has it; {@link guestReply} shortens it.
 */
function buildGuestReply(install: Install = {}): { service: SupportNotificationsService; outcome: Outcome } {
  process.env = { ...originalEnvironment, REZEIS_DOMAIN: PANEL };
  delete process.env.REIWA_WEB_BASE_URL;
  delete process.env.MINIAPP_CUSTOM_URL;
  Object.assign(process.env, install.env ?? {});
  const published = install.published ?? null;
  globalThis.fetch = async () => {
    if (published === null) throw new Error('reiwa is offline');
    return new Response(JSON.stringify({ webBaseUrl: published }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const warnings: string[] = [];
  mock.method(Logger.prototype, 'warn', (message: unknown) => {
    warnings.push(String(message));
  });

  const attempts: Array<{ to: string; rawHtml?: string }> = [];
  const delivered: Array<{ to: string; rawHtml?: string }> = [];
  const activated: string[] = [];
  const events: string[] = [];
  let queued = 0;
  let minted = 0;
  const failing = install.failingAttempts ?? 0;
  const activate = async (_guestId: string, token: string) => {
    if (install.activationFails) return 'failed' as const;
    activated.push(token);
    events.push('activated');
    return 'activated' as const;
  };
  // The guest's access as the database holds it; an operator reply renews it
  // (the real rule: not on a CLOSED conversation), unless the renewal fails.
  let accessEnded = install.guestExpired ?? false;
  const renewals: boolean[] = [];
  const service = new SupportNotificationsService(
    {} as never,
    {
      supportTicket: {
        findUnique: async () => ({
          subject: 'Оплата',
          status: install.ticketStatus ?? 'WAITING_REPLY',
          guestId: 'g-1',
          guest: {
            id: 'g-1',
            email: 'visitor@example.com',
            expiresAt: new Date(Date.now() + (accessEnded ? -60_000 : 3_600_000)),
          },
        }),
      },
      settings: { findFirst: async () => ({ brandingSettings: install.brandingSettings ?? {} }) },
    } as never,
    {
      getSmtpSettings: async () => ({ enabled: install.smtp !== 'off', host: 'smtp.example.com' }),
      send: async () => {
        queued += 1;
      },
      sendImmediate: async (payload: { to: string; rawHtml?: string }) => {
        attempts.push(payload);
        if (attempts.length <= failing) {
          events.push('failed');
          if (install.failureThrows) throw new Error('connection reset');
          return { success: false, error: 'Connection timeout' };
        }
        delivered.push(payload);
        events.push('sent');
        return { success: true };
      },
    } as never,
    {
      newEmailResumeToken: () => {
        minted += 1;
        return 'resume-tok';
      },
      // An unstamped stand-in token: no pinned `Date` (the letter-order spec
      // covers dating, with the real service).
      letterTokenIssuedAt: () => null,
      // The real rule lives in `support-guest-access-extends-on-reply.spec.ts`.
      extendAccessOnOperatorReply: async () => {
        const renewed = !install.renewalFails && install.ticketStatus !== 'CLOSED';
        if (renewed) accessEnded = false;
        renewals.push(renewed);
        events.push('renewed');
        return renewed;
      },
      activateEmailResumeToken: activate,
    } as never,
    { getByType: async () => null } as never,
    new ReiwaAdvertisingLinkConfigService(advertisingConfig()),
  );
  const outcome: Outcome = {
    attempts,
    delivered,
    get queued() {
      return queued;
    },
    get minted() {
      return minted;
    },
    activated,
    events,
    renewals,
    warnings,
  };
  return { service, outcome };
}

async function guestReply(install: Install = {}): Promise<Outcome> {
  const { service, outcome } = buildGuestReply(install);
  // The retries' pauses, shortened: what is under test here is how many
  // attempts there are and what happens between them. The schedule itself
  // is pinned by «the retry schedule» below, on the service's own value.
  (service as unknown as { guestLetterRetryDelaysMs: readonly number[] }).guestLetterRetryDelaysMs = [0, 0];
  await service.notifyGuestReply('t-1');
  return outcome;
}

/** The one letter the guest got, as sent. */
async function guestReplyLetter(install: Install = {}): Promise<string> {
  const outcome = await guestReply(install);
  assert.equal(outcome.delivered.length, 1, 'no letter was sent');
  return outcome.delivered[0].rawHtml ?? '';
}

describe('the guest-reply email', () => {
  it('opens the conversation at the address the cabinet publishes, with nothing in .env', async () => {
    // The default install: the .env pair is commented out, and the cabinet
    // publishes its own address — the one the ad links already use.
    const html = await guestReplyLetter({ published: 'https://cab.example.com/' });

    assert.ok(
      html.includes('href="https://cab.example.com/support/guest?resume=resume-tok"'),
      `no button into the conversation: ${html}`,
    );
    assert.ok(html.includes('Открыть переписку'));
  });

  it('prefers the published address over a stale one in .env, as the ads do', async () => {
    const html = await guestReplyLetter({
      env: { REIWA_WEB_BASE_URL: 'https://old.example.com' },
      published: 'https://cab.example.com',
    });

    assert.ok(html.includes('href="https://cab.example.com/support/guest?resume=resume-tok"'), html);
    assert.ok(!html.includes('old.example.com'), html);
  });

  it('opens the conversation at the .env address when the cabinet cannot be asked', async () => {
    const html = await guestReplyLetter({ env: { REIWA_WEB_BASE_URL: 'https://app.example.com' } });

    assert.ok(
      html.includes('href="https://app.example.com/support/guest?resume=resume-tok"'),
      `no button into the conversation: ${html}`,
    );
  });

  it('uses the Mini App address when the cabinet has no separate one', async () => {
    const html = await guestReplyLetter({ env: { MINIAPP_CUSTOM_URL: 'https://mini.example.com/' } });

    assert.ok(html.includes('href="https://mini.example.com/support/guest?resume=resume-tok"'), html);
  });

  it('carries no button, and never the panel, when no cabinet address is known', async () => {
    const outcome = await guestReply();
    const html = outcome.delivered[0]?.rawHtml ?? '';

    assert.equal(outcome.delivered.length, 1, 'the news itself must still go out');
    assert.ok(!html.includes('<a '), `a button with nowhere to go: ${html}`);
    assert.ok(!html.includes(PANEL));
    // No link to put it in, so no token.
    assert.equal(outcome.minted, 0);
    assert.deepEqual(outcome.activated, []);
  });

  it('talks about the button only when it has one', async () => {
    // «Нажмите кнопку ниже» over nothing: the letter used to say it on every
    // install, because no install ever got the button.
    const withButton = await guestReplyLetter({ env: { REIWA_WEB_BASE_URL: 'https://app.example.com' } });
    const withoutButton = await guestReplyLetter();

    assert.match(withButton, /Нажмите кнопку ниже/);
    assert.doesNotMatch(withoutButton, /кнопк/i, `the letter points at a button it does not have: ${withoutButton}`);
    // Still the news itself, and where the reply is waiting.
    assert.match(withoutButton, /По вашему обращению «Оплата» есть новый ответ от поддержки/);
    assert.match(withoutButton, /чате поддержки на сайте/);
  });

  it('does not take its address from the branding row', async () => {
    // `websiteUrl` is written by nothing; a value found there is not the cabinet.
    const html = await guestReplyLetter({ brandingSettings: { websiteUrl: `https://${PANEL}` } });

    assert.ok(!html.includes(PANEL), `the letter points at ${PANEL}`);
  });
});

/**
 * A guest's access ends `guestTokenTtlHours` after the conversation started or
 * after the last operator reply, and a CLOSED conversation opens for no token.
 * Past either, the letter's link, the device credential and the guest's own
 * code all open nothing — so a button there is a dead end, and «Нажмите кнопку
 * ниже» a false promise. Since each operator reply renews the access first,
 * that leaves a closed conversation, and a renewal that failed.
 */
describe('the guest-reply email to a guest whose access had ended', () => {
  it('renews the access FIRST, so the letter carries a working button', async () => {
    // The owner's example: answered 74 h after the conversation opened.
    const outcome = await guestReply({ published: 'https://cab.example.com', guestExpired: true });
    const html = outcome.delivered[0]?.rawHtml ?? '';

    assert.equal(outcome.events[0], 'renewed', `the letter was composed before the renewal: ${outcome.events}`);
    assert.deepEqual(outcome.renewals, [true]);
    assert.ok(html.includes('href="https://cab.example.com/support/guest?resume=resume-tok"'), html);
    assert.deepEqual(outcome.activated, ['resume-tok']);
  });

  it('renews it even when no letter goes out (SMTP off)', async () => {
    const outcome = await guestReply({ published: 'https://cab.example.com', guestExpired: true, smtp: 'off' });

    assert.deepEqual(outcome.renewals, [true]);
    assert.equal(outcome.attempts.length, 0);
  });
});

describe('the guest-reply email to a guest who can no longer open the conversation', () => {
  for (const [why, install] of [
    ['whose access had ended and could not be renewed', { guestExpired: true, renewalFails: true }],
    ['whose conversation is closed', { ticketStatus: 'CLOSED' }],
  ] as const) {
    it(`carries no button and no token, and says so — to a guest ${why}`, async () => {
      const outcome = await guestReply({ published: 'https://cab.example.com', ...install });
      const html = outcome.delivered[0]?.rawHtml ?? '';

      assert.equal(outcome.delivered.length, 1, 'the guest was not told there is a reply');
      assert.ok(!html.includes('<a '), `a button that opens nothing: ${html}`);
      assert.doesNotMatch(html, /кнопк/i, html);
      assert.doesNotMatch(html, /ждёт вас в чате/, 'the letter promises the chat it cannot open');
      assert.match(html, /По вашему обращению «Оплата» есть новый ответ от поддержки/);
      assert.match(html, /открыть переписку на сайте больше нельзя/i, html);
      assert.equal(outcome.minted, 0);
      assert.deepEqual(outcome.activated, []);
    });
  }
});

describe('how the guest-reply email travels', () => {
  it('goes to the mail server directly and never through the mail queue', async () => {
    // The queue keeps a completed job in Redis for a day and a failed one for
    // a week, and the letter's link is a way into the conversation.
    const outcome = await guestReply({ published: 'https://cab.example.com' });

    assert.equal(outcome.queued, 0, 'the letter with a live link was parked in the queue');
    assert.equal(outcome.delivered.length, 1);
    assert.equal(outcome.delivered[0].to, 'visitor@example.com');
  });

  it('with SMTP off, does nothing at all: no letter, no token, no write, no warning', async () => {
    // SMTP is off on a default install; the reply to a guest who left an
    // email used to mint a link, write it, and warn on every reply.
    const outcome = await guestReply({ published: 'https://cab.example.com', smtp: 'off' });

    assert.equal(outcome.attempts.length, 0);
    assert.equal(outcome.minted, 0);
    assert.deepEqual(outcome.activated, []);
    assert.deepEqual(outcome.warnings, []);
  });

  it('retries a transient failure, and the link is switched only after the letter went out', async () => {
    const outcome = await guestReply({ published: 'https://cab.example.com', failingAttempts: 2 });

    assert.equal(outcome.attempts.length, 3, 'a transient failure was not retried');
    assert.equal(outcome.delivered.length, 1);
    assert.deepEqual(outcome.events, ['renewed', 'failed', 'failed', 'sent', 'activated']);
    assert.deepEqual(outcome.activated, ['resume-tok']);
    assert.deepEqual(outcome.warnings, []);
  });

  it('retries a send that throws, the same as one that fails', async () => {
    const outcome = await guestReply({ published: 'https://cab.example.com', failingAttempts: 1, failureThrows: true });

    assert.equal(outcome.delivered.length, 1);
    assert.deepEqual(outcome.activated, ['resume-tok']);
  });

  it('keeps the previous letter’s link working when no letter went out, and says so once', async () => {
    const outcome = await guestReply({ published: 'https://cab.example.com', failingAttempts: Infinity });

    assert.equal(outcome.attempts.length, 3, 'it gave up before the retries');
    assert.equal(outcome.delivered.length, 0);
    assert.deepEqual(outcome.activated, [], 'a letter that never arrived retired the previous one’s link');
    assert.equal(outcome.warnings.length, 1, outcome.warnings.join(' | '));
  });

  it('keeps the previous link when storing the new one fails after the letter went out', async () => {
    // The only way the new link can be missing is after its letter left: then
    // the older letter's link is the one that still works, and it is logged.
    const outcome = await guestReply({ published: 'https://cab.example.com', activationFails: true });

    assert.equal(outcome.delivered.length, 1);
    assert.equal(outcome.warnings.length, 1, outcome.warnings.join(' | '));
  });

  it('never fails the operator reply, whatever the mail server does', async () => {
    await assert.doesNotReject(guestReply({ published: 'https://cab.example.com', failingAttempts: Infinity }));
    await assert.doesNotReject(
      guestReply({ published: 'https://cab.example.com', failingAttempts: Infinity, failureThrows: true }),
    );
  });
});

/**
 * The schedule the service really runs, on fake timers. Every other case
 * shortens it to `[0, 0]`, so the production value was read by nothing, and
 * setting it to `[]` — one attempt, the retries gone — passed them all.
 */
describe('the retry schedule of the guest letter', () => {
  /** Lets every pending step run to its next wait, without moving the fake clock. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  it('is three attempts: the second 5 s after the first fails, the third 30 s after the second', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { service, outcome } = buildGuestReply({ published: 'https://cab.example.com', failingAttempts: Infinity });
      const done = service.notifyGuestReply('t-1');
      await flush();
      assert.equal(outcome.attempts.length, 1, 'the first attempt did not start at once');

      mock.timers.tick(4_999);
      await flush();
      assert.equal(outcome.attempts.length, 1, 'the second attempt came before 5 s');
      mock.timers.tick(1);
      await flush();
      assert.equal(outcome.attempts.length, 2, 'no second attempt 5 s after the first');

      mock.timers.tick(29_999);
      await flush();
      assert.equal(outcome.attempts.length, 2, 'the third attempt came before 30 more seconds');
      mock.timers.tick(1);
      await flush();
      assert.equal(outcome.attempts.length, 3, 'no third attempt 30 s after the second');

      mock.timers.tick(10 * 60_000);
      await flush();
      await done;
      assert.equal(outcome.attempts.length, 3, 'more than three attempts');
      assert.equal(outcome.warnings.length, 1, outcome.warnings.join(' | '));
    } finally {
      mock.timers.reset();
    }
  });
});
