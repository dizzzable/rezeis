/**
 * Taking the operator to the control panel search found.
 *
 * The behaviour is deliberately tolerant — it gives up in silence — which is
 * also how it would rot unnoticed. These cases pin the three things that must
 * happen: it finds the control and marks it, it opens the tab the control is
 * behind, and it stops looking once the operator has gone somewhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flashTextOnPage } from './flash-on-page';

function outlineOf(id: string): string {
  return (document.getElementById(id) as HTMLElement).style.outline;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('flashTextOnPage', () => {
  it('marks the control whose label was searched for', () => {
    document.body.innerHTML =
      '<div><span id="other">Другая подпись</span><label id="target">ID кассы (terminal_id)</label></div>';

    flashTextOnPage('ID кассы (terminal_id)');
    vi.advanceTimersByTime(200);

    expect(outlineOf('target')).not.toBe('');
    expect(outlineOf('other')).toBe('');
  });

  it('waits for a page that has not rendered yet', () => {
    flashTextOnPage('Автоплатежи одобрены провайдером');
    vi.advanceTimersByTime(600);

    document.body.innerHTML = '<label id="late">Автоплатежи одобрены провайдером</label>';
    vi.advanceTimersByTime(200);

    expect(outlineOf('late')).not.toBe('');
  });

  it('takes the mark off again', () => {
    document.body.innerHTML = '<label id="target">Резервные копии</label>';

    flashTextOnPage('Резервные копии');
    vi.advanceTimersByTime(200);
    expect(outlineOf('target')).not.toBe('');

    vi.advanceTimersByTime(3000);
    expect(outlineOf('target')).toBe('');
  });

  it('opens the tab the control is behind, and marks what is inside it', () => {
    document.body.innerHTML =
      '<button role="tab" id="tab" aria-selected="false">Вебхуки</button>' +
      '<div id="panel" hidden><span id="inside">Вебхуки</span></div>';
    const tab = document.getElementById('tab') as HTMLButtonElement;
    tab.addEventListener('click', () => {
      tab.setAttribute('aria-selected', 'true');
      (document.getElementById('panel') as HTMLElement).hidden = false;
    });

    flashTextOnPage('Вебхуки');
    vi.advanceTimersByTime(400);

    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(outlineOf('inside')).not.toBe('');
  });

  it('gives up quietly when the text never appears', () => {
    document.body.innerHTML = '<label id="target">Что-то другое</label>';

    flashTextOnPage('Чего тут нет');
    vi.advanceTimersByTime(10_000);

    expect(outlineOf('target')).toBe('');
  });

  it('stops looking once the operator has navigated away', () => {
    flashTextOnPage('Резервные копии');
    vi.advanceTimersByTime(200);

    window.history.pushState({}, '', '/somewhere-else');
    document.body.innerHTML = '<label id="late">Резервные копии</label>';
    vi.advanceTimersByTime(1000);

    expect(outlineOf('late')).toBe('');
  });
});
