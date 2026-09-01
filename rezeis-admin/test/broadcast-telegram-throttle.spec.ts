import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { retryAfterSecondsOf } from '../src/modules/broadcast/services/broadcast-delivery.service';

/**
 * A Telegram 429 means "you are going too fast", and it says how long to wait.
 *
 * It used to be handled as an ordinary refusal: the recipient was marked FAILED
 * and the loop carried on at the same rate, so every recipient after the first
 * throttle collected the same refusal. The faster the send, the more people
 * were recorded permanently undeliverable — all of them reachable a second
 * later. Reading the interval is what turns that into a pause.
 */

describe('reading the pause out of a Telegram refusal', () => {
  it('takes the documented parameters.retry_after', () => {
    assert.equal(
      retryAfterSecondsOf('{"ok":false,"error_code":429,"parameters":{"retry_after":17}}'),
      17,
    );
  });

  it('falls back to the number in the description', () => {
    // Some endpoints on older Bot API versions send only this.
    assert.equal(
      retryAfterSecondsOf('{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 23"}'),
      23,
    );
  });

  it('pauses briefly on a 429 that names no interval', () => {
    // Still a throttle. Returning null here would put it back on the path that
    // marks the recipient permanently failed.
    assert.equal(retryAfterSecondsOf('{"ok":false,"error_code":429}'), 1);
  });

  it('caps a preposterous interval instead of parking the worker', () => {
    assert.equal(
      retryAfterSecondsOf('{"ok":false,"error_code":429,"parameters":{"retry_after":86400}}'),
      60,
    );
  });

  it('is silent about every refusal that is NOT a throttle', () => {
    // The distinction is the whole point: 403 "bot was blocked" is a real,
    // terminal failure and must stay one. Pausing and retrying those would
    // slow every send to a crawl over recipients who will never receive.
    for (const body of [
      '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
      '{"ok":false,"error_code":400,"parameters":{"retry_after":5}}',
      'not json at all',
      '',
      'null',
    ]) {
      assert.equal(retryAfterSecondsOf(body), null, `treated as a throttle: ${body}`);
    }
  });

  it('survives a hostile or malformed interval', () => {
    // The value comes off the wire. A NaN would become a NaN-millisecond sleep
    // (immediate) and a negative one is meaningless; neither should throw.
    assert.equal(retryAfterSecondsOf('{"error_code":429,"parameters":{"retry_after":"soon"}}'), 1);
    assert.equal(retryAfterSecondsOf('{"error_code":429,"parameters":{"retry_after":-5}}'), 1);
    assert.equal(retryAfterSecondsOf('{"error_code":429,"parameters":{"retry_after":0.4}}'), 1);
  });
});
