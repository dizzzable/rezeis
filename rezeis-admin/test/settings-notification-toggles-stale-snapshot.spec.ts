import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserRole } from '@prisma/client';

import type { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import type { IconUploadService } from '../src/modules/settings/services/icon-upload.service';
import { SettingsService } from '../src/modules/settings/services/settings.service';

/**
 * A notification toggle must not write back the page's copy of everything else
 * ═════════════════════════════════════════════════════════════════════════════
 * `PATCH /admin/settings/notifications` is the endpoint behind the switches on
 * Settings → Notifications. The System tab used to send
 * `{ ...systemNotifications, [key]: !current }` — the whole object the page
 * loaded, minus the masked secrets — and the service merged it with a
 * top-level spread. `systemNotifications` is not a toggle map only: it also
 * holds the custom emoji packs, the backup schedule, Telegram routing,
 * payment-ops alerts, the bot-emoji premium switch and two markers, each saved
 * by its own endpoint. So one click restored every one of them to what it was
 * when the page loaded: a pack imported in another tab disappeared, auto-backup
 * switched itself back off. The answer was 200.
 *
 * The page now sends the flipped key alone. This file pins the server half:
 * the endpoint takes booleans only, and never over a key that holds anything
 * else — which is what an open tab still running the old page sends.
 */

const ADMIN: CurrentAdminInterface = {
  id: 'admin-1',
  login: 'admin',
  email: 'admin@example.test',
  name: 'Admin',
  role: UserRole.ADMIN,
  isActive: true,
  tokenVersion: 1,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastLoginAt: null,
  lastLoginIp: null,
  rbacRoleId: null,
  mustChangePassword: false,
};

const REQUEST_METADATA = {
  requestId: 'request-toggles-snapshot',
  remoteAddress: '203.0.113.40',
  userAgent: 'settings-toggles-snapshot-spec',
} as const;

const PACK_A = { id: 'a', name: 'A', emojis: [] };
const PACK_B = { id: 'b', name: 'B', emojis: [] };

/** The row as it stands NOW: pack B and auto-backup were saved after the page loaded. */
function currentSystemNotifications(): Record<string, unknown> {
  return {
    node_status: true,
    user_hwid: true,
    customEmojiPacks: [PACK_A, PACK_B],
    seededEmojiDefaults: ['builtin_news', 'builtin_game'],
    backup: { autoEnabled: true, intervalHours: 12 },
    telegram: { enabled: true, chatId: '-100200' },
    paymentOps: { enabled: true, chatId: '-100300' },
    botEmoji: { ownerHasPremium: false },
    webPushEnvAdoptedAt: '2026-09-10T10:00:00.000Z',
  };
}

/** What the page loaded before those saves — and what the old toggle handler sent back. */
function staleSnapshot(): Record<string, unknown> {
  return {
    node_status: true,
    user_hwid: true,
    customEmojiPacks: [PACK_A],
    seededEmojiDefaults: ['builtin_news'],
    backup: { autoEnabled: false, intervalHours: 24 },
    telegram: { enabled: false, chatId: null },
    paymentOps: { enabled: false, chatId: null },
    botEmoji: { ownerHasPremium: true },
    webPushEnvAdoptedAt: null,
  };
}

function harness(record: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    // The settings row lock (`SELECT "id" FROM "settings" FOR UPDATE`) finding the row.
    $queryRaw: async () => [{ id: record.id }],
    settings: {
      findFirst: async () => record,
      update: async ({ data }: { readonly data: Record<string, unknown> }) => {
        writes.push(data);
        return { ...record, ...data };
      },
    },
    adminAuditLog: { create: async () => ({}) },
  };
  const service = new SettingsService(
    {
      settings: { findFirst: async () => record },
      $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
    } as never,
    {} as IconUploadService,
    { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
  );
  return { service, writes };
}

describe('PATCH /admin/settings/notifications — a toggle writes toggles, nothing else', () => {
  it('does not restore the emoji packs, backup, routing or markers a stale page sent back', async () => {
    const { service, writes } = harness({
      id: 1,
      userNotifications: { expired: true },
      systemNotifications: currentSystemNotifications(),
    });

    // Exactly what the old System-tab handler sent: the loaded object, one key flipped.
    await service.updateNotificationToggles({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      systemNotifications: { ...staleSnapshot(), node_status: false },
    });

    assert.equal(writes.length, 1);
    const written = writes[0]!.systemNotifications as Record<string, unknown>;
    assert.equal(written.node_status, false, 'the flipped toggle is saved');
    const { node_status: _flipped, ...rest } = written;
    const { node_status: _before, ...expected } = currentSystemNotifications();
    assert.deepStrictEqual(rest, expected, 'every other key stays as it is stored now');
  });

  it('does not let a boolean replace a key that holds structured settings', async () => {
    const { service, writes } = harness({
      id: 1,
      userNotifications: {},
      systemNotifications: currentSystemNotifications(),
    });

    await service.updateNotificationToggles({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      systemNotifications: { backup: false, customEmojiPacks: false, user_hwid: false },
    });

    const written = writes[0]!.systemNotifications as Record<string, unknown>;
    assert.deepStrictEqual(written.backup, { autoEnabled: true, intervalHours: 12 });
    assert.deepStrictEqual(written.customEmojiPacks, [PACK_A, PACK_B]);
    assert.equal(written.user_hwid, false, 'a real toggle in the same request is still saved');
  });

  it('applies the same rule to the user toggle map', async () => {
    const { service, writes } = harness({
      id: 1,
      userNotifications: { expired: true, limited: true },
      systemNotifications: {},
    });

    await service.updateNotificationToggles({
      currentAdmin: ADMIN,
      requestMetadata: REQUEST_METADATA,
      userNotifications: { expired: false, limited: 'yes', extra: { nested: true } },
    });

    assert.deepStrictEqual(writes[0]!.userNotifications, { expired: false, limited: true });
  });
});
