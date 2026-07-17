import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BotFlowScreenService } from '../src/modules/bot-flow/services/bot-flow-screen.service';

describe('BotFlowScreenService media upload', () => {
  it('rejects SVG script content disguised as a PNG', async () => {
    let updated = false;
    const service = new BotFlowScreenService({
      botFlowScreen: {
        findUnique: async () => ({ flowId: 'flow-1' }),
        update: async () => {
          updated = true;
          return {};
        },
      },
      botFlow: {
        findUnique: async () => ({ status: 'DRAFT' }),
      },
    } as never);
    const file = {
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      mimetype: 'image/png',
      originalname: 'banner.png',
    } as Express.Multer.File;

    await assert.rejects(
      () => service.uploadMedia('screen-1', file),
      /unsupported|invalid|content/i,
    );
    assert.equal(updated, false);
  });
});
