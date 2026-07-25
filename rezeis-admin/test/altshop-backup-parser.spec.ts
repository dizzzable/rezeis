import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Headers, pack } from 'tar-stream';

import { parseAltshopBackup } from '../src/modules/imports/utils/altshop-backup-parser';

describe('parseAltshopBackup', () => {
  it('extracts product history and reports intentionally excluded tables', async () => {
    const backup = await parseAltshopBackup(
      Buffer.from(
        JSON.stringify({
          data: {
            users: [{ id: 1, telegram_id: 1 }],
            referrals: [{ id: 2 }],
            referral_rewards: [{ id: 3 }],
            partners: [{ id: 4 }],
            partner_referrals: [{ id: 5 }],
            partner_transactions: [{ id: 6 }],
            settings: [{ id: 7 }],
            payment_gateways: [{ id: 8 }],
            referral_invites: [{ id: 9 }],
          },
        }),
      ),
    );

    assert.equal(backup.referrals.length, 1);
    assert.equal(backup.partnerTransactions.length, 1);
    assert.deepEqual(backup.excludedData, {
      settings: 1,
      paymentGateways: 1,
      referralInvites: 1,
      promocodes: 0,
      promocodeActivations: 0,
      partnerWithdrawals: 0,
      broadcasts: 0,
      broadcastMessages: 0,
    });
  });

  it('parses a regular tar.gz containing a root database.json', async () => {
    const archive = await buildTarGz([
      { name: 'assets/', type: 'directory' },
      { name: 'database.json', content: Buffer.from('{"users":[{"id":1,"telegram_id":1}]}') },
    ]);
    const backup = await parseAltshopBackup(archive);
    assert.equal(backup.users.length, 1);
  });

  it('rejects archives without a database payload', async () => {
    const archive = await buildTarGz([{ name: 'metadata.json', content: Buffer.from('{}') }]);
    await assert.rejects(
      () => parseAltshopBackup(archive),
      /database\.json not found/i,
    );
  });

  it('rejects duplicate database payloads and unsafe tar entries', async () => {
    const duplicate = await buildTarGz([
      { name: 'database.json', content: Buffer.from('{"users":[{"id":1}]}') },
      { name: 'database.json', content: Buffer.from('{"users":[{"id":2}]}') },
    ]);
    await assert.rejects(
      () => parseAltshopBackup(duplicate),
      /more than one database\.json/i,
    );
    const traversal = await buildTarGz([{ name: '../database.json', content: Buffer.from('{}') }]);
    await assert.rejects(
      () => parseAltshopBackup(traversal),
      /unsafe path/i,
    );
    const symlink = await buildTarGz([{ name: 'asset', type: 'symlink', linkname: 'elsewhere' }]);
    await assert.rejects(
      () => parseAltshopBackup(symlink),
      /unsafe entry type/i,
    );
  });

  it('rejects malformed gzip input', async () => {
    await assert.rejects(
      () => parseAltshopBackup(Buffer.from([0x1f, 0x8b, 0x08, 0x00])),
      /Failed to decompress backup file/i,
    );
  });
});

type TarEntry = { name: string; content?: Buffer; type?: Headers['type']; linkname?: string };

function buildTarGz(entries: readonly TarEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = pack();
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    const add = (index: number): void => {
      if (index === entries.length) return archive.finalize();
      const entry = entries[index];
      const header: Headers = { name: entry.name, type: entry.type, linkname: entry.linkname };
      const done = (error?: Error | null): void => (error ? reject(error) : add(index + 1));
      if (entry.type && entry.type !== 'file') archive.entry(header, done);
      else archive.entry(header, entry.content ?? Buffer.alloc(0), done);
    };
    add(0);
  });
}
