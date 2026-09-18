import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveRequestTimeoutMs } from '../src/common/middleware/request-timeout.middleware';

describe('request timeout route policy', () => {
  it('gives FAQ media uploads the long upload timeout', () => {
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/uploads'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/uploads?locale=ru'), 120_000);
  });

  it('does not widen similarly named FAQ routes', () => {
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/uploads-extra'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/faq/faq-1'), 30_000);
  });

  it('preserves infinite stream timeouts', () => {
    assert.equal(resolveRequestTimeoutMs('/api/internal/user/123/stream'), null);
    assert.equal(resolveRequestTimeoutMs('/api/realtime'), null);
  });

  it('exempts CUID reiwa_id streams, not just numeric telegramIds', () => {
    // The cabinet prefers the WebSession reiwa_id, so most live streams
    // carry a CUID rather than a telegramId.
    assert.equal(
      resolveRequestTimeoutMs('/api/internal/user/clzk3q8s90000abcd1234efgh/stream'),
      null,
    );
  });

  it('does not widen similarly named internal routes', () => {
    assert.equal(resolveRequestTimeoutMs('/api/internal/user/123/streaming'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/internal/user/123/devices'), 30_000);
  });

  it('gives BOTH restore routes the long upload timeout', () => {
    // The two shapes differ and the old pattern only covered one of them:
    // `restore/:filename` ends in a slash, `restore-upload` ends at the path
    // end, so the upload route fell through to the 30s default. The edge
    // proxies advertise `client_max_body_size 2g` for exactly that path and the
    // controller accepts 1 GiB by default / 2 GiB hard, so the ceiling everyone
    // else agreed on was undone here by three characters -- and the failure
    // reads as a network fault, not as a policy the app applied to itself.
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restore-upload'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restore-upload?force=1'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restore/dump.sql.gz'), 120_000);
  });

  it('gives the plan migration start, preview and retry the long timeout the delete dialog waits', () => {
    // At 30 s the app answered 408 while the start went on and committed, and
    // the first preview page of a large plan could never finish.
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations/preview'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations/preview?x=1'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations/cmf2run/retry'), 120_000);
  });

  it('keeps the migration reads the dialog polls at the default', () => {
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations/current'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations/cmf2run'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations/cmf2run?problemsCursor=abc'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/subscriptions?limit=50'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan/migrations/preview-extra'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/plans/cmf1plan'), 30_000);
  });

  it('gives a manual rule run the long timeout, because the operator waits for every action', () => {
    // POST /admin/automations/rules/:id/run. An audience action raising a hint
    // for up to five hundred customers, or a few 10 s webhooks, outlast thirty
    // seconds — and the 408 arrived while the run went on and was recorded.
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules/cmf1rule/run'), 120_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules/cmf1rule/run?trace=1'), 120_000);
  });

  it('keeps the rule routes beside the run at the default', () => {
    // GET and PUT rules/:id, PATCH rules/:id/toggle, GET rules/:id/executions —
    // and a path that only starts like the run.
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules/cmf1rule'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules/cmf1rule/toggle'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules/cmf1rule/executions'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules/cmf1rule/executions?limit=50'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules/cmf1rule/run-extra'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/rules'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/automations/executions'), 30_000);
  });

  it('does not widen similarly named backup routes', () => {
    // The widened pattern must not swallow a neighbour: `restored-*` shares the
    // prefix, and the settings/list routes are ordinary JSON.
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/restored-elsewhere'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup/settings'), 30_000);
    assert.equal(resolveRequestTimeoutMs('/api/admin/backup'), 30_000);
  });
});
