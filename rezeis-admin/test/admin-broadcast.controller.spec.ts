import 'reflect-metadata';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { BroadcastAudience, BroadcastStatus, UserRole } from '@prisma/client';
import { validate } from 'class-validator';

import {
  RouteHandler,
  RoutePermission,
  assertEffectiveRoutePermission,
  assertEveryRouteGuarded,
  assertRoute,
  assertRouteHandlers,
} from './helpers/controller-routes';
import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
import { RbacGuard } from '../src/modules/rbac/guards/rbac.guard';
import { RbacService } from '../src/modules/rbac/services/rbac.service';
import { CurrentAdminInterface } from '../src/modules/auth/interfaces/current-admin.interface';
import { AdminBroadcastController } from '../src/modules/broadcast/controllers/admin-broadcast.controller';
import {
  BroadcastPayloadDto,
  CreateBroadcastDraftDto,
  EditBroadcastDto,
} from '../src/modules/broadcast/dto/broadcast-payload.dto';

describe('AdminBroadcastController', () => {
  it('is guarded by admin jwt guard', () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminBroadcastController),
      [AdminJwtAuthGuard, RbacGuard],
    );
  });

  it('maps the current broadcast routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminBroadcastController), 'admin/broadcast');
    // "The current routes" now means the class's routes rather than the eleven
    // that were current when this list was typed. It was already two behind:
    // `sendTestBroadcast` (`POST :broadcastId/test`) and `deleteBroadcast`
    // (`DELETE :broadcastId`) had been added and were mapped by nothing here.
    assertRouteHandlers(AdminBroadcastController, [
      'cancelBroadcast',
      'createDraft',
      'deleteBroadcast',
      'deleteBroadcastMessages',
      'editBroadcast',
      'getBroadcast',
      'listDrafts',
      'previewAudience',
      'retryFailed',
      'sendBroadcast',
      'sendTestBroadcast',
      'updateDraft',
      'uploadMedia',
    ]);

    assertRoute(
      AdminBroadcastController.prototype.listDrafts,
      { method: RequestMethod.GET, path: 'drafts' },
      'GET admin/broadcast/drafts (list drafts)',
    );
    assertRoute(
      AdminBroadcastController.prototype.getBroadcast,
      { method: RequestMethod.GET, path: ':broadcastId' },
      'GET admin/broadcast/:broadcastId (read one broadcast)',
    );
    assertRoute(
      AdminBroadcastController.prototype.createDraft,
      { method: RequestMethod.POST, path: 'drafts' },
      'POST admin/broadcast/drafts (create draft)',
    );
    assertRoute(
      AdminBroadcastController.prototype.updateDraft,
      { method: RequestMethod.PATCH, path: 'drafts/:broadcastId' },
      'PATCH admin/broadcast/drafts/:broadcastId (update draft)',
    );
    assertRoute(
      AdminBroadcastController.prototype.previewAudience,
      { method: RequestMethod.GET, path: ':broadcastId/audience-preview' },
      'GET admin/broadcast/:broadcastId/audience-preview (count recipients)',
    );
    assertRoute(
      AdminBroadcastController.prototype.sendBroadcast,
      { method: RequestMethod.POST, path: ':broadcastId/send' },
      'POST admin/broadcast/:broadcastId/send (enqueue delivery)',
    );
    assertRoute(
      AdminBroadcastController.prototype.sendTestBroadcast,
      { method: RequestMethod.POST, path: ':broadcastId/test' },
      'POST admin/broadcast/:broadcastId/test (preview to bot developer)',
    );
    assertRoute(
      AdminBroadcastController.prototype.cancelBroadcast,
      { method: RequestMethod.POST, path: ':broadcastId/cancel' },
      'POST admin/broadcast/:broadcastId/cancel (cancel in-flight delivery)',
    );
    assertRoute(
      AdminBroadcastController.prototype.editBroadcast,
      { method: RequestMethod.POST, path: ':broadcastId/edit' },
      'POST admin/broadcast/:broadcastId/edit (rewrite sent messages)',
    );
    assertRoute(
      AdminBroadcastController.prototype.deleteBroadcast,
      { method: RequestMethod.DELETE, path: ':broadcastId' },
      'DELETE admin/broadcast/:broadcastId (drop broadcast and its rows)',
    );
    assertRoute(
      AdminBroadcastController.prototype.deleteBroadcastMessages,
      { method: RequestMethod.DELETE, path: ':broadcastId/messages' },
      'DELETE admin/broadcast/:broadcastId/messages (unsend from Telegram)',
    );
    assertRoute(
      AdminBroadcastController.prototype.retryFailed,
      { method: RequestMethod.POST, path: ':broadcastId/retry' },
      'POST admin/broadcast/:broadcastId/retry (requeue failed messages)',
    );
    assertRoute(
      AdminBroadcastController.prototype.uploadMedia,
      { method: RequestMethod.POST, path: 'upload-media' },
      'POST admin/broadcast/upload-media (upload photo or video)',
    );
  });

  /**
   * The test above maps every route and gates none of them, and until now that
   * was not an oversight — it was the limit of what could be said. This
   * controller declares `@RequirePermission('broadcasts', 'view')` on the
   * CLASS, and three of its thirteen routes (`listDrafts`, `getBroadcast`,
   * `previewAudience`) carry no decorator of their own. Reading
   * `REQUIRE_PERMISSION_KEY` off those handlers returns `undefined`, so the
   * per-handler assertion used everywhere else in this suite had nothing to
   * assert against; writing one would simply have failed.
   *
   * `effectiveRoutePermissions` resolves the pair the way `RbacGuard` does —
   * `getAllAndOverride(KEY, [handler, class])`
   * (`src/modules/rbac/guards/rbac.guard.ts:37-40`), where a handler-level
   * decorator REPLACES the class-level one rather than adding to it. So the
   * ten decorated routes are gated on their own pair alone, NOT on their pair
   * plus `broadcasts:view`, and the table below states exactly that. Written
   * out per route rather than as "everything is at least :view", because the
   * interesting failures are the narrow ones: `deleteBroadcast` drifting from
   * `delete` to `edit` is the sort of change that never looks like a security
   * change in review.
   */
  it('gates every broadcast route on the permission RbacGuard actually resolves', () => {
    // Nothing on this controller is meant to be reachable without a permission.
    // With the class-level decorator present that is currently true by
    // construction — but a route added to a class that stops declaring one, or
    // moved to a sibling controller that never did, is exactly the case
    // `RbacGuard` passes through in silence (`rbac.guard.ts:41`).
    assertEveryRouteGuarded(AdminBroadcastController, []);

    const gates: readonly {
      readonly handler: RouteHandler;
      readonly label: string;
      readonly permission: RoutePermission;
    }[] = [
      // ── held by the CLASS-level decorator only ──────────────────────────
      {
        handler: AdminBroadcastController.prototype.listDrafts,
        label: 'GET admin/broadcast/drafts (list drafts)',
        permission: { resource: 'broadcasts', action: 'view' },
      },
      {
        handler: AdminBroadcastController.prototype.getBroadcast,
        label: 'GET admin/broadcast/:broadcastId (read one broadcast)',
        permission: { resource: 'broadcasts', action: 'view' },
      },
      {
        handler: AdminBroadcastController.prototype.previewAudience,
        label: 'GET admin/broadcast/:broadcastId/audience-preview (count recipients)',
        permission: { resource: 'broadcasts', action: 'view' },
      },
      // ── declared on the handler, overriding the class ───────────────────
      {
        handler: AdminBroadcastController.prototype.createDraft,
        label: 'POST admin/broadcast/drafts (create draft)',
        permission: { resource: 'broadcasts', action: 'create' },
      },
      {
        handler: AdminBroadcastController.prototype.updateDraft,
        label: 'PATCH admin/broadcast/drafts/:broadcastId (update draft)',
        permission: { resource: 'broadcasts', action: 'edit' },
      },
      {
        handler: AdminBroadcastController.prototype.sendBroadcast,
        label: 'POST admin/broadcast/:broadcastId/send (enqueue delivery)',
        permission: { resource: 'broadcasts', action: 'run' },
      },
      {
        handler: AdminBroadcastController.prototype.sendTestBroadcast,
        label: 'POST admin/broadcast/:broadcastId/test (preview to bot developer)',
        permission: { resource: 'broadcasts', action: 'run' },
      },
      {
        handler: AdminBroadcastController.prototype.cancelBroadcast,
        label: 'POST admin/broadcast/:broadcastId/cancel (cancel in-flight delivery)',
        permission: { resource: 'broadcasts', action: 'edit' },
      },
      {
        handler: AdminBroadcastController.prototype.editBroadcast,
        label: 'POST admin/broadcast/:broadcastId/edit (rewrite sent messages)',
        permission: { resource: 'broadcasts', action: 'edit' },
      },
      {
        handler: AdminBroadcastController.prototype.deleteBroadcast,
        label: 'DELETE admin/broadcast/:broadcastId (drop broadcast and its rows)',
        permission: { resource: 'broadcasts', action: 'delete' },
      },
      {
        handler: AdminBroadcastController.prototype.deleteBroadcastMessages,
        label: 'DELETE admin/broadcast/:broadcastId/messages (unsend from Telegram)',
        permission: { resource: 'broadcasts', action: 'delete' },
      },
      {
        handler: AdminBroadcastController.prototype.retryFailed,
        label: 'POST admin/broadcast/:broadcastId/retry (requeue failed messages)',
        permission: { resource: 'broadcasts', action: 'run' },
      },
      {
        handler: AdminBroadcastController.prototype.uploadMedia,
        label: 'POST admin/broadcast/upload-media (upload photo or video)',
        permission: { resource: 'broadcasts', action: 'edit' },
      },
    ];

    // One entry per route, and the route list is pinned in the test above, so
    // a fourteenth route cannot land here silently: it fails
    // `assertRouteHandlers` first, and a reviewer arriving from that failure
    // has to decide what its gate is.
    assert.equal(gates.length, 13);

    for (const { handler, label, permission } of gates) {
      assertEffectiveRoutePermission(AdminBroadcastController, handler, permission, label);
    }
  });

  /**
   * Test-sending a draft must not destroy it on behalf of someone who could not
   * destroy it directly.
   *
   * `sendTestBroadcast` is gated on `broadcasts:run` and used to finish with an
   * unconditional `deleteBroadcast`, justified by a comment calling the row "a
   * throwaway preview shell (no recipients/messages)". That describes the
   * panel's flow — create a shell, immediately test-send it — and nothing at the
   * endpoint enforced it. `broadcastId` is caller-supplied and the only
   * precondition is DRAFT, so pointing the route at somebody else's draft
   * deleted it. "No messages" cannot separate the two either: `BroadcastMessage`
   * rows are written at dispatch, so EVERY draft has none.
   *
   * That handed `broadcasts:run` a destruction the catalog deliberately keeps
   * apart — the default `operator` role holds view/create/edit/run and no
   * delete (`rbac.resources.ts`), while `DELETE :broadcastId` is gated on
   * delete. So the cleanup now asks the same question `DELETE` would.
   *
   * Both directions are asserted. Only checking that a run-only admin is spared
   * would pass just as well if the cleanup had been deleted outright, and the
   * cleanup is the reason this endpoint does not litter the broadcast list.
   */
  describe('POST :broadcastId/test — the cleanup reaches no further than the caller', () => {
    type PermissionSubject = Parameters<RbacService['hasPermission']>[0];

    function buildTestSend(options: { readonly mayDelete: boolean }) {
      const deleted: string[] = [];
      const asked: { subject: PermissionSubject; resource: string; action: string }[] = [];
      // Typed against the real signature, so a renamed or re-signatured
      // `hasPermission` breaks this spec instead of silently never being asked.
      const rbacService: Pick<RbacService, 'hasPermission'> = {
        hasPermission: async (subject, resource, action) => {
          asked.push({ subject, resource, action });
          return options.mayDelete;
        },
      };
      const controller = new AdminBroadcastController(
        {
          getBroadcast: async (broadcastId: string) => ({
            id: broadcastId,
            status: BroadcastStatus.DRAFT,
          }),
          deleteBroadcast: async (broadcastId: string) => {
            deleted.push(broadcastId);
          },
        } as never,
        {} as never,
        {} as never,
        { sendTestToDev: async () => ({ ok: true }) } as never,
        rbacService as RbacService,
      );
      return { controller, deleted, asked };
    }

    it('leaves the draft alone when the caller holds run but not delete', async () => {
      const { controller, deleted, asked } = buildTestSend({ mayDelete: false });
      const admin = currentAdmin({ id: 'operator-7', rbacRoleId: 'rbac-role-operator' });

      assert.deepStrictEqual(await controller.sendTestBroadcast('someone-elses-draft', admin), {
        ok: true,
        // SAID OUT LOUD. The panel used to forget the draft id after every test
        // send, so this caller — who keeps the shell by design — got a second
        // row on the next save and could delete neither.
        draftRemoved: false,
        message: 'Test preview sent to developer',
      });

      assert.deepStrictEqual(
        deleted,
        [],
        'a run-only admin destroyed a draft by test-sending it — `broadcasts:run` must not carry `broadcasts:delete`',
      );
      assert.deepStrictEqual(
        asked,
        [
          {
            subject: { id: 'operator-7', role: UserRole.ADMIN, rbacRoleId: 'rbac-role-operator' },
            resource: 'broadcasts',
            action: 'delete',
          },
        ],
        'the cleanup must ask for `broadcasts:delete` about the CALLING admin, the same question DELETE asks',
      );
    });

    it('still cleans the preview shell up for a caller who holds delete', async () => {
      const { controller, deleted } = buildTestSend({ mayDelete: true });

      await controller.sendTestBroadcast('preview-shell-1', currentAdmin());

      assert.deepStrictEqual(
        deleted,
        ['preview-shell-1'],
        'the panel flow lost its cleanup: an admin who may delete should not accumulate orphan preview drafts',
      );
    });
  });

  it('delegates draft CRUD and preview calls to BroadcastService without stale response wrappers', async () => {
    const calls: unknown[] = [];
    const controller = new AdminBroadcastController(
      {
        listDrafts: async () => {
          calls.push('list');
          return [{ id: 'broadcast-1' }];
        },
        getBroadcast: async (broadcastId: string) => {
          calls.push(['get', broadcastId]);
          return { id: broadcastId };
        },
        createDraft: async (input: unknown) => {
          calls.push(['create', input]);
          return { id: 'broadcast-created' };
        },
        updateDraft: async (input: unknown) => {
          calls.push(['update', input]);
          return { id: 'broadcast-updated' };
        },
        previewAudience: async (broadcastId: string) => {
          calls.push(['preview', broadcastId]);
          return { broadcastId, totalRecipients: 3 };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const admin = currentAdmin();
    const createDto: CreateBroadcastDraftDto = { audience: BroadcastAudience.ALL };

    assert.deepStrictEqual(await controller.listDrafts(), [{ id: 'broadcast-1' }]);
    assert.deepStrictEqual(await controller.getBroadcast('broadcast-1'), { id: 'broadcast-1' });
    assert.deepStrictEqual(await controller.createDraft(createDto, admin), { id: 'broadcast-created' });
    assert.deepStrictEqual(await controller.updateDraft('broadcast-1', { payload: { text: 'New' } }), {
      id: 'broadcast-updated',
    });
    assert.deepStrictEqual(await controller.previewAudience('broadcast-1'), {
      broadcastId: 'broadcast-1',
      totalRecipients: 3,
    });
    assert.deepStrictEqual(calls, [
      'list',
      ['get', 'broadcast-1'],
      ['create', { dto: createDto, currentAdmin: admin }],
      ['update', { broadcastId: 'broadcast-1', dto: { payload: { text: 'New' } } }],
      ['preview', 'broadcast-1'],
    ]);
  });

  it('delegates send, cancel, edit, delete, and retry operations to the queue service', async () => {
    const calls: unknown[] = [];
    const controller = new AdminBroadcastController(
      {
        getBroadcast: async (broadcastId: string) => {
          calls.push(['get', broadcastId]);
          if (broadcastId === 'draft-1') return { id: broadcastId, status: BroadcastStatus.DRAFT };
          if (broadcastId === 'processing-1') return { id: broadcastId, status: BroadcastStatus.PROCESSING };
          if (broadcastId === 'failed-1') return { id: broadcastId, status: BroadcastStatus.FAILED };
          return { id: broadcastId, status: BroadcastStatus.COMPLETED };
        },
        updateStatus: async (broadcastId: string, status: BroadcastStatus) => {
          calls.push(['status', broadcastId, status]);
        },
        // Answers the status the broadcast HAD, which is what the controller
        // needs to put it back if the enqueue never happens.
        beginRetry: async (broadcastId: string) => {
          calls.push(['beginRetry', broadcastId]);
          return BroadcastStatus.FAILED;
        },
        markForRetry: async (broadcastId: string, messageIds: readonly string[]) => {
          calls.push(['markForRetry', broadcastId, [...messageIds]]);
          return messageIds.length;
        },
        updateBroadcastContent: async (input: unknown) => {
          calls.push(['updateContent', input]);
        },
        assertPromoCodeDispatchable: async (broadcastId: string) => {
          calls.push(['assertPromo', broadcastId]);
        },
        // The send endpoint writes the schedule down now: an intent kept
        // only as a delayed Redis job cannot be shown or cancelled.
        // Returns whether the conditional write took. `false` means the
        // broadcast moved on between the status read and the write, and the
        // controller must then refuse rather than report a schedule.
        recordSchedule: async (id: string, at: Date | null, jobId: string) => {
          calls.push(['recordSchedule', id, at?.toISOString() ?? null, jobId]);
          return true;
        },
      } as never,
      {} as never,
      {
        enqueueStart: async (data: unknown, options: unknown) => {
          calls.push(['enqueueStart', data, options]);
          return 'job-1';
        },
        cancelBroadcast: async (broadcastId: string) => {
          calls.push(['cancelQueue', broadcastId]);
          return 2;
        },
        getSentMessageIds: async (broadcastId: string) => {
          calls.push(['sentIds', broadcastId]);
          return ['message-1', 'message-2'];
        },
        enqueueEdit: async (data: unknown) => {
          calls.push(['enqueueEdit', data]);
          return 1;
        },
        enqueueDelete: async (data: unknown) => {
          calls.push(['enqueueDelete', data]);
          return 1;
        },
        getFailedMessageIds: async (broadcastId: string) => {
          calls.push(['failedIds', broadcastId]);
          return ['failed-message-1'];
        },
        enqueueRetry: async (data: unknown) => {
          calls.push(['enqueueRetry', data]);
          return 1;
        },
      } as never,
      // Position 4: the delivery service, which now also owns the ONE public
      // copy of a broadcast — the post on the operator channel. It is not a
      // recipient and never appeared in `sentIds`, so corrections and recalls
      // used to stop at the private messages and leave the original text up on
      // the channel.
      {
        syncChannelPost: async (broadcastId: string) => {
          calls.push(['syncChannelPost', broadcastId]);
          return 'edited';
        },
        deleteChannelPost: async (broadcastId: string) => {
          calls.push(['deleteChannelPost', broadcastId]);
          return 'deleted';
        },
        // A recall is allowed to be about the CHANNEL alone: a broadcast
        // delivered only to web-only users has no Telegram message ids, and its
        // public copy had no route in the panel at all.
        channelPostState: async (broadcastId: string) => {
          calls.push(['channelPostState', broadcastId]);
          return 'addressable';
        },
      } as never,
      {} as never,
    );
    const admin = currentAdmin();
    const editDto: EditBroadcastDto = { text: 'Updated text', parseMode: 'HTML' };

    assert.deepStrictEqual(await controller.sendBroadcast('draft-1', {}, admin), {
      jobId: 'job-1',
      message: 'Broadcast delivery enqueued',
    });
    assert.deepStrictEqual(await controller.cancelBroadcast('processing-1', admin), {
      canceledMessages: 2,
      message: 'Broadcast canceled',
    });
    assert.deepStrictEqual(await controller.editBroadcast('completed-1', editDto, admin), {
      batches: 1,
      totalMessages: 2,
      channel: 'edited',
      message: 'Broadcast updated',
    });
    assert.deepStrictEqual(await controller.deleteBroadcastMessages('completed-1', admin), {
      batches: 1,
      totalMessages: 2,
      channel: 'deleted',
      message: 'Delete enqueued',
    });
    assert.deepStrictEqual(await controller.retryFailed('failed-1', admin), {
      batches: 1,
      totalMessages: 1,
      message: 'Retry enqueued',
    });
    assert.deepStrictEqual(calls, [
      ['get', 'draft-1'],
      ['assertPromo', 'draft-1'],
      ['enqueueStart', { broadcastId: 'draft-1', adminId: 'admin-1' }, { delayMs: undefined }],
      // Written down even for an immediate send: the job id is what cancel
      // and reschedule address, instead of scanning the whole queue.
      ['recordSchedule', 'draft-1', null, 'job-1'],
      ['get', 'processing-1'],
      ['cancelQueue', 'processing-1'],
      ['status', 'processing-1', BroadcastStatus.CANCELED],
      ['get', 'completed-1'],
      ['updateContent', { broadcastId: 'completed-1', text: 'Updated text', parseMode: 'HTML' }],
      ['sentIds', 'completed-1'],
      [
        'enqueueEdit',
        {
          broadcastId: 'completed-1',
          newText: 'Updated text',
          parseMode: 'HTML',
          messageIds: ['message-1', 'message-2'],
        },
      ],
      ['syncChannelPost', 'completed-1'],
      ['get', 'completed-1'],
      ['sentIds', 'completed-1'],
      ['channelPostState', 'completed-1'],
      ['enqueueDelete', { broadcastId: 'completed-1', messageIds: ['message-1', 'message-2'] }],
      ['deleteChannelPost', 'completed-1'],
      ['get', 'failed-1'],
      ['failedIds', 'failed-1'],
      // The PROCESSING claim comes BEFORE the enqueue now. Written after it, a
      // short retry could finish and finalize back to COMPLETED before the
      // write landed — which then stamped PROCESSING over a finished send and
      // stranded it there, invisible to the reconciler.
      ['beginRetry', 'failed-1'],
      // EVERY message the retry will touch goes back to PENDING before any
      // batch runs. Left to the batches, a multi-batch retry could finalize the
      // broadcast as COMPLETED while most of it had not started — the
      // finaliser's guard counts PENDING rows and the not-yet-reset ones were
      // still FAILED.
      ['markForRetry', 'failed-1', ['failed-message-1']],
      ['enqueueRetry', { broadcastId: 'failed-1', messageIds: ['failed-message-1'] }],
    ]);
  });

  it('validates current payload DTO values and rejects removed audience names', async () => {
    const validPayload = Object.assign(new BroadcastPayloadDto(), {
      text: 'Hello',
      mediaType: 'photo',
      mediaFileId: 'file-id',
      parseMode: 'MarkdownV2',
    });
    const validDraft = Object.assign(new CreateBroadcastDraftDto(), {
      audience: BroadcastAudience.ACTIVE_SUBSCRIBERS,
      payload: validPayload,
    });
    const invalidDraft = Object.assign(new CreateBroadcastDraftDto(), {
      audience: 'ACTIVE_SUBSCRIPTION',
    });

    assert.deepStrictEqual(await validate(validDraft), []);
    assert.equal((await validate(invalidDraft)).some((error) => error.property === 'audience'), true);
  });

  it('validates upload input before delegating media files to the upload service', async () => {
    const calls: unknown[] = [];
    const controller = new AdminBroadcastController(
      {} as never,
      {
        upload: async (input: unknown) => {
          calls.push(input);
          return {
            mediaType: 'photo',
            fileId: 'telegram-file-id',
            fileName: 'image.png',
            mimeType: 'image/png',
            sizeBytes: 1,
          };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await assert.rejects(() => controller.uploadMedia(undefined, currentAdmin()), BadRequestException);
    await assert.rejects(
      () => controller.uploadMedia({ mimetype: 'application/pdf' } as Express.Multer.File, currentAdmin()),
      /Unsupported file type/,
    );
    assert.deepStrictEqual(
      await controller.uploadMedia(
        {
          buffer: Buffer.from('x'),
          originalname: 'image.png',
          mimetype: 'image/png',
        } as Express.Multer.File,
        currentAdmin(),
      ),
      {
        mediaType: 'photo',
        fileId: 'telegram-file-id',
        fileName: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 1,
      },
    );
    assert.deepStrictEqual(calls, [
      {
        buffer: Buffer.from('x'),
        originalName: 'image.png',
        mimeType: 'image/png',
        mediaType: 'photo',
      },
    ]);
  });
});

/**
 * `overrides` exists so a test can use a SECOND admin that differs in the
 * fields `RbacService` decides on (`id`, `role`, `rbacRoleId`). Without that,
 * an assertion about "the calling admin" is satisfied by any hardcoded value.
 */
function currentAdmin(overrides: Partial<CurrentAdminInterface> = {}): CurrentAdminInterface {
  return {
    id: 'admin-1',
    login: 'root',
    email: null,
    name: null,
    role: UserRole.ADMIN,
    isActive: true,
    tokenVersion: 1,
    createdAt: new Date('2026-04-24T10:00:00.000Z'),
    lastLoginAt: null,
    lastLoginIp: null,
    rbacRoleId: null,
    mustChangePassword: false,
    ...overrides,
  };
}
