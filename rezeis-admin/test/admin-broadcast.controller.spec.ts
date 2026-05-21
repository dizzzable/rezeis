import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { validate } from "class-validator";

import { AdminJwtAuthGuard } from "../src/modules/auth/guards/admin-jwt-auth.guard";
import { AdminBroadcastController } from "../src/modules/broadcast/controllers/admin-broadcast.controller";
import {
  AdminBroadcastAudienceQueryDto,
  CreateAdminBroadcastDraftDto,
} from "../src/modules/broadcast/dto/admin-broadcast.dto";

describe("AdminBroadcastController", () => {
  it("is guarded by admin jwt guard", () => {
    assert.deepStrictEqual(
      Reflect.getMetadata(GUARDS_METADATA, AdminBroadcastController),
      [AdminJwtAuthGuard],
    );
  });

  it("maps draft and audience preview routes", () => {
    assert.equal(
      Reflect.getMetadata(PATH_METADATA, AdminBroadcastController),
      "admin/broadcast",
    );
    assert.equal(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminBroadcastController.prototype.listDrafts,
      ),
      "drafts",
    );
    assert.equal(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminBroadcastController.prototype.listDrafts,
      ),
      RequestMethod.GET,
    );
    assert.equal(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminBroadcastController.prototype.createDraft,
      ),
      "drafts",
    );
    assert.equal(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminBroadcastController.prototype.createDraft,
      ),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(
        PATH_METADATA,
        AdminBroadcastController.prototype.previewAudience,
      ),
      "audience-preview",
    );
    assert.equal(
      Reflect.getMetadata(
        METHOD_METADATA,
        AdminBroadcastController.prototype.previewAudience,
      ),
      RequestMethod.GET,
    );
  });

  it("delegates draft creation to service", async () => {
    const dto: CreateAdminBroadcastDraftDto = {
      audience: "ALL",
      title: "Title",
      message: "Message",
    };
    const controller = new AdminBroadcastController({
      createDraft: async (input: CreateAdminBroadcastDraftDto) => ({
        id: "draft-1",
        input,
      }),
    } as never);

    assert.deepStrictEqual(await controller.createDraft(dto), {
      data: { id: "draft-1", input: dto },
    });
  });

  it("delegates list/detail/update/preview calls to service", async () => {
    const calls: string[] = [];
    const controller = new AdminBroadcastController({
      listDrafts: async () => {
        calls.push("list");
        return [{ id: "draft-1" }];
      },
      getDraft: async (draftId: string) => {
        calls.push(`detail:${draftId}`);
        return { id: draftId };
      },
      updateDraft: async (draftId: string, dto: unknown) => {
        calls.push(`update:${draftId}:${JSON.stringify(dto)}`);
        return { id: draftId };
      },
      previewAudience: async (query: unknown) => {
        calls.push(`preview:${JSON.stringify(query)}`);
        return { totalCount: 1 };
      },
      previewDraft: async (draftId: string) => {
        calls.push(`draft-preview:${draftId}`);
        return { draftId };
      },
      getDraftReadiness: async (draftId: string) => {
        calls.push(`readiness:${draftId}`);
        return { draftId };
      },
      prepareSend: async (draftId: string) => {
        calls.push(`prepare:${draftId}`);
        return { draftId, deliveryEnabled: false };
      },
    } as never);

    assert.deepStrictEqual(await controller.listDrafts(), {
      data: [{ id: "draft-1" }],
    });
    assert.deepStrictEqual(await controller.getDraft("draft-1"), {
      data: { id: "draft-1" },
    });
    assert.deepStrictEqual(
      await controller.updateDraft("draft-1", { title: "New" }),
      { data: { id: "draft-1" } },
    );
    assert.deepStrictEqual(
      await controller.previewAudience({ audience: "ALL" }),
      { data: { totalCount: 1 } },
    );
    assert.deepStrictEqual(await controller.previewDraft("draft-1"), {
      data: { draftId: "draft-1" },
    });
    assert.deepStrictEqual(await controller.getDraftReadiness("draft-1"), {
      data: { draftId: "draft-1" },
    });
    assert.deepStrictEqual(await controller.prepareSend("draft-1"), {
      data: { draftId: "draft-1", deliveryEnabled: false },
    });
    assert.deepStrictEqual(calls, [
      "list",
      "detail:draft-1",
      'update:draft-1:{"title":"New"}',
      'preview:{"audience":"ALL"}',
      "draft-preview:draft-1",
      "readiness:draft-1",
      "prepare:draft-1",
    ]);
  });

  it("accepts subscription lifecycle audience values in the route dto contract", async () => {
    const dto: AdminBroadcastAudienceQueryDto = {
      audience: "TRIAL_SUBSCRIPTION",
    };

    assert.deepStrictEqual(
      await validate(Object.assign(new AdminBroadcastAudienceQueryDto(), dto)),
      [],
    );
  });
});
