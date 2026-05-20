import "reflect-metadata";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AdminBroadcastService } from "../src/modules/broadcast/services/admin-broadcast.service";

describe("AdminBroadcastService", () => {
  it("lists draft rows in service-mapped safe shape", async () => {
    const service = new AdminBroadcastService({
      broadcast: {
        findMany: async (args: unknown) => {
          assert.deepStrictEqual(args, {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 50,
          });
          return [
            {
              id: "draft-1",
              taskId: "task-1",
              audience: "ALL",
              payload: { title: "Title", message: "Message" },
              totalCount: 2,
              successCount: 0,
              failedCount: 0,
              createdAt: new Date("2026-04-24T12:00:00.000Z"),
            },
          ];
        },
      },
    } as never);

    assert.deepStrictEqual(await service.listDrafts(), [
      {
        id: "draft-1",
        taskId: "task-1",
        audience: "ALL",
        payload: { title: "Title", message: "Message", buttonText: null, buttonUrl: null, mediaUrl: null },
        totalCount: 2,
        successCount: 0,
        failedCount: 0,
        createdAt: "2026-04-24T12:00:00.000Z",
      },
    ]);
  });

  it("returns draft detail by id", async () => {
    const service = new AdminBroadcastService({
      broadcast: {
        findUnique: async (args: unknown) => {
          assert.deepStrictEqual(args, { where: { id: "draft-1" } });
          return {
            id: "draft-1",
            taskId: "task-1",
            audience: "BLOCKED",
            payload: { title: "Detail", message: "Body" },
            totalCount: 1,
            successCount: 0,
            failedCount: 0,
            createdAt: new Date("2026-04-24T12:00:00.000Z"),
          };
        },
      },
    } as never);

    assert.equal((await service.getDraft("draft-1")).payload.title, "Detail");
  });

  it("creates a draft with audience preview count and trimmed payload", async () => {
    const broadcastCreateCalls: unknown[] = [];
    const userCountCalls: unknown[] = [];
    const service = new AdminBroadcastService({
      user: {
        count: async (args: unknown): Promise<number> => {
          userCountCalls.push(args);
          return 3;
        },
        findMany: async (): Promise<readonly { id: string }[]> => [
          { id: "user-1" },
          { id: "user-2" },
        ],
      },
      broadcast: {
        create: async (
          args: unknown,
        ): Promise<{
          id: string;
          taskId: string;
          audience: string;
          payload: unknown;
          totalCount: number;
          successCount: number;
          failedCount: number;
          createdAt: Date;
        }> => {
          broadcastCreateCalls.push(args);
          return {
            id: "draft-1",
            taskId: "task-1",
            audience: "BLOCKED",
            payload: { title: "Maintenance", message: "Hello users" },
            totalCount: 3,
            successCount: 0,
            failedCount: 0,
            createdAt: new Date("2026-04-24T12:00:00.000Z"),
          };
        },
      },
    } as never);

    const result = await service.createDraft({
      audience: "BLOCKED",
      title: " Maintenance ",
      message: " Hello users ",
    });

    assert.deepStrictEqual(userCountCalls, [{ where: { isBlocked: true } }]);
    assert.deepStrictEqual(broadcastCreateCalls, [
      {
        data: {
          audience: "BLOCKED",
          totalCount: 3,
          payload: { title: "Maintenance", message: "Hello users" },
        },
      },
    ]);
    assert.deepStrictEqual(result, {
      id: "draft-1",
      taskId: "task-1",
      audience: "BLOCKED",
      payload: { title: "Maintenance", message: "Hello users", buttonText: null, buttonUrl: null, mediaUrl: null },
      totalCount: 3,
      successCount: 0,
      failedCount: 0,
      createdAt: "2026-04-24T12:00:00.000Z",
    });
  });

  it("previews audience with count and safe id-only samples", async () => {
    const service = new AdminBroadcastService({
      user: {
        count: async (args: unknown): Promise<number> => {
          assert.deepStrictEqual(args, {
            where: { subscriptions: { some: { status: "ACTIVE" } } },
          });
          return 2;
        },
        findMany: async (args: unknown): Promise<readonly { id: string }[]> => {
          assert.deepStrictEqual(args, {
            where: { subscriptions: { some: { status: "ACTIVE" } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true },
            take: 5,
          });
          return [{ id: "user-1" }, { id: "user-2" }];
        },
      },
      broadcast: {},
    } as never);

    const result = await service.previewAudience({
      audience: "ACTIVE_SUBSCRIPTION",
    });

    assert.deepStrictEqual(result, {
      audience: "ACTIVE_SUBSCRIPTION",
      totalCount: 2,
      sampleUserIds: ["user-1", "user-2"],
    });
  });

  it("maps altshop-inspired subscription lifecycle audiences to safe database filters", async () => {
    const countCalls: unknown[] = [];
    const findManyCalls: unknown[] = [];
    const service = new AdminBroadcastService({
      user: {
        count: async (args: unknown): Promise<number> => {
          countCalls.push(args);
          return countCalls.length;
        },
        findMany: async (args: unknown): Promise<readonly { id: string }[]> => {
          findManyCalls.push(args);
          return [{ id: `sample-${findManyCalls.length}` }];
        },
      },
      broadcast: {},
    } as never);

    await service.previewAudience({ audience: "UNSUBSCRIBED" });
    await service.previewAudience({ audience: "EXPIRED_SUBSCRIPTION" });
    await service.previewAudience({ audience: "TRIAL_SUBSCRIPTION" });

    assert.deepStrictEqual(countCalls, [
      { where: { subscriptions: { none: { status: "ACTIVE" } } } },
      {
        where: {
          subscriptions: {
            some: { status: "EXPIRED" },
            none: { status: "ACTIVE" },
          },
        },
      },
      {
        where: { subscriptions: { some: { isTrial: true, status: "ACTIVE" } } },
      },
    ]);
    assert.deepStrictEqual(
      findManyCalls.map((call) => (call as { readonly where: unknown }).where),
      countCalls.map((call) => (call as { readonly where: unknown }).where),
    );
  });

  it("updates a draft and refreshes audience count when audience changes", async () => {
    const service = new AdminBroadcastService({
      user: {
        count: async (args: unknown): Promise<number> => {
          assert.deepStrictEqual(args, { where: { isBlocked: true } });
          return 4;
        },
        findMany: async (): Promise<readonly { id: string }[]> => [],
      },
      broadcast: {
        findUniqueOrThrow: async (args: unknown) => {
          assert.deepStrictEqual(args, { where: { id: "draft-1" } });
          return {
            id: "draft-1",
            taskId: "task-1",
            audience: "ALL",
            payload: { title: "Old", message: "Old" },
            totalCount: 1,
            successCount: 0,
            failedCount: 0,
            createdAt: new Date("2026-04-24T12:00:00.000Z"),
          };
        },
        findUnique: async (args: unknown) => {
          assert.deepStrictEqual(args, { where: { id: "draft-1" } });
          return {
            id: "draft-1",
            taskId: "task-1",
            audience: "BLOCKED",
            payload: { title: "New", message: "New message" },
            totalCount: 4,
            successCount: 0,
            failedCount: 0,
            createdAt: new Date("2026-04-24T12:00:00.000Z"),
          };
        },
        update: async (args: unknown) => {
          assert.deepStrictEqual(args, {
            where: { id: "draft-1" },
            data: {
              audience: "BLOCKED",
              totalCount: 4,
              payload: { title: "New", message: "New message" },
            },
          });
          return {
            id: "draft-1",
            taskId: "task-1",
            audience: "BLOCKED",
            payload: { title: "New", message: "New message" },
            totalCount: 4,
            successCount: 0,
            failedCount: 0,
            createdAt: new Date("2026-04-24T12:00:00.000Z"),
          };
        },
      },
    } as never);

    assert.equal(
      (
        await service.updateDraft("draft-1", {
          audience: "BLOCKED",
          title: " New ",
          message: " New message ",
        })
      ).totalCount,
      4,
    );
  });

  it("builds backend-owned draft preview validation without sending", async () => {
    const service = new AdminBroadcastService({
      broadcast: {
        findUnique: async (args: unknown) => {
          assert.deepStrictEqual(args, { where: { id: "draft-1" } });
          return {
            id: "draft-1",
            taskId: "task-1",
            audience: "ALL",
            payload: {
              title: "Service update",
              message: "Bounded preview message",
            },
            totalCount: 5,
            successCount: 0,
            failedCount: 0,
            createdAt: new Date("2026-04-24T12:00:00.000Z"),
          };
        },
      },
    } as never);

    assert.deepStrictEqual(await service.previewDraft("draft-1"), {
      draftId: "draft-1",
      isValid: true,
      titlePreview: "Service update",
      messagePreview: "Bounded preview message",
      audience: "ALL",
      totalCount: 5,
      issues: [],
    });
  });

  it("reports validation issues for empty drafts and empty audience", async () => {
    const service = new AdminBroadcastService({
      broadcast: {
        findUnique: async () => ({
          id: "draft-2",
          taskId: "task-2",
          audience: "BLOCKED",
          payload: { title: "", message: "" },
          totalCount: 0,
          successCount: 0,
          failedCount: 0,
          createdAt: new Date("2026-04-24T12:00:00.000Z"),
        }),
      },
    } as never);

    const preview = await service.previewDraft("draft-2");

    assert.equal(preview.isValid, false);
    assert.deepStrictEqual(
      preview.issues.map((issue) => issue.code),
      ["TITLE_TOO_SHORT", "MESSAGE_TOO_SHORT", "EMPTY_AUDIENCE"],
    );
  });

  it("builds a send readiness checklist without enabling delivery", async () => {
    const service = new AdminBroadcastService({
      broadcast: {
        findUnique: async () => ({
          id: "draft-3",
          taskId: "task-3",
          audience: "ALL",
          payload: { title: "Ready draft", message: "Ready bounded message" },
          totalCount: 7,
          successCount: 0,
          failedCount: 0,
          createdAt: new Date("2026-04-24T12:00:00.000Z"),
        }),
      },
    } as never);

    const readiness = await service.getDraftReadiness("draft-3");

    assert.equal(readiness.readyForFutureDelivery, true);
    assert.deepStrictEqual(readiness.blockedReasonCodes, []);
    assert.deepStrictEqual(
      readiness.checks.map((check) => check.code),
      [
        "VALID_CONTENT",
        "NON_EMPTY_AUDIENCE",
        "NO_DELIVERY_ATTEMPTS",
        "SENDING_DISABLED",
      ],
    );
  });

  it("prepares a delivery run without enabling provider delivery", async () => {
    const events: string[] = [];
    const transactionClient = {
      broadcastDeliveryRun: {
        create: async (input: unknown) => {
          events.push("run.create");
          assert.deepStrictEqual(input, {
            data: {
              broadcastId: "draft-4",
              status: "READY",
              audienceCount: 7,
              eligibleTelegramUsers: 3,
              preparedMessages: 3,
              deliveryEnabled: false,
              blockedReasonCodes: [],
            },
          });
          return { id: "run-1", status: "READY", createdAt: new Date("2026-04-24T12:30:00.000Z") };
        },
      },
      broadcastDeliveryRecipient: {
        createMany: async (input: unknown) => {
          events.push("recipient.createMany");
          assert.deepStrictEqual(input, {
            data: [
              { runId: "run-1", userId: "user-1", status: "STAGED" },
              { runId: "run-1", userId: "user-2", status: "STAGED" },
              { runId: "run-1", userId: "user-3", status: "STAGED" },
            ],
            skipDuplicates: true,
          });
          return { count: 3 };
        },
      },
    };
    const service = new AdminBroadcastService({
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push("transaction.begin");
        const result = await callback(transactionClient);
        events.push("transaction.commit");
        return result;
      },
      broadcast: {
        findUnique: async () => ({
          id: "draft-4",
          taskId: "task-4",
          audience: "ALL",
          payload: { title: "Ready draft", message: "Ready bounded message" },
          totalCount: 7,
          successCount: 0,
          failedCount: 0,
          createdAt: new Date("2026-04-24T12:00:00.000Z"),
        }),
      },
      user: {
        findMany: async (input: unknown) => {
          assert.deepStrictEqual(input, { where: { telegramId: { not: null } }, select: { id: true }, take: 10000 });
          return [{ id: "user-1" }, { id: "user-2" }, { id: "user-3" }];
        },
      },
      broadcastDeliveryRun: {
        create: async () => {
          throw new Error("root broadcastDeliveryRun.create must not be used for prepare-send staging");
        },
      },
      broadcastDeliveryRecipient: {
        createMany: async () => {
          throw new Error("root broadcastDeliveryRecipient.createMany must not be used for prepare-send staging");
        },
      },
    } as never);

    const result = await service.prepareSend("draft-4");

    assert.deepStrictEqual(result, {
      runId: "run-1",
      draftId: "draft-4",
      status: "READY",
      deliveryEnabled: false,
      audienceCount: 7,
      eligibleTelegramUsers: 3,
      preparedMessages: 3,
      blockedReasonCodes: [],
    });
    assert.deepStrictEqual(events, [
      "transaction.begin",
      "run.create",
      "recipient.createMany",
      "transaction.commit",
    ]);
  });

  it("executes one staged recipient through the delivery adapter", async () => {
    const events: string[] = [];
    const transactionClient = {
      broadcastDeliveryRecipient: {
        update: async (input: unknown) => {
          events.push("recipient.update");
          const data = (input as { readonly data: { readonly status: string; readonly telegramMessageId: bigint | null } }).data;
          assert.deepStrictEqual(data.status, "DELIVERED");
          assert.equal(data.telegramMessageId, 456n);
        },
        count: async (input: { readonly where: { readonly status: string } }) => {
          events.push(`recipient.count:${input.where.status}`);
          return 0;
        },
      },
      broadcastDeliveryRun: {
        update: async (input: unknown) => {
          events.push("run.update");
          const serialized = JSON.stringify(input);
          assert.equal(serialized.includes("successCount") || serialized.includes("COMPLETED"), true);
        },
      },
    };
    const service = new AdminBroadcastService({
      broadcastDeliveryRun: {
        findUnique: async () => ({
          id: "run-1",
          broadcast: { payload: { title: "Title", message: "Hello user" } },
        }),
        update: async () => {
          throw new Error("root broadcastDeliveryRun.update should not be used for recipient execution writes");
        },
      },
      broadcastDeliveryRecipient: {
        findFirst: async () => ({
          id: "recipient-1",
          runId: "run-1",
          userId: "user-1",
          user: { id: "user-1", telegramId: 123n },
        }),
        update: async () => {
          throw new Error("root broadcastDeliveryRecipient.update should not be used for recipient execution writes");
        },
        count: async () => {
          throw new Error("root broadcastDeliveryRecipient.count should not be used for recipient execution finalization");
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push("transaction.begin");
        const result = await callback(transactionClient);
        events.push("transaction.commit");
        return result;
      },
    } as never, {
      sendTelegramMessage: async (input: unknown) => {
        events.push("delivery.send");
        assert.deepStrictEqual(input, {
          telegramId: "123",
          text: "Hello user",
          buttonText: null,
          buttonUrl: null,
          mediaUrl: null,
        });
        return { deliveryState: "delivered", telegramMessageId: 456 };
      },
    } as never);

    const result = await service.executeNextRecipient("run-1");

    assert.equal(result.status, "DELIVERED");
    assert.equal(result.telegramMessageId, null);
    assert.deepStrictEqual(events, [
      "delivery.send",
      "transaction.begin",
      "recipient.update",
      "run.update",
      "recipient.count:STAGED",
      "recipient.count:FAILED",
      "run.update",
      "transaction.commit",
    ]);
  });

  it("marks a failed staged recipient and updates run state inside one transaction", async () => {
    const events: string[] = [];
    const transactionClient = {
      broadcastDeliveryRecipient: {
        update: async (input: unknown) => {
          events.push("recipient.update");
          assert.deepStrictEqual((input as { readonly data: { readonly status: string; readonly errorCode: string } }).data.status, "FAILED");
          assert.equal((input as { readonly data: { readonly errorCode: string } }).data.errorCode, "delivery-status-uncertain");
        },
        count: async (input: { readonly where: { readonly status: string } }) => {
          events.push(`recipient.count:${input.where.status}`);
          return input.where.status === "FAILED" ? 1 : 0;
        },
      },
      broadcastDeliveryRun: {
        update: async (input: unknown) => {
          events.push("run.update");
          const serialized = JSON.stringify(input);
          assert.equal(serialized.includes("failedCount") || serialized.includes("COMPLETED_WITH_FAILURES"), true);
        },
      },
    };
    const service = new AdminBroadcastService({
      broadcastDeliveryRun: {
        findUnique: async () => ({
          id: "run-1",
          broadcast: { payload: { title: "Title", message: "Hello user" } },
        }),
        update: async () => {
          throw new Error("root broadcastDeliveryRun.update should not be used for recipient failure writes");
        },
      },
      broadcastDeliveryRecipient: {
        findFirst: async () => ({
          id: "recipient-1",
          runId: "run-1",
          userId: "user-1",
          user: { id: "user-1", telegramId: 123n },
        }),
        update: async () => {
          throw new Error("root broadcastDeliveryRecipient.update should not be used for recipient failure writes");
        },
        count: async () => {
          throw new Error("root broadcastDeliveryRecipient.count should not be used for recipient failure finalization");
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push("transaction.begin");
        const result = await callback(transactionClient);
        events.push("transaction.commit");
        return result;
      },
    } as never, {
      sendTelegramMessage: async () => {
        events.push("delivery.send");
        throw new Error("telegram outage raw-token should stay outside persisted errorCode");
      },
    } as never);

    const result = await service.executeNextRecipient("run-1");

    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, "delivery-status-uncertain");
    assert.deepStrictEqual(events, [
      "delivery.send",
      "transaction.begin",
      "recipient.update",
      "run.update",
      "recipient.count:STAGED",
      "recipient.count:FAILED",
      "run.update",
      "transaction.commit",
    ]);
  });

  it("does not treat post-delivery database failure as Telegram delivery failure", async () => {
    const events: string[] = [];
    const transactionClient = {
      broadcastDeliveryRecipient: {
        update: async (input: unknown) => {
          events.push(`recipient.update:${(input as { readonly data: { readonly status: string } }).data.status}`);
          throw new Error("database unavailable after delivered telegram message token-secret-raw");
        },
        count: async () => {
          events.push("recipient.count");
          return 0;
        },
      },
      broadcastDeliveryRun: {
        update: async () => {
          events.push("run.update");
        },
      },
    };
    const service = new AdminBroadcastService({
      broadcastDeliveryRun: {
        findUnique: async () => ({
          id: "run-1",
          broadcast: { payload: { title: "Title", message: "Hello user" } },
        }),
        update: async () => {
          events.push("root.run.update");
          throw new Error("root broadcastDeliveryRun.update should not be used after delivered provider success");
        },
      },
      broadcastDeliveryRecipient: {
        findFirst: async () => ({
          id: "recipient-1",
          runId: "run-1",
          userId: "user-1",
          user: { id: "user-1", telegramId: 123n },
        }),
        update: async () => {
          events.push("root.recipient.update");
          throw new Error("root broadcastDeliveryRecipient.update should not be used after delivered provider success");
        },
        count: async () => {
          throw new Error("root broadcastDeliveryRecipient.count should not be used after delivered provider success");
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push("transaction.begin");
        const result = await callback(transactionClient);
        events.push("transaction.commit");
        return result;
      },
    } as never, {
      sendTelegramMessage: async () => {
        events.push("delivery.send");
        return { deliveryState: "delivered", telegramMessageId: 456 };
      },
    } as never);

    await assert.rejects(() => service.executeNextRecipient("run-1"), /database unavailable/);

    assert.deepStrictEqual(events, [
      "delivery.send",
      "transaction.begin",
      "recipient.update:DELIVERED",
    ]);
    assert.equal(events.includes("recipient.update:FAILED"), false);
    assert.equal(events.includes("root.recipient.update"), false);
    assert.equal(events.includes("root.run.update"), false);
  });

  it("deletes one delivered recipient message through the delivery adapter", async () => {
    const events: string[] = [];
    const updateCalls: unknown[] = [];
    const transactionClient = {
      broadcastDeliveryRecipient: {
        update: async (input: unknown) => {
          events.push("tx.recipient.update");
          updateCalls.push(input);
        },
      },
    };
    const service = new AdminBroadcastService({
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push("transaction.begin");
        const result = await callback(transactionClient);
        events.push("transaction.commit");
        return result;
      },
      broadcastDeliveryRecipient: {
        findUnique: async () => ({
          id: "recipient-1",
          runId: "run-1",
          userId: "user-1",
          status: "DELIVERED",
          telegramMessageId: 456n,
          user: { id: "user-1", telegramId: 123n },
        }),
        update: async () => {
          throw new Error("root recipient update must not be used after Telegram delete");
        },
      },
    } as never, {
      deleteTelegramMessage: async (input: unknown) => {
        events.push("telegram.delete");
        assert.deepStrictEqual(input, { telegramId: "123", telegramMessageId: 456 });
        return { deleted: true };
      },
    } as never);

    const result = await service.deleteDeliveredRecipientMessage("recipient-1");

    assert.equal(result.status, "DELETED");
    assert.equal(result.deleted, true);
    assert.equal(updateCalls.length, 1);
    assert.equal(JSON.stringify(updateCalls).includes("DELETED"), true);
    assert.deepStrictEqual(events, [
      "telegram.delete",
      "transaction.begin",
      "tx.recipient.update",
      "transaction.commit",
    ]);
  });

  it("does not classify recipient delete local DB failure as Telegram delete failure", async () => {
    const events: string[] = [];
    const service = new AdminBroadcastService({
      $transaction: async () => {
        events.push("transaction.begin");
        throw new Error("database unavailable after Telegram delete");
      },
      broadcastDeliveryRecipient: {
        findUnique: async () => ({
          id: "recipient-1",
          runId: "run-1",
          userId: "user-1",
          status: "DELIVERED",
          telegramMessageId: 456n,
          user: { id: "user-1", telegramId: 123n },
        }),
        update: async () => {
          throw new Error("root recipient update must not be used after Telegram delete");
        },
      },
    } as never, {
      deleteTelegramMessage: async () => {
        events.push("telegram.delete");
        return { deleted: true };
      },
    } as never);

    await assert.rejects(
      () => service.deleteDeliveredRecipientMessage("recipient-1"),
      /database unavailable after Telegram delete/,
    );

    assert.deepStrictEqual(events, ["telegram.delete", "transaction.begin"]);
  });

  it("deletes delivered recipient messages in a capped manual batch", async () => {
    const recipientIds = ["recipient-1", "recipient-2"];
    const service = new AdminBroadcastService({
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback({
        broadcastDeliveryRecipient: {
          update: async () => undefined,
        },
      }),
      broadcastDeliveryRecipient: {
        findFirst: async () => {
          const id = recipientIds.shift();
          return id ? { id } : null;
        },
        findUnique: async (input: { readonly where: { readonly id: string } }) => ({
          id: input.where.id,
          runId: "run-1",
          userId: "user-1",
          status: "DELIVERED",
          telegramMessageId: 456n,
          user: { id: "user-1", telegramId: 123n },
        }),
        count: async () => 0,
      },
    } as never, {
      deleteTelegramMessage: async () => ({ deleted: true }),
    } as never);

    const result = await service.deleteDeliveredRecipientBatch("run-1", 50);

    assert.equal(result.attempted, 2);
    assert.equal(result.deleted, 2);
    assert.equal(result.blocked, 0);
    assert.equal(result.remainingDelivered, 0);
  });

  it("cancels a delivery run and staged recipients inside one transaction", async () => {
    const events: string[] = [];
    const transactionClient = {
      broadcastDeliveryRecipient: {
        updateMany: async (input: unknown) => {
          events.push("recipient.updateMany");
          assert.equal(JSON.stringify(input).includes("STAGED"), true);
          assert.equal(JSON.stringify(input).includes("CANCELLED"), true);
          return { count: 3 };
        },
      },
      broadcastDeliveryRun: {
        update: async (input: unknown) => {
          events.push("run.update");
          assert.equal(JSON.stringify(input).includes("CANCELLED"), true);
        },
      },
    };
    const service = new AdminBroadcastService({
      broadcastDeliveryRun: {
        findUnique: async () => ({ id: "run-1", status: "IN_PROGRESS" }),
        update: async () => {
          throw new Error("root broadcastDeliveryRun.update should not be used for cancel writes");
        },
      },
      broadcastDeliveryRecipient: {
        updateMany: async () => {
          throw new Error("root broadcastDeliveryRecipient.updateMany should not be used for cancel writes");
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push("transaction.begin");
        const result = await callback(transactionClient);
        events.push("transaction.commit");
        return result;
      },
    } as never, {} as never);

    const result = await service.cancelDeliveryRun("run-1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(result.cancelledRecipients, 3);
    assert.deepStrictEqual(events, ["transaction.begin", "recipient.updateMany", "run.update", "transaction.commit"]);
  });

  it("resets failed recipients back to staged for retry", async () => {
    const events: string[] = [];
    const transactionClient = {
      broadcastDeliveryRecipient: {
        updateMany: async (input: unknown) => {
          events.push("recipient.updateMany");
          assert.equal(JSON.stringify(input).includes("FAILED"), true);
          assert.equal(JSON.stringify(input).includes("STAGED"), true);
          return { count: 2 };
        },
      },
      broadcastDeliveryRun: {
        update: async (input: unknown) => {
          events.push("run.update");
          assert.equal(JSON.stringify(input).includes("IN_PROGRESS"), true);
        },
      },
    };
    const service = new AdminBroadcastService({
      broadcastDeliveryRecipient: {
        updateMany: async () => {
          throw new Error("root broadcastDeliveryRecipient.updateMany should not be used for retry writes");
        },
      },
      broadcastDeliveryRun: {
        update: async () => {
          throw new Error("root broadcastDeliveryRun.update should not be used for retry writes");
        },
      },
      $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) => {
        events.push("transaction.begin");
        const result = await callback(transactionClient);
        events.push("transaction.commit");
        return result;
      },
    } as never, {} as never);

    const result = await service.retryFailedRecipients("run-1");

    assert.equal(result.retriedRecipients, 2);
    assert.deepStrictEqual(events, ["transaction.begin", "recipient.updateMany", "run.update", "transaction.commit"]);
  });

  it("normalizes unknown stored audiences back to all users", async () => {
    const service = new AdminBroadcastService({
      broadcast: {
        findUnique: async () => ({
          id: "draft-legacy",
          taskId: "task-legacy",
          audience: "LEGACY_UNSUPPORTED",
          payload: { title: "Legacy", message: "Legacy message" },
          totalCount: 1,
          successCount: 0,
          failedCount: 0,
          createdAt: new Date("2026-04-24T12:00:00.000Z"),
        }),
      },
    } as never);

    assert.equal((await service.getDraft("draft-legacy")).audience, "ALL");
  });
});
