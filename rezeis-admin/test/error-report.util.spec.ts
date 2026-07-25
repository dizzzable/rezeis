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
