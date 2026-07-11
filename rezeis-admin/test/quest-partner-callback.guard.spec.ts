import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWebhookSignature } from '../src/common/http/webhook-signature.util';
import { QuestPartnerCallbackGuard } from '../src/modules/quests/guards/quest-partner-callback.guard';

const REZEIS_SIGNATURE_HEADER = 'x-rezeis-signature';

function makeGuard(cfg: {
  secret?: string | null;
  nonceClaimed?: boolean;
}) {
  const partnerService = {
    resolveCallbackSecret: async (_questId: string, slug: string) =>
      slug === 'acme' ? (cfg.secret ?? 'partner-secret') : null,
  };
  const cache = { claimOnce: async () => cfg.nonceClaimed ?? true };
  return new QuestPartnerCallbackGuard(partnerService as never, cache as never);
}

function makeCtx(rawBody: string, header: string | undefined) {
  const req = {
    rawBody: Buffer.from(rawBody, 'utf8'),
    headers: header === undefined ? {} : { [REZEIS_SIGNATURE_HEADER]: header },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

const body = JSON.stringify({ partnerSlug: 'acme', questId: 'cmphfcr6i007v01jg0lcu653h', telegramId: '42', nonce: 'n-1' });

describe('QuestPartnerCallbackGuard', () => {
  it('accepts a correctly signed, fresh, first-seen callback', async () => {
    const guard = makeGuard({});
    const { header } = buildWebhookSignature({ secret: 'partner-secret', body });
    const ok = await guard.canActivate(makeCtx(body, header));
    assert.equal(ok, true);
  });

  it('rejects an unknown partner slug (no secret)', async () => {
    const guard = makeGuard({});
    const evilBody = JSON.stringify({ partnerSlug: 'evil', questId: 'cmphfcr6i007v01jg0lcu653h', telegramId: '42', nonce: 'n-1' });
    const { header } = buildWebhookSignature({ secret: 'partner-secret', body: evilBody });
    await assert.rejects(() => guard.canActivate(makeCtx(evilBody, header)));
  });

  it('rejects a bad signature', async () => {
    const guard = makeGuard({});
    const { header } = buildWebhookSignature({ secret: 'WRONG-secret', body });
    await assert.rejects(() => guard.canActivate(makeCtx(body, header)));
  });

  it('rejects a missing signature header', async () => {
    const guard = makeGuard({});
    await assert.rejects(() => guard.canActivate(makeCtx(body, undefined)));
  });

  it('rejects a replayed nonce (claimOnce returns false)', async () => {
    const guard = makeGuard({ nonceClaimed: false });
    const { header } = buildWebhookSignature({ secret: 'partner-secret', body });
    await assert.rejects(() => guard.canActivate(makeCtx(body, header)));
  });

  it('rejects a callback with no raw body', async () => {
    const guard = makeGuard({});
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as never;
    await assert.rejects(() => guard.canActivate(ctx));
  });
});
