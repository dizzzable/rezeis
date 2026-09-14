import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatErrorEventCardHtml,
  formatErrorReportTxt,
  type ErrorReportEvent,
} from '../src/common/services/error-report.util';

const build = { version: '0.9.6.63', commit: '517e1906cf8d', branch: 'main' };

function browserError(metadata: Record<string, unknown> = {}): ErrorReportEvent {
  return {
    kind: 'event.reiwa.error',
    severity: 'ERROR',
    category: 'SYSTEM',
    message: '[reiwa:web] Cannot read properties of undefined',
    timestamp: '2026-07-24T18:33:24.848Z',
    metadata: {
      source: 'web',
      surface: 'web',
      scope: 'web.window.onerror',
      filename: 'https://telegram.org/js/telegram-web-app.js',
      lineno: 314,
      colno: 12,
      errorName: 'TypeError',
      ...metadata,
    },
  };
}

describe('error report formatter', () => {
  it('renders browser source location in both the Telegram card and attachment', () => {
    const event = browserError();
    const card = formatErrorEventCardHtml(event, build, true);
    const text = formatErrorReportTxt(event, build);

    assert.ok(card.includes('telegram.org/js/telegram-web-app.js'));
    assert.ok(card.includes('строка 314, столбец 12'));
    assert.ok(card.includes('TypeError'));
    assert.ok(text.includes('https://telegram.org/js/telegram-web-app.js'));
    assert.ok(text.includes('314:12'));
  });

  it('keeps a sparse cross-origin error report renderable', () => {
    const card = formatErrorEventCardHtml(
      browserError({ filename: undefined, lineno: undefined, colno: undefined, errorName: undefined }),
      build,
      false,
    );

    assert.ok(!card.includes('📄 Файл:'));
    assert.ok(!card.includes('📍 Место:'));
  });

  it('does not call an unreachable upstream an unhandled 500', () => {
    // Emitted by the cabinet's error handler for `EAI_AGAIN` and friends
    // (`reiwa/src/api/app.ts`), which answers the subscriber 503 with
    // `Retry-After` — on purpose, see `reiwa/src/api/transient-upstream.ts`.
    // The API surface default said «необработанная ошибка… ошибкой 500» and sent
    // the operator looking for a crash in the cabinet.
    const event: ErrorReportEvent = {
      kind: 'event.reiwa.error',
      severity: 'ERROR',
      category: 'SYSTEM',
      message: '[reiwa:api] getaddrinfo EAI_AGAIN panel.example.com',
      timestamp: '2026-08-25T10:00:00.000Z',
      metadata: {
        source: 'api',
        scope: 'api.upstream-unreachable',
        path: '/api/v1/subscription',
        code: 'EAI_AGAIN',
      },
    };
    const card = formatErrorEventCardHtml(event, build, true);
    const text = formatErrorReportTxt(event, build);

    for (const [name, rendered] of [
      ['card', card],
      ['txt', text],
    ] as const) {
      assert.ok(!rendered.includes('ошибкой 500'), `${name} still claims a 500: ${rendered}`);
      assert.ok(!rendered.includes('Необработанная ошибка'), `${name} still claims a crash`);
      assert.ok(rendered.includes('503'), `${name} does not say what the subscriber got`);
      assert.ok(rendered.includes('повторить запрос'), `${name} does not mention the retry hint`);
      assert.ok(rendered.includes('EAI_AGAIN'), `${name} does not name the network code`);
    }
  });

  it('keeps the 500 explanation for an error the cabinet did not handle', () => {
    // The control: only the unreachable-upstream scope changed its words.
    const card = formatErrorEventCardHtml(
      {
        kind: 'event.reiwa.error',
        severity: 'ERROR',
        category: 'SYSTEM',
        message: '[reiwa:api] boom',
        timestamp: '2026-08-25T10:00:00.000Z',
        metadata: { source: 'api', scope: 'api.error-handler', path: '/api/v1/x' },
      },
      build,
      false,
    );
    assert.ok(card.includes('ошибкой 500'));
  });

  it('uses Reiwa build metadata instead of the panel build fallback', () => {
    const card = formatErrorEventCardHtml(
      browserError({
        service: 'reiwa',
        version: '0.9.6.54',
        commit: 'reiwa-commit-123456',
        branch: 'main',
      }),
      build,
      false,
    );
    assert.ok(card.includes('Сервис: <code>reiwa</code>'));
    assert.ok(card.includes('Версия: <code>0.9.6.54</code>'));
    assert.ok(card.includes('Коммит: <code>reiwa-commit-123456</code>'));
  });
});
