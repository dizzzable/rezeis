import 'reflect-metadata';

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { BadRequestException, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { BroadcastAudience, BroadcastStatus, UserRole } from '@prisma/client';
import { validate } from 'class-validator';

import { AdminJwtAuthGuard } from '../src/modules/auth/guards/admin-jwt-auth.guard';
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
      [AdminJwtAuthGuard],
    );
  });

  it('maps the current broadcast routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminBroadcastController), 'admin/broadcast');
    assertRoute(AdminBroadcastController.prototype.listDrafts, 'drafts', RequestMethod.GET);
    assertRoute(AdminBroadcastController.prototype.getBroadcast, ':broadcastId', RequestMethod.GET);
    assertRoute(AdminBroadcastController.prototype.createDraft, 'drafts', RequestMethod.POST);
    assertRoute(AdminBroadcastController.prototype.updateDraft, 'drafts/:broadcastId', RequestMethod.PATCH);
    assertRoute(
      AdminBroadcastController.prototype.previewAudience,
      ':broadcastId/audience-preview',
      RequestMethod.GET,
    );
    assertRoute(AdminBroadcastController.prototype.sendBroadcast, ':broadcastId/send', RequestMethod.POST);
    assertRoute(AdminBroadcastController.prototype.cancelBroadcast, ':broadcastId/cancel', RequestMethod.POST);
    assertRoute(AdminBroadcastController.prototype.editBroadcast, ':broadcastId/edit', RequestMethod.POST);
    assertRoute(
      AdminBroadcastController.prototype.deleteBroadcastMessages,
      ':broadcastId/messages',
      RequestMethod.DELETE,
    );
    assertRoute(AdminBroadcastController.prototype.retryFailed, ':broadcastId/retry', RequestMethod.POST);
    assertRoute(AdminBroadcastController.prototype.uploadMedia, 'upload-media', RequestMethod.POST);
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
        updateBroadcastContent: async (input: unknown) => {
          calls.push(['updateContent', input]);
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
      message: 'Broadcast updated',
    });
    assert.deepStrictEqual(await controller.deleteBroadcastMessages('completed-1', admin), {
      batches: 1,
      totalMessages: 2,
      message: 'Delete enqueued',
    });
    assert.deepStrictEqual(await controller.retryFailed('failed-1', admin), {
      batches: 1,
      totalMessages: 1,
      message: 'Retry enqueued',
    });
    assert.deepStrictEqual(calls, [
      ['get', 'draft-1'],
      ['enqueueStart', { broadcastId: 'draft-1', adminId: 'admin-1' }, { delayMs: undefined }],
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
      ['get', 'completed-1'],
      ['sentIds', 'completed-1'],
      ['enqueueDelete', { broadcastId: 'completed-1', messageIds: ['message-1', 'message-2'] }],
      ['get', 'failed-1'],
      ['failedIds', 'failed-1'],
      ['enqueueRetry', { broadcastId: 'failed-1', messageIds: ['failed-message-1'] }],
      ['status', 'failed-1', BroadcastStatus.PROCESSING],
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

function assertRoute(method: unknown, path: string, requestMethod: RequestMethod): void {
  assert.equal(Reflect.getMetadata(PATH_METADATA, method), path);
  assert.equal(Reflect.getMetadata(METHOD_METADATA, method), requestMethod);
}

function currentAdmin(): CurrentAdminInterface {
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
  };
}
