import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapExternalSquadDetails,
  mapInternalSquadDetails,
} from '../src/modules/remnawave/services/remnawave-squad-mappers';

describe('mapInternalSquadDetails', () => {
  it('extracts member/inbound counters from the wrapped Remnawave 2.7.x payload', () => {
    const upstream = {
      response: {
        total: 2,
        internalSquads: [
          {
            uuid: 'aa',
            name: 'Default-Squad',
            viewPosition: 1,
            info: { membersCount: 0, inboundsCount: 1 },
            inbounds: [{ uuid: 'inb-1' }],
            createdAt: '2025-11-07T08:13:47.071Z',
            updatedAt: '2025-11-07T08:13:47.071Z',
          },
          {
            uuid: 'bb',
            name: 'Unlimited',
            viewPosition: 2,
            info: { membersCount: 8, inboundsCount: 1 },
            inbounds: [{ uuid: 'inb-2' }],
            createdAt: '2025-11-07T08:13:47.071Z',
            updatedAt: '2025-11-07T08:13:47.071Z',
          },
        ],
      },
    };

    assert.deepStrictEqual(mapInternalSquadDetails(upstream), [
      {
        uuid: 'aa',
        name: 'Default-Squad',
        viewPosition: 1,
        membersCount: 0,
        inboundsCount: 1,
        createdAt: '2025-11-07T08:13:47.071Z',
        updatedAt: '2025-11-07T08:13:47.071Z',
      },
      {
        uuid: 'bb',
        name: 'Unlimited',
        viewPosition: 2,
        membersCount: 8,
        inboundsCount: 1,
        createdAt: '2025-11-07T08:13:47.071Z',
        updatedAt: '2025-11-07T08:13:47.071Z',
      },
    ]);
  });

  it('falls back to inbounds.length when info.inboundsCount is missing', () => {
    const upstream = {
      response: {
        internalSquads: [
          {
            uuid: 'cc',
            name: 'Old Squad',
            viewPosition: 0,
            inbounds: [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }],
          },
        ],
      },
    };

    const result = mapInternalSquadDetails(upstream);
    assert.equal(result[0]?.inboundsCount, 3);
    assert.equal(result[0]?.membersCount, 0);
  });

  it('returns an empty list for malformed payloads', () => {
    assert.deepStrictEqual(mapInternalSquadDetails(null), []);
    assert.deepStrictEqual(mapInternalSquadDetails({}), []);
    assert.deepStrictEqual(mapInternalSquadDetails({ response: {} }), []);
  });
});

describe('mapExternalSquadDetails', () => {
  it('extracts membersCount from the wrapped payload', () => {
    const upstream = {
      response: {
        total: 1,
        externalSquads: [
          {
            uuid: 'xx',
            name: 'Main',
            viewPosition: 1,
            info: { membersCount: 42 },
            createdAt: '2025-11-14T10:30:08.271Z',
            updatedAt: '2025-11-14T10:30:32.387Z',
          },
        ],
      },
    };

    assert.deepStrictEqual(mapExternalSquadDetails(upstream), [
      {
        uuid: 'xx',
        name: 'Main',
        viewPosition: 1,
        membersCount: 42,
        createdAt: '2025-11-14T10:30:08.271Z',
        updatedAt: '2025-11-14T10:30:32.387Z',
      },
    ]);
  });

  it('returns 0 counters when info block is missing', () => {
    const result = mapExternalSquadDetails({
      response: {
        externalSquads: [{ uuid: 'yy', name: 'Trial', viewPosition: 0 }],
      },
    });
    assert.equal(result[0]?.membersCount, 0);
  });
});
