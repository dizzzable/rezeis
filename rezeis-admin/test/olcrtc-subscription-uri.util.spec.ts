import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOlcrtcSubscriptionText,
  buildOlcrtcSubscriptionUri,
} from '../src/modules/olcrtc/utils/olcrtc-subscription-uri.util';

test('buildOlcrtcSubscriptionUri maps provider and transport names', () => {
  const uri = buildOlcrtcSubscriptionUri({
    provider: 'JITSI',
    transport: 'VP8CHANNEL',
    roomId: 'https://meet.jit.si/rezeis-room',
    cryptoKey: 'crypto-key',
    name: 'Restricted profile',
    transportOptions: { fps: 12, batchSize: 4 },
  });

  assert.equal(
    uri,
    'olcrtc://jitsi?vp8channel<vp8-fps=12&vp8-batch=4>@https://meet.jit.si/rezeis-room#crypto-key$Restricted profile',
  );
});

test('buildOlcrtcSubscriptionUri omits unknown empty transport options', () => {
  const uri = buildOlcrtcSubscriptionUri({
    provider: 'TELEMOST',
    transport: 'DATACHANNEL',
    roomId: 'room-id',
    cryptoKey: 'crypto-key',
    name: 'Telemost profile',
    transportOptions: { fps: 30 },
  });

  assert.equal(uri, 'olcrtc://telemost?datachannel@room-id#crypto-key$Telemost profile');
});

test('buildOlcrtcSubscriptionText wraps the uri with client metadata', () => {
  const text = buildOlcrtcSubscriptionText('olcrtc://jitsi?datachannel@room#key$name', 'OLC', 120);

  assert.equal(
    text,
    '#name: OLC\n#update: 2147483647\n#refresh: 120\nolcrtc://jitsi?datachannel@room#key$name',
  );
});
