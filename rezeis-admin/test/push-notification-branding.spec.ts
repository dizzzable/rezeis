import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pushSafeIconUrl } from '../src/modules/push/services/web-push.service';

/**
 * WHICH BRAND MARK MAY TRAVEL IN A PUSH PAYLOAD.
 *
 * A push notification is drawn by the service worker, a static asset built
 * long before the operator uploaded anything. It cannot know the brand unless
 * the payload carries it, so until 2026-08-24 every subscriber saw the stock
 * bundle icon and the stock product name whatever the operator had configured.
 * The report came with a screenshot of a notification reading `Reiwa`.
 *
 * Sending the configured value is not enough, and the two ways it is not
 * enough are the whole reason this function exists:
 *
 *   • `data:` — a branding image may legitimately be stored inline, up to
 *     524288 characters by the settings DTO. A Web Push payload is capped near
 *     4 KB ENCRYPTED. Putting one in the payload does not produce an unbranded
 *     notification, it produces NO notification: the push service rejects it.
 *     Strictly worse than the bug being fixed.
 *
 *   • SVG — and this is the one that would have shipped. The operator who
 *     reported it had a 1024x1024 SVG in `logoUrl`. The Android notification
 *     shade decodes raster only, so passing that path yields a change that
 *     looks correct, reviews clean, and leaves the notification exactly as
 *     unbranded as before. A fix that cannot be observed is not a fix.
 *
 * When nothing survives, the answer is `null` and the bundled mark stands.
 */
describe('a brand mark may travel in a push payload only if it can arrive AND render', () => {
  it('passes the ordinary case — an uploaded raster, as a path', () => {
    // The good shape, and the common one: a handful of bytes, and the service
    // worker resolves it against ITS OWN origin, so the subscriber fetches the
    // logo from the cabinet it is already talking to rather than the panel.
    assert.equal(
      pushSafeIconUrl('/uploads/branding/a43d1b5dd60de97d040368187b686c24.png'),
      '/uploads/branding/a43d1b5dd60de97d040368187b686c24.png',
    );
  });

  it('passes an absolute https mark', () => {
    assert.equal(pushSafeIconUrl('https://cdn.example.test/mark.png'), 'https://cdn.example.test/mark.png');
  });

  it('refuses SVG — the notification shade cannot decode it', () => {
    // THE PRODUCTION CASE, exactly as configured: 1024x1024 SVG in `logoUrl`.
    assert.equal(pushSafeIconUrl('/uploads/branding/a43d1b5dd60de97d040368187b686c24.svg'), null);
  });

  it('refuses SVG behind a query or a fragment', () => {
    // Cache-busting suffixes are ordinary on an uploads path, and an extension
    // test anchored to end-of-string would let every one of them through.
    assert.equal(pushSafeIconUrl('/uploads/branding/mark.svg?v=3'), null);
    assert.equal(pushSafeIconUrl('/uploads/branding/mark.svgz#a'), null);
  });

  it('refuses a data: URI — it would cost the notification, not the icon', () => {
    const inlineMark = `data:image/png;base64,${'A'.repeat(4096)}`;
    assert.equal(pushSafeIconUrl(inlineMark), null);
  });

  it('refuses a short data: URI too, on shape rather than on size', () => {
    // ANTI-VACUITY for the case above: a length-only rule would pass this one
    // and then admit a 3 KB inline mark that still blows the payload once the
    // rest of the JSON and the encryption overhead are counted.
    assert.equal(pushSafeIconUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw='), null);
  });

  it('refuses anything long enough to threaten the payload budget', () => {
    assert.equal(pushSafeIconUrl(`/uploads/branding/${'x'.repeat(600)}.png`), null);
  });

  it('answers null for absent, empty and blank values', () => {
    assert.equal(pushSafeIconUrl(null), null);
    assert.equal(pushSafeIconUrl(undefined), null);
    assert.equal(pushSafeIconUrl(''), null);
    assert.equal(pushSafeIconUrl('   '), null);
  });

  it('does not refuse a mark merely for having svg in its NAME', () => {
    // ANTI-VACUITY. "Reject anything containing svg" would pass every refusal
    // above while quietly dropping a legitimate raster, and the operator would
    // be back to the unbranded notification with no way to tell why.
    assert.equal(pushSafeIconUrl('/uploads/branding/svg-export.png'), '/uploads/branding/svg-export.png');
  });
});
