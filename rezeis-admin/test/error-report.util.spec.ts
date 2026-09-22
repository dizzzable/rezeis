import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatErrorEventCardHtml,
  formatErrorReportTxt,
  type ErrorReportEvent,
} from '../src/common/services/error-report.util';
import { clipHtmlCard } from '../src/common/services/system-events.service';

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

  it('sends the operator for the stack to a page that exists, not to «События»', () => {
    // No such page, and no per-event download either: the stack is in the
    // payload of the bulk export on the «Системные события» tab.
    const card = formatErrorEventCardHtml(browserError({ stack: 'TypeError: x\n    at y (z.js:1:1)' }), build, false);
    assert.ok(!card.includes('«События»'), card);
    assert.ok(card.includes('«Журнал аудита» → «Системные события» → «Скачать .txt»'), card);
    assert.ok(card.includes('«Прикреплять .txt-отчёт к сообщениям об ошибках в Telegram»'), card);
  });
});

describe('the incident card says whose it is', () => {
  // It printed no metadata at all, so a sync that failed for good, or a
  // refund owed to a partner, reached the operator without a name on it.
  function panelError(metadata: Record<string, unknown>): ErrorReportEvent {
    return {
      kind: 'event.system.error',
      severity: 'ERROR',
      category: 'SYSTEM',
      message: 'Profile sync failed: 400 Bad Request',
      timestamp: '2026-09-23T10:00:00.000Z',
      metadata,
    };
  }

  it('prints «👤 Пользователь» from what enrichment filled in, under «Почему это важно»', () => {
    const card = formatErrorEventCardHtml(
      panelError({
        userId: 'cuid-user-1',
        telegramId: '4242',
        userName: 'Анна <b>',
        username: 'anna',
        login: 'anna_web',
        why: 'Подписка не обновилась.',
      }),
      build,
      false,
    );
    const lines = card.split('\n');
    const block = lines.indexOf('👤 <b>Пользователь:</b>');
    assert.ok(block > lines.indexOf('❗ <b>Почему это важно:</b>'), card);
    assert.ok(block < lines.indexOf('🌀 <b>Контекст:</b>'), card);
    assert.equal(lines[block + 1], '<blockquote>🪪 Telegram ID: <code>4242</code>');
    assert.ok(card.includes('👾 Reiwa ID: <code>cuid-user-1</code>'));
    assert.ok(card.includes('👤 Имя: Анна &lt;b&gt; (@anna)'), 'escaped, with the handle');
    assert.ok(card.includes('🔑 Login: <code>anna_web</code>'));
  });

  it('prints nothing about a user when the event names none', () => {
    const card = formatErrorEventCardHtml(panelError({ why: 'Бэкап не создан.' }), build, false);
    assert.ok(!card.includes('Пользователь'), card);
  });
});

describe('the incident card puts what to do before the technical blocks', () => {
  // Sent as a document caption the card is clipped to 1024 characters from the
  // END — and «Что проверить дальше» used to be the end.
  const event: ErrorReportEvent = {
    kind: 'event.system.error',
    severity: 'ERROR',
    category: 'SYSTEM',
    message: `Profile sync failed: ${'x'.repeat(600)}`,
    timestamp: '2026-09-23T10:00:00.000Z',
    metadata: {
      userId: 'cuid-user-1',
      telegramId: '4242',
      userName: 'Анна',
      login: 'anna_web',
      why: 'Задача «обновление профиля» не прошла 5 раз подряд, и панель больше не повторяет её сама. '.repeat(2),
      nextSteps: 'Нажмите «Синхронизировать все» на вкладке «Подписки».',
    },
  };

  it('in this order: why, whose, what to do, then the error, the context and the build', () => {
    const card = formatErrorEventCardHtml(event, build, false);
    const at = (heading: string): number => card.indexOf(heading);
    const order = [
      '❗ <b>Почему это важно:</b>',
      '👤 <b>Пользователь:</b>',
      '🧭 <b>Что проверить дальше:</b>',
      '⚠️ <b>Ошибка:</b>',
      '🌀 <b>Контекст:</b>',
      '🏗 <b>Сборка:</b>',
    ].map(at);
    assert.ok(order.every((position) => position >= 0), card);
    assert.deepEqual([...order].sort((a, b) => a - b), order, card);
  });

  it('so a caption clipped to 1024 still carries «Что проверить дальше»', () => {
    const card = formatErrorEventCardHtml(event, build, true);
    assert.ok(card.length > 1024, 'the premise: this card needs clipping');
    const caption = clipHtmlCard(card, 1024);
    assert.ok(caption.length <= 1024);
    assert.ok(caption.includes('Нажмите «Синхронизировать все»'), caption);
  });
});
