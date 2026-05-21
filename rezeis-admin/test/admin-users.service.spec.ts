import "reflect-metadata";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  Locale,
  PaymentGatewayType,
  PlanAvailability,
  PlanType,
  PurchaseChannel,
  PurchaseType,
  ReferralLevel,
  SubscriptionStatus,
  TransactionStatus,
  UserRole,
} from "@prisma/client";

import { InternalWebAccountEmailVerificationChallengeInterface } from "../src/modules/internal-user/interfaces/internal-web-account-email-verification-challenge.interface";
import { InternalUserSessionInterface } from "../src/modules/internal-user/interfaces/internal-user-session.interface";
import { InternalUserSubscriptionDevicesInterface } from "../src/modules/internal-user/interfaces/internal-user-subscription-devices.interface";
import { InternalUserService } from "../src/modules/internal-user/services/internal-user.service";
import { UserNotificationsService } from "../src/modules/user-activity/services/user-notifications.service";
import { UserTransactionsHistoryService } from "../src/modules/user-activity/services/user-transactions-history.service";
import { AdminUserActivityNotificationsQueryDto } from "../src/modules/users/dto/admin-user-activity-notifications-query.dto";
import { AdminUserActivityTransactionsQueryDto } from "../src/modules/users/dto/admin-user-activity-transactions-query.dto";
import { AdminUserIdentifierQueryDto } from "../src/modules/users/dto/admin-user-identifier-query.dto";
import { AdminUserDeviceProvisioningChallengeQueryDto } from "../src/modules/users/dto/admin-user-device-provisioning-challenge-query.dto";
import { AdminUserSelectedSubscriptionWorkbenchQueryDto } from "../src/modules/users/dto/admin-user-selected-subscription-workbench-query.dto";
import { AdminUserSearchQueryDto } from "../src/modules/users/dto/admin-user-search-query.dto";
import { IssueAdminUserDeviceProvisioningChallengeDto } from "../src/modules/users/dto/issue-admin-user-device-provisioning-challenge.dto";
import { ListAdminUsersQueryDto } from "../src/modules/users/dto/list-admin-users-query.dto";
import { RedeemDeviceProvisioningChallengeDto } from "../src/modules/users/dto/redeem-device-provisioning-challenge.dto";
import { CreateSubscriptionMutationRequestDto } from "../src/modules/users/dto/create-subscription-mutation-request.dto";
import { PaginatedUserActivityNotificationsInterface } from "../src/modules/user-activity/interfaces/user-activity-notification.interface";
import { PaginatedUserActivityTransactionsInterface } from "../src/modules/user-activity/interfaces/user-activity-transaction.interface";
import { AdminUsersListInterface } from "../src/modules/users/interfaces/admin-users-list.interface";
import { AdminUserSearchResultInterface } from "../src/modules/users/interfaces/admin-user-search-result.interface";
import { AdminUsersService } from "../src/modules/users/services/admin-users.service";
import { SubscriptionActionPolicyInterface } from "../src/modules/subscriptions/interfaces/subscription-quote.interface";
import { RemnawaveApiService } from "../src/modules/remnawave/services/remnawave-api.service";
import { PrismaService } from "../src/common/prisma/prisma.service";

function buildSearchResult(): AdminUserSearchResultInterface {
  return {
    session: {
      id: "user-1",
      telegramId: "123456789",
      username: "rezeis-user",
      name: "Rezeis User",
      email: "user@example.com",
      role: UserRole.USER,
      language: Locale.EN,
      personalDiscount: 10,
      purchaseDiscount: 5,
      points: 42,
      maxSubscriptions: 3,
      isBlocked: false,
      isBotBlocked: false,
      isRulesAccepted: true,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      webAccount: {
        id: "web-account-1",
        login: "user-login",
        loginNormalized: "user-login",
        email: "user@example.com",
        emailNormalized: "user@example.com",
        emailVerifiedAt: "2026-04-01T01:00:00.000Z",
        requiresPasswordChange: false,
        linkPromptSnoozeUntil: null,
        credentialsBootstrappedAt: "2026-04-01T01:00:00.000Z",
        createdAt: "2026-04-01T00:30:00.000Z",
        updatedAt: "2026-04-16T00:00:00.000Z",
      },
    },
    subscription: null,
    identityDiagnostics: {
      lookup: {
        requestedIdentifier: {
          type: "email",
          value: "user@example.com",
        },
        resolvedBy: "email",
        resolvedViaLinkedWebAccount: true,
      },
      linkedWebAccount: {
        status: "ready",
        hasLinkedWebAccount: true,
        emailVerified: true,
        credentialsBootstrapped: true,
        requiresPasswordChange: false,
        mismatchFlags: {
          sessionEmailVsWebAccountEmail: false,
          requestedEmailVsSessionEmail: false,
          requestedEmailVsWebAccountEmail: false,
          requestedLoginVsWebAccountLogin: false,
        },
        guidance: ["linked_identity_ready"],
      },
    },
  };
}

function buildSubscriptionDevicesResult(): InternalUserSubscriptionDevicesInterface {
  return {
    devices: [
      {
        hwid: "device-1",
        deviceName: "Pixel",
        platform: "android",
        osVersion: "14",
        appVersion: "1.0.0",
        userAgent: "rezeis-admin-tests",
        ipAddress: "127.0.0.1",
        lastSeenAt: "2026-04-16T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
    ],
    deviceCount: 1,
    deviceLimit: 3,
    isLimitReached: false,
    blockedMessage: null,
    maxDevicesMessage: null,
  };
}

function buildDeviceRefForTest(hwid: string): string {
  return createHash("sha256")
    .update(`subscription-device:${hwid}`)
    .digest("hex");
}

function buildSessionResult(): InternalUserSessionInterface {
  return buildSearchResult().session;
}

function buildEmailVerificationChallengeResult(): InternalWebAccountEmailVerificationChallengeInterface {
  return {
    webAccountId: "web-account-1",
    email: "user@example.com",
    challengeExpiresAt: "2026-04-16T10:15:00.000Z",
  };
}

function buildActionPolicyResult(): SubscriptionActionPolicyInterface {
  return {
    userId: "user-1",
    channel: PurchaseChannel.WEB,
    actions: {
      NEW: false,
      ADDITIONAL: true,
      RENEW: true,
      UPGRADE: false,
      TRIAL: false,
    },
    activeSubscriptionCount: 1,
    maxSubscriptions: 3,
    currentSubscriptionId: "subscription-1",
    availablePlans: [],
    warnings: [
      {
        code: "SUBSCRIPTION_LIMIT_REACHED",
        message: "Device limit warning.",
      },
    ],
  };
}

function buildTransactionsResult(): PaginatedUserActivityTransactionsInterface {
  return {
    items: [
      {
        id: "transaction-1",
        paymentId: "payment-1",
        userId: "user-1",
        subscriptionId: "subscription-1",
        status: TransactionStatus.COMPLETED,
        purchaseType: PurchaseType.NEW,
        channel: PurchaseChannel.TELEGRAM,
        gatewayType: PaymentGatewayType.CRYPTOMUS,
        currency: "USDT",
        amount: "9.99",
        paymentAsset: "USDT",
        gatewayId: "gateway-1",
        planSnapshot: null,
        createdAt: "2026-04-16T10:00:00.000Z",
        updatedAt: "2026-04-16T10:00:00.000Z",
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
  };
}

function buildNotificationsResult(): PaginatedUserActivityNotificationsInterface {
  return {
    items: [
      {
        id: "notification-1",
        userId: "user-1",
        type: "subscription.expiring",
        title: null,
        message: "Your subscription is expiring soon",
        isRead: false,
        readAt: null,
        readSource: null,
        createdAt: "2026-04-16T10:00:00.000Z",
      },
    ],
    total: 1,
    page: 1,
    limit: 20,
  };
}

describe("AdminUsersService", () => {
  it("blocks users idempotently and records bounded audit metadata", async () => {
    const transactionEvents: string[] = [];
    const rootUpdateCalls: unknown[] = [];
    const rootAuditCalls: unknown[] = [];
    const transactionUpdateCalls: unknown[] = [];
    const transactionAuditCalls: unknown[] = [];
    const transactionClient = {
      user: {
        update: async (input: unknown): Promise<{ id: string }> => {
          transactionEvents.push("user.update");
          transactionUpdateCalls.push(input);
          return { id: "user-1" };
        },
      },
      adminAuditLog: {
        create: async (input: unknown): Promise<void> => {
          transactionEvents.push("adminAuditLog.create");
          transactionAuditCalls.push(input);
        },
      },
    };
    const prismaService = {
      user: {
        findUnique: async (): Promise<{ id: string; isBlocked: boolean }> => ({
          id: "user-1",
          isBlocked: false,
        }),
        update: async (input: unknown): Promise<{ id: string }> => {
          rootUpdateCalls.push(input);
          throw new Error("root user.update should not be used for changed moderation writes");
        },
      },
      adminAuditLog: {
        create: async (input: unknown): Promise<void> => {
          rootAuditCalls.push(input);
          throw new Error("root adminAuditLog.create should not be used for changed moderation writes");
        },
      },
      $transaction: async (callback: (tx: typeof transactionClient) => Promise<void>): Promise<void> => {
        transactionEvents.push("transaction.begin");
        await callback(transactionClient);
        transactionEvents.push("transaction.commit");
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
    );

    const result = await service.setUserBlockedState({
      adminUserId: "admin-1",
      userId: "user-1",
      isBlocked: true,
      reason: " support case ",
    });

    assert.equal(result.isBlocked, true);
    assert.equal(result.changed, true);
    assert.equal(result.action, "BLOCK_USER");
    assert.deepStrictEqual(rootUpdateCalls, []);
    assert.deepStrictEqual(rootAuditCalls, []);
    assert.deepStrictEqual(transactionEvents, [
      "transaction.begin",
      "user.update",
      "adminAuditLog.create",
      "transaction.commit",
    ]);
    assert.deepStrictEqual(transactionUpdateCalls, [
      {
        where: { id: "user-1" },
        data: { isBlocked: true },
        select: { id: true },
      },
    ]);
    assert.deepStrictEqual(transactionAuditCalls, [
      {
        data: {
          adminUserId: "admin-1",
          action: "BLOCK_USER",
          metadata: {
            targetUserId: "user-1",
            changed: true,
            reason: "support case",
          },
        },
      },
    ]);
  });

  it("does not mutate users when block state is already applied but still records audit intent", async () => {
    const updateCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    let transactionOpened = false;
    const prismaService = {
      user: {
        findUnique: async (): Promise<{ id: string; isBlocked: boolean }> => ({
          id: "user-1",
          isBlocked: true,
        }),
        update: async (input: unknown): Promise<{ id: string }> => {
          updateCalls.push(input);
          return { id: "user-1" };
        },
      },
      adminAuditLog: {
        create: async (input: unknown): Promise<void> => {
          auditCalls.push(input);
        },
      },
      $transaction: async (): Promise<void> => {
        transactionOpened = true;
        throw new Error("transaction should not be used for idempotent unchanged moderation audit");
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
    );

    const result = await service.setUserBlockedState({
      adminUserId: "admin-1",
      userId: "user-1",
      isBlocked: true,
    });

    assert.equal(result.changed, false);
    assert.deepStrictEqual(updateCalls, []);
    assert.equal(transactionOpened, false);
    assert.equal(auditCalls.length, 1);
  });

  it("creates subscription mutation request drafts with bounded audit metadata and disabled execution", async () => {
    const auditCalls: unknown[] = [];
    const prismaService = {
      subscription: {
        findFirst: async (
          input: unknown,
        ): Promise<{
          id: string;
          status: SubscriptionStatus;
          isTrial: boolean;
          expiresAt: Date;
          remnawaveId: string;
        }> => {
          assert.deepStrictEqual(input, {
            where: {
              id: "subscription-1",
              userId: "user-1",
              status: { not: SubscriptionStatus.DELETED },
            },
            select: {
              id: true,
              status: true,
              expiresAt: true,
              remnawaveId: true,
            },
          });
          return {
            id: "subscription-1",
            status: SubscriptionStatus.ACTIVE,
            isTrial: false,
            expiresAt: new Date("2026-05-01T00:00:00.000Z"),
            remnawaveId: "rem-sub-1",
          };
        },
      },
      adminAuditLog: {
        create: async (
          input: unknown,
        ): Promise<{ id: string; createdAt: Date }> => {
          auditCalls.push(input);
          return {
            id: "mutation-request-1",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          };
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
    );

    const result = await service.createSubscriptionMutationRequest({
      adminUserId: "admin-1",
      query: {
        userId: "user-1",
        subscriptionId: "subscription-1",
      } as AdminUserSelectedSubscriptionWorkbenchQueryDto,
      dto: {
        action: "RENEW",
        reason: " support renewal ",
        idempotencyKey: "renew-1",
      } as CreateSubscriptionMutationRequestDto,
    });

    assert.equal(result.action, "RENEW");
    assert.equal(result.status, "PLANNED");
    assert.equal(result.executionEnabled, false);
    assert.equal(result.reasonRequired, true);
    assert.equal(result.reasonProvided, true);
    assert.equal(result.idempotencyKeyPresent, true);
    assert.equal(auditCalls.length, 1);
    assert.equal(JSON.stringify(auditCalls).includes("support renewal"), true);
    assert.equal(JSON.stringify(auditCalls).includes("executionEnabled"), true);
  });

  it("executes planned LIMIT_CHANGE mutation requests through the selected subscription limit executor", async () => {
    let limitExecutorInput: unknown = null;
    const prismaService = {
      subscription: {
        findFirst: async () => ({
          id: "subscription-1",
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          expiresAt: new Date("2099-05-01T00:00:00.000Z"),
          remnawaveId: "rem-sub-1",
        }),
      },
      adminAuditLog: {
        findFirst: async () => ({
          id: "mutation-request-1",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          metadata: {
            userId: "user-1",
            subscriptionId: "subscription-1",
            requestedAction: "LIMIT_CHANGE",
            idempotencyKeyPresent: true,
            trafficLimit: 128,
            deviceLimit: 4,
          },
        }),
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
    );
    service.updateSelectedSubscriptionLimits = async (input) => {
      limitExecutorInput = input;
      return {
        userId: "user-1",
        subscriptionId: "subscription-1",
        changed: true,
        idempotentReplay: false,
        changedFields: ["trafficLimit", "deviceLimit"],
        providerMutation: true,
        before: { trafficLimit: 64, deviceLimit: 2 },
        after: { trafficLimit: 128, deviceLimit: 4 },
        checkedAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
      };
    };

    const result = await service.executeSubscriptionMutationRequest({
      userId: "user-1",
      subscriptionId: "subscription-1",
      requestId: "mutation-request-1",
      adminUserId: "admin-1",
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto & { requestId: string; adminUserId: string });

    assert.equal(result.status, "EXECUTED");
    assert.equal(result.providerMutation, true);
    assert.equal(result.databaseMutation, true);
    assert.equal(JSON.stringify(limitExecutorInput).includes("subscription-mutation:mutation-request-1"), true);
    assert.equal(JSON.stringify(limitExecutorInput).includes("128"), true);
  });

  it("executes planned EXTEND mutation requests by extending local and Remnawave expiration", async () => {
    const updates: unknown[] = [];
    const auditCalls: unknown[] = [];
    const transactionEvents: string[] = [];
    const executionEvents: string[] = [];
    const transactionClient = {
      subscription: {
        update: async (input: unknown) => {
          transactionEvents.push("subscription.update");
          updates.push(input);
          return { id: "subscription-1" };
        },
      },
      adminAuditLog: {
        create: async (input: unknown) => {
          transactionEvents.push("adminAuditLog.create");
          auditCalls.push(input);
          return { id: "audit-1" };
        },
      },
    };
    const prismaService = {
      $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        transactionEvents.push("transaction.begin");
        executionEvents.push("transaction.begin");
        const result = await callback(transactionClient);
        transactionEvents.push("transaction.commit");
        executionEvents.push("transaction.commit");
        return result;
      },
      subscription: {
        findFirst: async () => ({
          id: "subscription-1",
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          expiresAt: new Date("2099-05-01T00:00:00.000Z"),
          remnawaveId: "rem-sub-1",
        }),
        update: async () => {
          throw new Error("root subscription update must not be used for expiration mutation execution");
        },
      },
      adminAuditLog: {
        findFirst: async () => ({
          id: "mutation-request-extend-1",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          metadata: {
            userId: "user-1",
            subscriptionId: "subscription-1",
            requestedAction: "EXTEND",
            idempotencyKeyPresent: true,
            durationDays: 10,
          },
        }),
        create: async () => {
          throw new Error("root audit create must not be used for expiration mutation execution");
        },
      },
    } as unknown as PrismaService;
    const remnawaveCalls: unknown[] = [];
    const remnawaveApiService = {
      updateSubscriptionUser: async (input: unknown) => {
        executionEvents.push("remnawave.updateSubscriptionUser");
        remnawaveCalls.push(input);
      },
    } as never;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    const result = await service.executeSubscriptionMutationRequest({
      userId: "user-1",
      subscriptionId: "subscription-1",
      requestId: "mutation-request-extend-1",
      adminUserId: "admin-1",
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto & { requestId: string; adminUserId: string });

    assert.equal(result.status, "EXECUTED");
    assert.equal(result.action, "EXTEND");
    assert.equal(result.providerMutation, true);
    assert.equal(result.databaseMutation, true);
    assert.equal((remnawaveCalls[0] as { readonly expireAt: Date }).expireAt.toISOString(), "2099-05-11T00:00:00.000Z");
    assert.equal(((updates[0] as { readonly data: { readonly expiresAt: Date } }).data.expiresAt).toISOString(), "2099-05-11T00:00:00.000Z");
    assert.deepStrictEqual(transactionEvents, ["transaction.begin", "subscription.update", "adminAuditLog.create", "transaction.commit"]);
    assert.deepStrictEqual(executionEvents, ["remnawave.updateSubscriptionUser", "transaction.begin", "transaction.commit"]);
    assert.equal(JSON.stringify(auditCalls).includes("EXECUTE_SUBSCRIPTION_EXPIRATION_MUTATION_REQUEST"), true);
  });

  it("executes planned EXTEND mutation requests with replacement plan semantics", async () => {
    const updates: unknown[] = [];
    const remnawaveCalls: unknown[] = [];
    const transactionClient = {
      subscription: {
        update: async (input: unknown) => {
          updates.push(input);
          return { id: "subscription-1" };
        },
      },
      adminAuditLog: { create: async () => ({ id: "audit-1" }) },
    };
    const prismaService = {
      $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
      subscription: {
        findFirst: async () => ({
          id: "subscription-1",
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          expiresAt: new Date("2099-05-01T00:00:00.000Z"),
          remnawaveId: "rem-sub-1",
        }),
        update: async () => {
          throw new Error("root subscription update must not be used for expiration mutation execution");
        },
      },
      plan: {
        findUnique: async () => ({
          id: "plan-pro",
          name: "Pro",
          type: PlanType.BOTH,
          availability: PlanAvailability.ALL,
          isActive: true,
          isArchived: false,
          trafficLimit: BigInt(2147483648),
          deviceLimit: 5,
          internalSquads: ["squad-a"],
          externalSquad: "external-a",
        }),
      },
      adminAuditLog: {
        findFirst: async () => ({
          id: "mutation-request-extend-plan-1",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          metadata: {
            userId: "user-1",
            subscriptionId: "subscription-1",
            requestedAction: "EXTEND",
            durationDays: 10,
            targetPlanId: "plan-pro",
          },
        }),
        create: async () => {
          throw new Error("root audit create must not be used for expiration mutation execution");
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      { updateSubscriptionUser: async (input: unknown) => remnawaveCalls.push(input) } as never,
    );

    const result = await service.executeSubscriptionMutationRequest({
      userId: "user-1",
      subscriptionId: "subscription-1",
      requestId: "mutation-request-extend-plan-1",
      adminUserId: "admin-1",
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto & { requestId: string; adminUserId: string });

    assert.equal(result.status, "EXECUTED");
    assert.equal(result.action, "EXTEND");
    assert.equal(result.providerMutation, true);
    assert.equal(result.databaseMutation, true);
    assert.deepStrictEqual(remnawaveCalls, [{
      remnawaveSubscriptionId: "rem-sub-1",
      expireAt: new Date("2099-05-11T00:00:00.000Z"),
      trafficLimitBytes: 2147483648,
      hwidDeviceLimit: 5,
      activeInternalSquads: ["squad-a"],
      externalSquadUuid: "external-a",
    }]);
    const updateData = (updates[0] as { readonly data: { readonly planSnapshot: { readonly id: string }; readonly expiresAt: Date } }).data;
    assert.equal(updateData.planSnapshot.id, "plan-pro");
    assert.equal(updateData.expiresAt.toISOString(), "2099-05-11T00:00:00.000Z");
  });

  it("executes planned RENEW mutation requests from now when subscription is expired", async () => {
    const updates: unknown[] = [];
    const remnawaveCalls: unknown[] = [];
    const before = Date.now();
    const transactionClient = {
      subscription: {
        update: async (input: unknown) => {
          updates.push(input);
          return { id: "subscription-1" };
        },
      },
      adminAuditLog: { create: async () => undefined },
    };
    const prismaService = {
      $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
      subscription: {
        findFirst: async () => ({
          id: "subscription-1",
          status: SubscriptionStatus.EXPIRED,
          isTrial: false,
          expiresAt: new Date("2024-01-01T00:00:00.000Z"),
          remnawaveId: "rem-sub-1",
        }),
        update: async () => {
          throw new Error("root subscription update must not be used for expiration mutation execution");
        },
      },
      adminAuditLog: {
        findFirst: async () => ({
          id: "mutation-request-renew-1",
          action: "SUBSCRIPTION_MUTATION_REQUEST_DRAFT",
          targetId: "subscription-1",
          metadata: {
            userId: "user-1",
            subscriptionId: "subscription-1",
            requestedAction: "RENEW",
            idempotencyKeyPresent: true,
            durationDays: 7,
            reason: "renew expired subscription",
            idempotencyKey: "renew-request",
          },
          createdAt: new Date("2026-04-24T12:00:00.000Z"),
        }),
        create: async () => {
          throw new Error("root audit create must not be used for expiration mutation execution");
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      { updateSubscriptionUser: async (input: unknown) => remnawaveCalls.push(input) } as never,
    );

    const result = await service.executeSubscriptionMutationRequest({
      userId: "user-1",
      subscriptionId: "subscription-1",
      requestId: "mutation-request-renew-1",
      adminUserId: "admin-1",
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto & { requestId: string; adminUserId: string });
    const after = Date.now();
    const updatedExpiresAt = ((updates[0] as { readonly data: { readonly expiresAt: Date } }).data.expiresAt).getTime();

    assert.equal(result.status, "EXECUTED");
    assert.equal(result.action, "RENEW");
    assert.equal(result.providerMutation, true);
    assert.equal(result.databaseMutation, true);
    assert.equal(remnawaveCalls.length, 1);
    assert.equal(updatedExpiresAt >= before + 7 * 24 * 60 * 60 * 1000, true);
    assert.equal(updatedExpiresAt <= after + 7 * 24 * 60 * 60 * 1000, true);
  });

  it("executes planned TRAFFIC_RESET mutation requests through Remnawave only", async () => {
    const remnawaveCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const prismaService = {
      subscription: { findFirst: async () => ({ id: "subscription-1", status: SubscriptionStatus.ACTIVE, isTrial: false, expiresAt: new Date("2099-01-01T00:00:00.000Z"), remnawaveId: "rem-sub-1" }) },
      adminAuditLog: {
        findFirst: async () => ({
          id: "mutation-request-reset-1",
          action: "SUBSCRIPTION_MUTATION_REQUEST_DRAFT",
          targetId: "subscription-1",
          metadata: { userId: "user-1", subscriptionId: "subscription-1", requestedAction: "TRAFFIC_RESET", reason: "reset traffic", idempotencyKey: "reset-request" },
          createdAt: new Date("2026-04-24T12:00:00.000Z"),
        }),
        create: async (input: unknown) => auditCalls.push(input),
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService({} as InternalUserService, {} as UserTransactionsHistoryService, {} as UserNotificationsService, prismaService, undefined, undefined, { resetSubscriptionTraffic: async (input: unknown) => remnawaveCalls.push(input) } as never);

    const result = await service.executeSubscriptionMutationRequest({ userId: "user-1", subscriptionId: "subscription-1", requestId: "mutation-request-reset-1", adminUserId: "admin-1" } as AdminUserSelectedSubscriptionWorkbenchQueryDto & { requestId: string; adminUserId: string });

    assert.equal(result.status, "EXECUTED");
    assert.equal(result.action, "TRAFFIC_RESET");
    assert.equal(result.providerMutation, true);
    assert.equal(result.databaseMutation, false);
    assert.deepStrictEqual(remnawaveCalls, ["rem-sub-1"]);
    assert.equal(JSON.stringify(auditCalls).includes("EXECUTE_SUBSCRIPTION_TRAFFIC_RESET_MUTATION_REQUEST"), true);
  });

  it("executes selected subscription plan assignment with optional traffic reset before local update", async () => {
    const remnawaveCalls: unknown[] = [];
    const resetTrafficCalls: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    const auditCalls: unknown[] = [];
    const transactionEvents: string[] = [];
    const executionEvents: string[] = [];
    const transactionClient = {
      subscription: {
        update: async (input: unknown) => {
          transactionEvents.push("subscription.update");
          subscriptionUpdates.push(input);
          return { id: "subscription-1" };
        },
      },
      adminAuditLog: {
        create: async (input: unknown) => {
          transactionEvents.push("adminAuditLog.create");
          auditCalls.push(input);
          return { id: "audit-1" };
        },
      },
    };
    const prismaService = {
      $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        transactionEvents.push("transaction.begin");
        executionEvents.push("transaction.begin");
        const result = await callback(transactionClient);
        transactionEvents.push("transaction.commit");
        executionEvents.push("transaction.commit");
        return result;
      },
      subscription: {
        findFirst: async () => ({ id: "subscription-1", userId: "user-1", status: SubscriptionStatus.ACTIVE, isTrial: false, planSnapshot: { id: "plan-basic", name: "Basic" }, remnawaveId: "rem-sub-1" }),
        update: async () => {
          throw new Error("root subscription update must not be used for plan assignment execution");
        },
      },
      plan: {
        findUnique: async (input: { readonly where: { readonly id: string } }) => {
          if (input.where.id === "plan-basic") return { id: "plan-basic", upgradeToPlanIds: ["plan-pro"], replacementPlanIds: [], isActive: true, isArchived: false };
          return { id: "plan-pro", name: "Pro", type: PlanType.BOTH, availability: PlanAvailability.ALL, isActive: true, isArchived: false, trafficLimit: BigInt(2147483648), deviceLimit: 5, internalSquads: ["squad-a", "squad-b"], externalSquad: "external-a", upgradeToPlanIds: [], replacementPlanIds: [] };
        },
      },
      adminAuditLog: {
        create: async () => {
          throw new Error("root audit create must not be used for plan assignment execution");
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService({} as InternalUserService, {} as UserTransactionsHistoryService, {} as UserNotificationsService, prismaService, undefined, undefined, {
      updateSubscriptionUser: async (input: unknown) => {
        executionEvents.push("remnawave.updateSubscriptionUser");
        remnawaveCalls.push(input);
      },
      resetSubscriptionTraffic: async (input: unknown) => {
        executionEvents.push("remnawave.resetSubscriptionTraffic");
        resetTrafficCalls.push(input);
      },
    } as unknown as RemnawaveApiService);

    const result = await service.executeSelectedSubscriptionPlanAssignment({
      adminUserId: "admin-1",
      query: { userId: "user-1", subscriptionId: "subscription-1" } as never,
      targetPlanId: "plan-pro",
      reason: "upgrade customer",
      resetTraffic: true,
    });

    assert.equal(result.status, "EXECUTED");
    assert.equal(result.providerMutation, true);
    assert.equal(result.databaseMutation, true);
    assert.equal(result.targetPlanId, "plan-pro");
    assert.deepStrictEqual(remnawaveCalls, [{ remnawaveSubscriptionId: "rem-sub-1", trafficLimitBytes: 2147483648, hwidDeviceLimit: 5, activeInternalSquads: ["squad-a", "squad-b"], externalSquadUuid: "external-a" }]);
    assert.deepStrictEqual(resetTrafficCalls, ["rem-sub-1"]);
    assert.equal(subscriptionUpdates.length, 1);
    assert.deepStrictEqual((subscriptionUpdates[0] as { readonly data: { readonly planSnapshot: unknown } }).data.planSnapshot, { id: "plan-pro", name: "Pro" });
    assert.deepStrictEqual(transactionEvents, ["transaction.begin", "subscription.update", "adminAuditLog.create", "transaction.commit"]);
    assert.deepStrictEqual(executionEvents, ["remnawave.updateSubscriptionUser", "remnawave.resetSubscriptionTraffic", "transaction.begin", "transaction.commit"]);
    assert.equal(JSON.stringify(auditCalls).includes("EXECUTE_SUBSCRIPTION_PLAN_ASSIGNMENT"), true);
    assert.equal(JSON.stringify(auditCalls).includes("resetTraffic"), true);
  });

  it("executes selected subscription status toggle with Remnawave sync before local update", async () => {
    const remnawaveCalls: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    const auditCalls: unknown[] = [];
    const transactionEvents: string[] = [];
    const executionEvents: string[] = [];
    const transactionClient = {
      subscription: {
        update: async (input: unknown) => {
          transactionEvents.push("subscription.update");
          subscriptionUpdates.push(input);
          return { id: "subscription-1" };
        },
        findMany: async () => {
          transactionEvents.push("subscription.findMany");
          return [
            { id: "subscription-fallback", status: SubscriptionStatus.ACTIVE, isTrial: false, planSnapshot: {}, trafficLimit: null, deviceLimit: 3, startedAt: new Date("2099-01-01T00:00:00.000Z"), expiresAt: new Date("2099-12-01T00:00:00.000Z"), createdAt: new Date("2099-01-01T00:00:00.000Z"), updatedAt: new Date("2099-01-01T00:00:00.000Z") },
          ];
        },
      },
      adminAuditLog: {
        create: async (input: unknown) => {
          transactionEvents.push("adminAuditLog.create");
          auditCalls.push(input);
          return { id: "audit-1" };
        },
      },
    };
    const prismaService = {
      $transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        transactionEvents.push("transaction.begin");
        executionEvents.push("transaction.begin");
        const result = await callback(transactionClient);
        transactionEvents.push("transaction.commit");
        executionEvents.push("transaction.commit");
        return result;
      },
      subscription: {
        findFirst: async () => ({ id: "subscription-1", userId: "user-1", status: SubscriptionStatus.ACTIVE, remnawaveId: "rem-sub-1" }),
        update: async () => {
          throw new Error("root subscription update must not be used for status change execution");
        },
        findMany: async () => {
          throw new Error("root subscription findMany must not be used for status change execution");
        },
      },
      adminAuditLog: {
        create: async () => {
          throw new Error("root audit create must not be used for status change execution");
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      {
        updateSubscriptionUser: async (input: unknown) => {
          executionEvents.push("remnawave.updateSubscriptionUser");
          remnawaveCalls.push(input);
          return { status: "DISABLED" };
        },
      } as unknown as RemnawaveApiService,
    );

    const result = await service.executeSelectedSubscriptionStatusChange({
      adminUserId: "admin-1",
      query: { userId: "user-1", subscriptionId: "subscription-1" },
      desiredStatus: "DISABLED",
      reason: "pause account",
    });

    assert.equal(result.status, "EXECUTED");
    assert.equal(result.providerMutation, true);
    assert.equal(result.databaseMutation, true);
    assert.equal(result.nextCurrentSubscriptionId, "subscription-fallback");
    assert.deepStrictEqual(remnawaveCalls, [{ remnawaveSubscriptionId: "rem-sub-1", status: "DISABLED" }]);
    assert.deepStrictEqual(subscriptionUpdates, [{ where: { id: "subscription-1" }, data: { status: "DISABLED" } }]);
    assert.deepStrictEqual(transactionEvents, ["transaction.begin", "subscription.update", "subscription.findMany", "adminAuditLog.create", "transaction.commit"]);
    assert.deepStrictEqual(executionEvents, ["remnawave.updateSubscriptionUser", "transaction.begin", "transaction.commit"]);
    assert.equal(JSON.stringify(auditCalls).includes("EXECUTE_SUBSCRIPTION_STATUS_CHANGE"), true);
  });

  it("appends ready identity diagnostics for direct email lookup while preserving the search payload", async () => {
    const getSearchResultCalls: AdminUserSearchQueryDto[] = [];
    const query = { email: "user@example.com" } as AdminUserSearchQueryDto;
    const expectedResult = buildSearchResult();
    const internalUserService = {
      getSearchResult: async (
        input: AdminUserSearchQueryDto,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return expectedResult;
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.searchUser(query);
    assert.equal(getSearchResultCalls.length, 1);
    assert.equal(getSearchResultCalls[0]?.email, "user@example.com");
    assert.deepStrictEqual(actualResult, expectedResult);
  });

  it("returns minimal backend-owned access diagnostics without raw account or device payloads", async () => {
    const getSearchResultCalls: unknown[] = [];
    const getSubscriptionDevicesCalls: unknown[] = [];
    const getActionPolicyCalls: unknown[] = [];
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
    } as AdminUserIdentifierQueryDto;
    const internalUserService = {
      getSearchResult: async (
        input: unknown,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return {
          ...buildSearchResult(),
          subscription: {
            id: "subscription-1",
            status: SubscriptionStatus.ACTIVE,
            isTrial: false,
            plan: {
              name: "Support Plan",
              type: PlanType.BOTH,
            },
            trafficLimit: 100,
            deviceLimit: 2,
            configUrl: "https://example.com/config",
            startedAt: "2026-04-01T00:00:00.000Z",
            expiresAt: "2026-05-01T00:00:00.000Z",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z",
          },
        };
      },
      getSubscriptionDevices: async (
        input: unknown,
      ): Promise<InternalUserSubscriptionDevicesInterface> => {
        getSubscriptionDevicesCalls.push(input);
        return {
          ...buildSubscriptionDevicesResult(),
          isLimitReached: true,
          blockedMessage: "Blocked by device policy.",
          maxDevicesMessage: "Device limit reached.",
        };
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const settingsService = {
      getInternalPlatformPolicy: async () => ({
        accessMode: "INVITED",
        rulesRequired: true,
      }),
    };
    const subscriptionQuoteService = {
      getActionPolicy: async (
        input: unknown,
      ): Promise<SubscriptionActionPolicyInterface> => {
        getActionPolicyCalls.push(input);
        return buildActionPolicyResult();
      },
    };
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
      settingsService as never,
      subscriptionQuoteService as never,
    );

    const actualResult = await service.getAccessDiagnostics(query);

    assert.equal(
      (getSearchResultCalls[0] as { readonly userId?: string }).userId,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(
      (getSubscriptionDevicesCalls[0] as { readonly userId?: string }).userId,
      "user-1",
    );
    assert.equal(getActionPolicyCalls.length, 1);
    assert.equal(actualResult.accessState, "BLOCKED");
    assert.equal(actualResult.primaryReasonCode, "DEVICE_ACCESS_BLOCKED");
    assert.deepStrictEqual(
      actualResult.reasons.map((reason) => reason.code),
      [
        "INVITE_ONLY_MODE",
        "DEVICE_ACCESS_BLOCKED",
        "DEVICE_LIMIT_REACHED",
        "ACTION_POLICY_SUBSCRIPTION_LIMIT_REACHED",
      ],
    );
    assert.deepStrictEqual(
      actualResult.facts.map((fact) => fact.code),
      [
        "platform.accessMode",
        "subscription.status",
        "devices.capacity",
        "actionPolicy.allowed",
        "identity.linkedWebAccount",
      ],
    );
    assert.equal(
      actualResult.nextActions.some(
        (action) => action.code === "REVIEW_SUBSCRIPTION_DEVICES",
      ),
      true,
    );
    const serialized = JSON.stringify(actualResult);
    assert.equal(serialized.includes("user-1"), false);
    assert.equal(serialized.includes("user@example.com"), false);
    assert.equal(serialized.includes("device-1"), false);
    assert.equal(serialized.includes("configUrl"), false);
  });

  it("keeps access diagnostics available when current-subscription devices fail to load", async () => {
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
    } as AdminUserIdentifierQueryDto;
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> => ({
        ...buildSearchResult(),
        subscription: {
          id: "subscription-1",
          status: SubscriptionStatus.ACTIVE,
          isTrial: false,
          plan: {
            name: "Support Plan",
            type: PlanType.BOTH,
          },
          trafficLimit: 100,
          deviceLimit: 2,
          configUrl: "https://example.com/config",
          startedAt: "2026-04-01T00:00:00.000Z",
          expiresAt: "2026-05-01T00:00:00.000Z",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        },
      }),
      getSubscriptionDevices:
        async (): Promise<InternalUserSubscriptionDevicesInterface> => {
          throw new Error("devices unavailable");
        },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const settingsService = {
      getInternalPlatformPolicy: async () => ({
        accessMode: "PUBLIC",
        rulesRequired: false,
      }),
    };
    const subscriptionQuoteService = {
      getActionPolicy:
        async (): Promise<SubscriptionActionPolicyInterface> => ({
          ...buildActionPolicyResult(),
          actions: {
            NEW: false,
            ADDITIONAL: true,
            RENEW: true,
            UPGRADE: false,
            TRIAL: false,
          },
          availablePlans: [],
          warnings: [],
        }),
    };
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
      settingsService as never,
      subscriptionQuoteService as never,
    );

    const actualResult = await service.getAccessDiagnostics(query);

    assert.equal(actualResult.accessState, "REVIEW");
    assert.equal(actualResult.primaryReasonCode, "DEVICE_ENVELOPE_UNAVAILABLE");
    assert.equal(
      actualResult.reasons.some(
        (reason) => reason.code === "DEVICE_ENVELOPE_UNAVAILABLE",
      ),
      true,
    );
    assert.equal(
      JSON.stringify(actualResult).includes("devices unavailable"),
      false,
    );
  });

  it("keeps access diagnostics available without calling action policy when there is no current subscription", async () => {
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
    } as AdminUserIdentifierQueryDto;
    const getSubscriptionDevicesCalls: unknown[] = [];
    const getActionPolicyCalls: unknown[] = [];
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> => ({
        ...buildSearchResult(),
        subscription: null,
      }),
      getSubscriptionDevices: async (
        input: unknown,
      ): Promise<InternalUserSubscriptionDevicesInterface> => {
        getSubscriptionDevicesCalls.push(input);
        return buildSubscriptionDevicesResult();
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const settingsService = {
      getInternalPlatformPolicy: async () => ({
        accessMode: "PUBLIC",
        rulesRequired: false,
      }),
    };
    const subscriptionQuoteService = {
      getActionPolicy: async (
        input: unknown,
      ): Promise<SubscriptionActionPolicyInterface> => {
        getActionPolicyCalls.push(input);
        return buildActionPolicyResult();
      },
    };
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
      settingsService as never,
      subscriptionQuoteService as never,
    );

    const actualResult = await service.getAccessDiagnostics(query);

    assert.equal(getSubscriptionDevicesCalls.length, 0);
    assert.equal(getActionPolicyCalls.length, 0);
    assert.equal(actualResult.accessState, "REVIEW");
    assert.equal(actualResult.primaryReasonCode, "NO_CURRENT_SUBSCRIPTION");
    assert.equal(
      actualResult.reasons.some(
        (reason) => reason.code === "NO_CURRENT_SUBSCRIPTION",
      ),
      true,
    );
    assert.deepStrictEqual(
      actualResult.facts.find((fact) => fact.code === "actionPolicy.allowed"),
      {
        code: "actionPolicy.allowed",
        label: "Allowed subscription actions",
        value: "NONE",
      },
    );
  });

  it("returns safe multi-subscription workbench rows without raw subscription payloads", async () => {
    const getSearchResultCalls: unknown[] = [];
    const subscriptionFindManyCalls: unknown[] = [];
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
    } as AdminUserIdentifierQueryDto;
    const internalUserService = {
      getSearchResult: async (
        input: unknown,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return buildSearchResult();
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      subscription: {
        findMany: async (input: unknown) => {
          subscriptionFindManyCalls.push(input);
          return [
            {
              id: "subscription-active",
              status: SubscriptionStatus.ACTIVE,
              isTrial: false,
              planSnapshot: {
                name: "Premium",
                type: PlanType.TRAFFIC,
                configUrl: "https://hidden.example/config",
              },
              trafficLimit: 2048,
              deviceLimit: 3,
              startedAt: new Date("2026-04-01T00:00:00.000Z"),
              expiresAt: new Date("2026-05-01T00:00:00.000Z"),
              createdAt: new Date("2026-04-01T00:00:00.000Z"),
              updatedAt: new Date("2026-04-16T00:00:00.000Z"),
            },
            {
              id: "subscription-limited",
              status: SubscriptionStatus.LIMITED,
              isTrial: true,
              planSnapshot: {
                name: "Trial",
                type: PlanType.BOTH,
              },
              trafficLimit: null,
              deviceLimit: 1,
              startedAt: new Date("2026-04-02T00:00:00.000Z"),
              expiresAt: new Date("2026-04-03T00:00:00.000Z"),
              createdAt: new Date("2026-04-02T00:00:00.000Z"),
              updatedAt: new Date("2026-04-03T00:00:00.000Z"),
            },
          ];
        },
      },
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.getSubscriptionsWorkbench(query);

    assert.equal(
      (getSearchResultCalls[0] as { readonly userId?: string }).userId,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.deepStrictEqual(subscriptionFindManyCalls, [
      {
        where: {
          userId: "user-1",
          status: {
            not: SubscriptionStatus.DELETED,
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          status: true,
          isTrial: true,
          planSnapshot: true,
          trafficLimit: true,
          deviceLimit: true,
          startedAt: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    ]);
    assert.equal(actualResult.totalCount, 2);
    assert.equal(actualResult.currentSubscriptionId, "subscription-limited");
    assert.equal(actualResult.items[0]?.id, "subscription-active");
    assert.equal(actualResult.items[0]?.isCurrentCandidate, false);
    assert.equal(actualResult.items[0]?.riskLevel, "WATCH");
    assert.equal(actualResult.items[1]?.id, "subscription-limited");
    assert.equal(actualResult.items[1]?.isCurrentCandidate, true);
    assert.equal(actualResult.items[1]?.riskLevel, "BLOCKED");
    assert.deepStrictEqual(actualResult.items[0]?.plan, {
      name: "Premium",
      type: PlanType.TRAFFIC,
    });
    const serialized = JSON.stringify(actualResult);
    assert.equal(serialized.includes("configUrl"), false);
    assert.equal(serialized.includes("https://hidden.example/config"), false);
    assert.equal(serialized.includes("remnawaveData"), false);
    assert.equal(serialized.includes("uuid"), false);
  });

  it("selects the next active subscription when newer subscriptions are disabled or expired", async () => {
    const service = new AdminUsersService(
      { getSearchResult: async () => buildSearchResult() } as unknown as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      {
        subscription: {
          findMany: async () => [
            { id: "subscription-disabled-newer", status: SubscriptionStatus.DISABLED, isTrial: false, planSnapshot: { name: "Paused", type: PlanType.TRAFFIC }, trafficLimit: 2048, deviceLimit: 3, startedAt: new Date("2099-03-01T00:00:00.000Z"), expiresAt: new Date("2099-04-01T00:00:00.000Z"), createdAt: new Date("2099-03-01T00:00:00.000Z"), updatedAt: new Date("2099-03-01T00:00:00.000Z") },
            { id: "subscription-expired-newer", status: SubscriptionStatus.ACTIVE, isTrial: false, planSnapshot: { name: "Expired", type: PlanType.TRAFFIC }, trafficLimit: 2048, deviceLimit: 3, startedAt: new Date("2024-01-01T00:00:00.000Z"), expiresAt: new Date("2024-02-01T00:00:00.000Z"), createdAt: new Date("2099-02-01T00:00:00.000Z"), updatedAt: new Date("2099-02-01T00:00:00.000Z") },
            { id: "subscription-active-fallback", status: SubscriptionStatus.ACTIVE, isTrial: false, planSnapshot: { name: "Fallback", type: PlanType.TRAFFIC }, trafficLimit: 2048, deviceLimit: 3, startedAt: new Date("2099-01-01T00:00:00.000Z"), expiresAt: new Date("2099-12-01T00:00:00.000Z"), createdAt: new Date("2099-01-01T00:00:00.000Z"), updatedAt: new Date("2099-01-01T00:00:00.000Z") },
          ],
        },
      } as unknown as PrismaService,
    );

    const result = await service.getSubscriptionsWorkbench({ userId: "11111111-1111-4111-8111-111111111111" } as AdminUserIdentifierQueryDto);

    assert.equal(result.currentSubscriptionId, "subscription-active-fallback");
  });

  it("returns safe selected-subscription detail only for subscriptions owned by the resolved user", async () => {
    const getSearchResultCalls: unknown[] = [];
    const subscriptionFindFirstCalls: unknown[] = [];
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto;
    const internalUserService = {
      getSearchResult: async (
        input: unknown,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return buildSearchResult();
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      subscription: {
        findFirst: async (input: unknown) => {
          subscriptionFindFirstCalls.push(input);
          return {
            id: "22222222-2222-4222-8222-222222222222",
            status: SubscriptionStatus.ACTIVE,
            isTrial: false,
            planSnapshot: {
              name: "Premium",
              type: PlanType.TRAFFIC,
              configUrl: "https://hidden.example/config",
              remnawaveData: { secret: true },
            },
            trafficLimit: 2048,
            deviceLimit: 3,
            startedAt: new Date("2026-04-01T00:00:00.000Z"),
            expiresAt: new Date("2026-05-01T00:00:00.000Z"),
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
            updatedAt: new Date("2026-04-16T00:00:00.000Z"),
          };
        },
      },
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.getSelectedSubscriptionWorkbench(query);

    assert.equal(getSearchResultCalls.length, 0);
    assert.deepStrictEqual(subscriptionFindFirstCalls, [
      {
        where: {
          id: "22222222-2222-4222-8222-222222222222",
          userId: "11111111-1111-4111-8111-111111111111",
          status: {
            not: SubscriptionStatus.DELETED,
          },
        },
        select: {
          id: true,
          status: true,
          isTrial: true,
          planSnapshot: true,
          trafficLimit: true,
          deviceLimit: true,
          startedAt: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    ]);
    assert.equal(
      actualResult.subscription.id,
      "22222222-2222-4222-8222-222222222222",
    );
    assert.equal(actualResult.ownership.belongsToUser, true);
    assert.equal(actualResult.entitlement.riskLevel, "WATCH");
    assert.deepStrictEqual(actualResult.subscription.plan, {
      name: "Premium",
      type: PlanType.TRAFFIC,
    });
    const serialized = JSON.stringify(actualResult);
    assert.equal(serialized.includes("configUrl"), false);
    assert.equal(serialized.includes("https://hidden.example/config"), false);
    assert.equal(serialized.includes("remnawaveData"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("uuid"), false);
  });

  it("returns selected-subscription devices with opaque refs only", async () => {
    const subscriptionFindFirstCalls: unknown[] = [];
    const remnawaveDeviceCalls: unknown[] = [];
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto;
    const internalUserService = {} as unknown as InternalUserService;
    const userTransactionsHistoryService =
      {} as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {} as unknown as UserNotificationsService;
    const prismaService = {
      subscription: {
        findFirst: async (input: unknown) => {
          subscriptionFindFirstCalls.push(input);
          return {
            id: "22222222-2222-4222-8222-222222222222",
            userId: "11111111-1111-4111-8111-111111111111",
            status: SubscriptionStatus.ACTIVE,
            remnawaveId: "remnawave-subscription-1",
            deviceLimit: 2,
          };
        },
      },
    } as unknown as PrismaService;
    const remnawaveApiService = {
      getUserSubscriptionDevices: async (input: unknown) => {
        remnawaveDeviceCalls.push(input);
        return {
          deviceCount: 1,
          devices: [
            {
              hwid: "raw-hwid-1",
              deviceName: "Support Laptop",
              platform: "macOS",
              osVersion: "14.5",
              appVersion: "1.0.0",
              userAgent: "agent",
              ipAddress: "127.0.0.1",
              lastSeenAt: "2026-04-20T10:00:00.000Z",
              createdAt: "2026-04-20T09:00:00.000Z",
            },
          ],
        };
      },
    } as unknown as RemnawaveApiService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    const actualResult = await service.getSelectedSubscriptionDevices(query);

    assert.deepStrictEqual(subscriptionFindFirstCalls, [
      {
        where: {
          id: "22222222-2222-4222-8222-222222222222",
          userId: "11111111-1111-4111-8111-111111111111",
          status: {
            not: SubscriptionStatus.DELETED,
          },
        },
        select: {
          id: true,
          status: true,
          remnawaveId: true,
          deviceLimit: true,
        },
      },
    ]);
    assert.deepStrictEqual(remnawaveDeviceCalls, [
      { remnawaveSubscriptionId: "remnawave-subscription-1" },
    ]);
    assert.equal(
      actualResult.devices[0]?.deviceRef,
      buildDeviceRefForTest("raw-hwid-1"),
    );
    assert.equal(JSON.stringify(actualResult).includes("raw-hwid-1"), false);
    assert.equal(actualResult.deviceCount, 1);
  });

  it("revokes selected-subscription devices by opaque ref only", async () => {
    const remnawaveGetCalls: unknown[] = [];
    const remnawaveRevokeCalls: unknown[] = [];
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
    } as AdminUserSelectedSubscriptionWorkbenchQueryDto;
    const prismaService = {
      subscription: {
        findFirst: async () => ({
          id: "22222222-2222-4222-8222-222222222222",
          userId: "11111111-1111-4111-8111-111111111111",
          status: SubscriptionStatus.ACTIVE,
          remnawaveId: "remnawave-subscription-1",
          deviceLimit: 2,
        }),
      },
    } as unknown as PrismaService;
    const remnawaveApiService = {
      getUserSubscriptionDevices: async (input: unknown) => {
        remnawaveGetCalls.push(input);
        return {
          deviceCount: remnawaveGetCalls.length === 1 ? 1 : 0,
          devices:
            remnawaveGetCalls.length === 1
              ? [
                  {
                    hwid: "raw-hwid-1",
                    deviceName: "Support Laptop",
                    platform: "macOS",
                    osVersion: null,
                    appVersion: null,
                    userAgent: null,
                    ipAddress: null,
                    lastSeenAt: null,
                    createdAt: null,
                  },
                ]
              : [],
        };
      },
      revokeUserSubscriptionDevice: async (input: unknown): Promise<void> => {
        remnawaveRevokeCalls.push(input);
      },
    } as unknown as RemnawaveApiService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    const actualResult = await service.revokeSelectedSubscriptionDevice({
      query,
      deviceRef: buildDeviceRefForTest("raw-hwid-1"),
    });

    assert.deepStrictEqual(remnawaveRevokeCalls, [
      {
        remnawaveSubscriptionId: "remnawave-subscription-1",
        hwid: "raw-hwid-1",
      },
    ]);
    assert.equal(actualResult.deviceCount, 0);
    assert.equal(JSON.stringify(actualResult).includes("raw-hwid-1"), false);
  });

  it("resolves referralCode to canonical userId and tags the search payload with referral diagnostics", async () => {
    const getSearchResultCalls: Array<Record<string, unknown>> = [];
    const userFindUniqueCalls: unknown[] = [];
    const query = { referralCode: "ref-code-123" } as AdminUserSearchQueryDto;
    const expectedResult = buildSearchResult();
    const internalUserService = {
      getSearchResult: async (
        input: Record<string, unknown>,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return expectedResult;
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findUnique: async (input: unknown): Promise<{ id: string } | null> => {
          userFindUniqueCalls.push(input);
          return { id: "user-1" };
        },
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.searchUser(query);
    assert.deepStrictEqual(userFindUniqueCalls, [
      {
        where: { referralCode: "ref-code-123" },
        select: { id: true },
      },
    ]);
    assert.deepStrictEqual(getSearchResultCalls, [{ userId: "user-1" }]);
    assert.deepStrictEqual(actualResult, {
      ...expectedResult,
      identityDiagnostics: {
        lookup: {
          requestedIdentifier: {
            type: "referralCode",
            value: "ref-code-123",
          },
          resolvedBy: "referralCode",
          resolvedViaLinkedWebAccount: false,
        },
        linkedWebAccount: expectedResult.identityDiagnostics?.linkedWebAccount,
      },
    });
  });

  it("marks diagnostics as absent when the resolved user has no linked web account", async () => {
    const baseSearchResult = buildSearchResult();
    const expectedResult: AdminUserSearchResultInterface = {
      ...baseSearchResult,
      session: {
        ...baseSearchResult.session,
        webAccount: null,
      },
    };
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        expectedResult,
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.searchUser({
      userId: "user-1",
    } as AdminUserSearchQueryDto);

    assert.deepStrictEqual(actualResult.identityDiagnostics, {
      lookup: {
        requestedIdentifier: {
          type: "userId",
          value: "user-1",
        },
        resolvedBy: "userId",
        resolvedViaLinkedWebAccount: false,
      },
      linkedWebAccount: {
        status: "absent",
        hasLinkedWebAccount: false,
        emailVerified: null,
        credentialsBootstrapped: null,
        requiresPasswordChange: null,
        mismatchFlags: {
          sessionEmailVsWebAccountEmail: false,
          requestedEmailVsSessionEmail: false,
          requestedEmailVsWebAccountEmail: false,
          requestedLoginVsWebAccountLogin: false,
        },
        guidance: ["no_linked_web_account"],
      },
    });
  });

  it("marks diagnostics as credentials bootstrap pending when the linked web account is not bootstrapped yet", async () => {
    const baseSearchResult = buildSearchResult();
    const expectedResult: AdminUserSearchResultInterface = {
      ...baseSearchResult,
      session: {
        ...baseSearchResult.session,
        webAccount: baseSearchResult.session.webAccount
          ? {
              ...baseSearchResult.session.webAccount,
              credentialsBootstrappedAt: null,
            }
          : null,
      },
    };
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        expectedResult,
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.searchUser({
      email: "user@example.com",
    } as AdminUserSearchQueryDto);

    assert.deepStrictEqual(actualResult.identityDiagnostics, {
      lookup: expectedResult.identityDiagnostics?.lookup,
      linkedWebAccount: {
        status: "credentials_bootstrap_pending",
        hasLinkedWebAccount: true,
        emailVerified: true,
        credentialsBootstrapped: false,
        requiresPasswordChange: false,
        mismatchFlags: {
          sessionEmailVsWebAccountEmail: false,
          requestedEmailVsSessionEmail: false,
          requestedEmailVsWebAccountEmail: false,
          requestedLoginVsWebAccountLogin: false,
        },
        guidance: ["bootstrap_credentials"],
      },
    });
  });

  it("marks diagnostics with password-change and mismatch guidance when linked web-account identity cues disagree", async () => {
    const baseSearchResult = buildSearchResult();
    const expectedResult: AdminUserSearchResultInterface = {
      ...baseSearchResult,
      session: {
        ...baseSearchResult.session,
        webAccount: baseSearchResult.session.webAccount
          ? {
              ...baseSearchResult.session.webAccount,
              login: "other-login",
              loginNormalized: "other-login",
              requiresPasswordChange: true,
            }
          : null,
      },
    };
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        expectedResult,
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.searchUser({
      login: "user-login",
    } as AdminUserSearchQueryDto);

    assert.deepStrictEqual(actualResult.identityDiagnostics, {
      lookup: {
        requestedIdentifier: {
          type: "login",
          value: "user-login",
        },
        resolvedBy: "login",
        resolvedViaLinkedWebAccount: false,
      },
      linkedWebAccount: {
        status: "password_change_required",
        hasLinkedWebAccount: true,
        emailVerified: true,
        credentialsBootstrapped: true,
        requiresPasswordChange: true,
        mismatchFlags: {
          sessionEmailVsWebAccountEmail: false,
          requestedEmailVsSessionEmail: false,
          requestedEmailVsWebAccountEmail: false,
          requestedLoginVsWebAccountLogin: true,
        },
        guidance: ["require_password_change", "review_identity_mismatch"],
      },
    });
  });

  it("returns bounded queue lists with hasMore and stable summary fields", async () => {
    const findManyCalls: unknown[] = [];
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        buildSearchResult(),
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (
          input: unknown,
        ): Promise<readonly Record<string, unknown>[]> => {
          findManyCalls.push(input);
          return [
            {
              id: "user-1",
              telegramId: BigInt(123456789),
              username: "alpha",
              name: "Alpha User",
              email: "alpha@example.com",
              role: UserRole.USER,
              isBlocked: true,
              createdAt: new Date("2026-04-20T00:00:00.000Z"),
              updatedAt: new Date("2026-04-21T00:00:00.000Z"),
            },
            {
              id: "user-2",
              telegramId: null,
              username: "beta",
              name: null,
              email: null,
              role: UserRole.USER,
              isBlocked: true,
              createdAt: new Date("2026-04-19T00:00:00.000Z"),
              updatedAt: new Date("2026-04-21T00:00:00.000Z"),
            },
          ];
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const query: ListAdminUsersQueryDto = {
      queue: "blacklist",
      limit: 1,
    };
    const actualResult: AdminUsersListInterface =
      await service.listUsers(query);

    assert.deepStrictEqual(findManyCalls, [
      {
        where: { isBlocked: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          webAccount: true,
        },
        take: 2,
      },
    ]);
    assert.deepStrictEqual(actualResult, {
      queue: "blacklist",
      limit: 1,
      hasMore: true,
      nextCursor: Buffer.from(
        JSON.stringify({
          source: "user",
          createdAt: "2026-04-20T00:00:00.000Z",
          id: "user-1",
        }),
        "utf8",
      ).toString("base64url"),
      items: [
        {
          id: "user-1",
          telegramId: "123456789",
          username: "alpha",
          name: "Alpha User",
          email: "alpha@example.com",
          role: UserRole.USER,
          isBlocked: true,
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      ],
    });
    assert.equal(
      "login" in (actualResult.items[0]?.webAccountContext ?? {}),
      false,
    );
    assert.equal(
      "email" in (actualResult.items[0]?.webAccountContext ?? {}),
      false,
    );
  });

  it("returns invited queue from referral.referred with bounded pagination and shared payload shape", async () => {
    const referralFindManyCalls: unknown[] = [];
    const userFindManyCalls: unknown[] = [];
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        buildSearchResult(),
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (
          input: unknown,
        ): Promise<readonly Record<string, unknown>[]> => {
          userFindManyCalls.push(input);
          return [];
        },
      },
      referral: {
        findMany: async (
          input: unknown,
        ): Promise<
          ReadonlyArray<{
            id: string;
            level: "L1" | "L2";
            createdAt: Date;
            qualifiedAt: Date | null;
            qualifiedPurchaseChannel: string | null;
            referrer: {
              id: string;
              username: string | null;
              email: string | null;
            };
            referred: {
              id: string;
              telegramId: bigint | null;
              username: string | null;
              name: string | null;
              email: string | null;
              role: UserRole;
              isBlocked: boolean;
              createdAt: Date;
              updatedAt: Date;
            };
          }>
        > => {
          referralFindManyCalls.push(input);
          return [
            {
              id: "referral-1",
              level: "L1",
              createdAt: new Date("2026-04-22T06:00:00.000Z"),
              qualifiedAt: new Date("2026-04-23T08:00:00.000Z"),
              qualifiedPurchaseChannel: "CRYPTO_BOT",
              referrer: {
                id: "inviter-1",
                username: "referrer-alpha",
                email: "referrer-alpha@example.com",
              },
              referred: {
                id: "user-invited-1",
                telegramId: BigInt(987654321),
                username: "invited-alpha",
                name: "Invited Alpha",
                email: "invited-alpha@example.com",
                role: UserRole.USER,
                isBlocked: false,
                createdAt: new Date("2026-04-22T00:00:00.000Z"),
                updatedAt: new Date("2026-04-23T00:00:00.000Z"),
              },
            },
            {
              id: "referral-2",
              level: "L1",
              createdAt: new Date("2026-04-21T05:00:00.000Z"),
              qualifiedAt: null,
              qualifiedPurchaseChannel: null,
              referrer: {
                id: "inviter-2",
                username: null,
                email: null,
              },
              referred: {
                id: "user-invited-2",
                telegramId: null,
                username: "invited-beta",
                name: null,
                email: null,
                role: UserRole.USER,
                isBlocked: true,
                createdAt: new Date("2026-04-21T00:00:00.000Z"),
                updatedAt: new Date("2026-04-23T00:00:00.000Z"),
              },
            },
            {
              id: "referral-l2",
              level: "L2",
              createdAt: new Date("2026-04-23T07:00:00.000Z"),
              qualifiedAt: null,
              qualifiedPurchaseChannel: null,
              referrer: {
                id: "inviter-l2",
                username: "referrer-l2",
                email: "referrer-l2@example.com",
              },
              referred: {
                id: "user-invited-l2",
                telegramId: BigInt(555555555),
                username: "invited-gamma",
                name: "Invited Gamma",
                email: "invited-gamma@example.com",
                role: UserRole.USER,
                isBlocked: false,
                createdAt: new Date("2026-04-23T00:00:00.000Z"),
                updatedAt: new Date("2026-04-23T08:00:00.000Z"),
              },
            },
            {
              id: "referral-older",
              level: "L1",
              createdAt: new Date("2026-04-21T04:00:00.000Z"),
              qualifiedAt: null,
              qualifiedPurchaseChannel: null,
              referrer: {
                id: "inviter-older",
                username: "referrer-older",
                email: "referrer-older@example.com",
              },
              referred: {
                id: "user-invited-2",
                telegramId: null,
                username: "invited-beta",
                name: null,
                email: null,
                role: UserRole.USER,
                isBlocked: true,
                createdAt: new Date("2026-04-21T00:00:00.000Z"),
                updatedAt: new Date("2026-04-23T00:00:00.000Z"),
              },
            },
          ];
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const query: ListAdminUsersQueryDto = {
      queue: "invited",
      limit: 1,
    };
    const actualResult: AdminUsersListInterface =
      await service.listUsers(query);

    assert.deepStrictEqual(referralFindManyCalls, [
      {
        where: {
          level: ReferralLevel.FIRST,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          referred: {
            include: {
              webAccount: true,
            },
          },
          referrer: {
            select: {
              id: true,
              username: true,
              email: true,
            },
          },
        },
        take: 2,
      },
    ]);
    assert.deepStrictEqual(userFindManyCalls, []);
    assert.deepStrictEqual(actualResult, {
      queue: "invited",
      limit: 1,
      hasMore: true,
      nextCursor: Buffer.from(
        JSON.stringify({
          source: "invited",
          createdAt: "2026-04-22T06:00:00.000Z",
          id: "referral-1",
        }),
        "utf8",
      ).toString("base64url"),
      items: [
        {
          id: "user-invited-1",
          telegramId: "987654321",
          username: "invited-alpha",
          name: "Invited Alpha",
          email: "invited-alpha@example.com",
          role: UserRole.USER,
          isBlocked: false,
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
          invitedContext: {
            invitedAt: "2026-04-22T06:00:00.000Z",
            qualifiedAt: "2026-04-23T08:00:00.000Z",
            qualifiedPurchaseChannel: "CRYPTO_BOT",
            inviter: {
              id: "inviter-1",
              username: "referrer-alpha",
              email: "referrer-alpha@example.com",
            },
          },
        },
      ],
    });

    assert.equal(
      actualResult.items.some((item) => item.id === "user-invited-l2"),
      false,
    );
  });

  it("keeps scanning direct referrals until the invited queue has enough unique users to answer hasMore honestly", async () => {
    const referralFindManyCalls: unknown[] = [];
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        buildSearchResult(),
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      referral: {
        findMany: async (
          input: unknown,
        ): Promise<
          ReadonlyArray<{
            id: string;
            level: "L1";
            createdAt: Date;
            qualifiedAt: Date | null;
            qualifiedPurchaseChannel: string | null;
            referrer: {
              id: string;
              username: string | null;
              email: string | null;
            };
            referred: {
              id: string;
              telegramId: bigint | null;
              username: string | null;
              name: string | null;
              email: string | null;
              role: UserRole;
              isBlocked: boolean;
              createdAt: Date;
              updatedAt: Date;
            };
          }>
        > => {
          referralFindManyCalls.push(input);
          if (referralFindManyCalls.length === 1) {
            return [
              {
                id: "referral-1",
                level: "L1",
                createdAt: new Date("2026-04-22T06:00:00.000Z"),
                qualifiedAt: null,
                qualifiedPurchaseChannel: null,
                referrer: {
                  id: "inviter-1",
                  username: "referrer-alpha",
                  email: "referrer-alpha@example.com",
                },
                referred: {
                  id: "user-invited-1",
                  telegramId: BigInt(1001),
                  username: "dup-user",
                  name: "Duplicate User",
                  email: "dup@example.com",
                  role: UserRole.USER,
                  isBlocked: false,
                  createdAt: new Date("2026-04-22T00:00:00.000Z"),
                  updatedAt: new Date("2026-04-23T00:00:00.000Z"),
                },
              },
              {
                id: "referral-2",
                level: "L1",
                createdAt: new Date("2026-04-22T05:30:00.000Z"),
                qualifiedAt: null,
                qualifiedPurchaseChannel: null,
                referrer: {
                  id: "inviter-2",
                  username: "referrer-beta",
                  email: "referrer-beta@example.com",
                },
                referred: {
                  id: "user-invited-1",
                  telegramId: BigInt(1001),
                  username: "dup-user",
                  name: "Duplicate User",
                  email: "dup@example.com",
                  role: UserRole.USER,
                  isBlocked: false,
                  createdAt: new Date("2026-04-22T00:00:00.000Z"),
                  updatedAt: new Date("2026-04-23T00:00:00.000Z"),
                },
              },
              {
                id: "referral-3",
                level: "L1",
                createdAt: new Date("2026-04-22T05:15:00.000Z"),
                qualifiedAt: null,
                qualifiedPurchaseChannel: null,
                referrer: {
                  id: "inviter-3",
                  username: "referrer-gamma",
                  email: "referrer-gamma@example.com",
                },
                referred: {
                  id: "user-invited-1",
                  telegramId: BigInt(1001),
                  username: "dup-user",
                  name: "Duplicate User",
                  email: "dup@example.com",
                  role: UserRole.USER,
                  isBlocked: false,
                  createdAt: new Date("2026-04-22T00:00:00.000Z"),
                  updatedAt: new Date("2026-04-23T00:00:00.000Z"),
                },
              },
            ];
          }

          return [
            {
              id: "referral-4",
              level: "L1",
              createdAt: new Date("2026-04-22T05:00:00.000Z"),
              qualifiedAt: new Date("2026-04-23T09:00:00.000Z"),
              qualifiedPurchaseChannel: "TELEGRAM_WALLET",
              referrer: {
                id: "inviter-4",
                username: "referrer-delta",
                email: "referrer-delta@example.com",
              },
              referred: {
                id: "user-invited-2",
                telegramId: BigInt(1002),
                username: "unique-user",
                name: "Unique User",
                email: "unique@example.com",
                role: UserRole.USER,
                isBlocked: false,
                createdAt: new Date("2026-04-21T00:00:00.000Z"),
                updatedAt: new Date("2026-04-22T00:00:00.000Z"),
              },
            },
          ];
        },
      },
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;

    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.listUsers({
      queue: "invited",
      limit: 2,
    } as ListAdminUsersQueryDto);

    assert.deepStrictEqual(referralFindManyCalls, [
      {
        where: { level: ReferralLevel.FIRST },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          referred: {
            include: {
              webAccount: true,
            },
          },
          referrer: {
            select: {
              id: true,
              username: true,
              email: true,
            },
          },
        },
        take: 3,
      },
      {
        where: {
          level: ReferralLevel.FIRST,
          OR: [
            {
              createdAt: {
                lt: new Date("2026-04-22T05:15:00.000Z"),
              },
            },
            {
              createdAt: new Date("2026-04-22T05:15:00.000Z"),
              id: {
                lt: "referral-3",
              },
            },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          referred: {
            include: {
              webAccount: true,
            },
          },
          referrer: {
            select: {
              id: true,
              username: true,
              email: true,
            },
          },
        },
        take: 3,
      },
    ]);
    assert.deepStrictEqual(actualResult, {
      queue: "invited",
      limit: 2,
      hasMore: false,
      nextCursor: null,
      items: [
        {
          id: "user-invited-1",
          telegramId: "1001",
          username: "dup-user",
          name: "Duplicate User",
          email: "dup@example.com",
          role: UserRole.USER,
          isBlocked: false,
          createdAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
          invitedContext: {
            invitedAt: "2026-04-22T06:00:00.000Z",
            qualifiedAt: null,
            qualifiedPurchaseChannel: null,
            inviter: {
              id: "inviter-1",
              username: "referrer-alpha",
              email: "referrer-alpha@example.com",
            },
          },
        },
        {
          id: "user-invited-2",
          telegramId: "1002",
          username: "unique-user",
          name: "Unique User",
          email: "unique@example.com",
          role: UserRole.USER,
          isBlocked: false,
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
          invitedContext: {
            invitedAt: "2026-04-22T05:00:00.000Z",
            qualifiedAt: "2026-04-23T09:00:00.000Z",
            qualifiedPurchaseChannel: "TELEGRAM_WALLET",
            inviter: {
              id: "inviter-4",
              username: "referrer-delta",
              email: "referrer-delta@example.com",
            },
          },
        },
      ],
    });
    assert.equal(
      "login" in (actualResult.items[0]?.webAccountContext ?? {}),
      false,
    );
    assert.equal(
      "email" in (actualResult.items[0]?.webAccountContext ?? {}),
      false,
    );
  });

  it("marks invited hasMore true only when the bounded referral window contains more unique invited users than the limit", async () => {
    const referralFindManyCalls: unknown[] = [];
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        buildSearchResult(),
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      referral: {
        findMany: async (
          input: unknown,
        ): Promise<
          ReadonlyArray<{
            id: string;
            level: "L1";
            createdAt: Date;
            qualifiedAt: Date | null;
            qualifiedPurchaseChannel: string | null;
            referrer: {
              id: string;
              username: string | null;
              email: string | null;
            };
            referred: {
              id: string;
              telegramId: bigint | null;
              username: string | null;
              name: string | null;
              email: string | null;
              role: UserRole;
              isBlocked: boolean;
              createdAt: Date;
              updatedAt: Date;
            };
          }>
        > => {
          referralFindManyCalls.push(input);
          return [
            {
              id: "referral-1",
              level: "L1",
              createdAt: new Date("2026-04-22T06:00:00.000Z"),
              qualifiedAt: new Date("2026-04-23T08:30:00.000Z"),
              qualifiedPurchaseChannel: "CRYPTO_BOT",
              referrer: {
                id: "inviter-1",
                username: "referrer-alpha",
                email: "referrer-alpha@example.com",
              },
              referred: {
                id: "user-invited-1",
                telegramId: BigInt(1001),
                username: "invited-one",
                name: "Invited One",
                email: "invited-one@example.com",
                role: UserRole.USER,
                isBlocked: false,
                createdAt: new Date("2026-04-22T00:00:00.000Z"),
                updatedAt: new Date("2026-04-23T00:00:00.000Z"),
              },
            },
            {
              id: "referral-2",
              level: "L1",
              createdAt: new Date("2026-04-22T05:30:00.000Z"),
              qualifiedAt: null,
              qualifiedPurchaseChannel: null,
              referrer: {
                id: "inviter-2",
                username: "referrer-beta",
                email: "referrer-beta@example.com",
              },
              referred: {
                id: "user-invited-2",
                telegramId: BigInt(1002),
                username: "invited-two",
                name: "Invited Two",
                email: "invited-two@example.com",
                role: UserRole.USER,
                isBlocked: false,
                createdAt: new Date("2026-04-21T00:00:00.000Z"),
                updatedAt: new Date("2026-04-22T00:00:00.000Z"),
              },
            },
            {
              id: "referral-3",
              level: "L1",
              createdAt: new Date("2026-04-22T05:00:00.000Z"),
              qualifiedAt: null,
              qualifiedPurchaseChannel: null,
              referrer: {
                id: "inviter-3",
                username: "referrer-gamma",
                email: "referrer-gamma@example.com",
              },
              referred: {
                id: "user-invited-3",
                telegramId: BigInt(1003),
                username: "invited-three",
                name: "Invited Three",
                email: "invited-three@example.com",
                role: UserRole.USER,
                isBlocked: false,
                createdAt: new Date("2026-04-20T00:00:00.000Z"),
                updatedAt: new Date("2026-04-21T00:00:00.000Z"),
              },
            },
          ];
        },
      },
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;

    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.listUsers({
      queue: "invited",
      limit: 2,
    } as ListAdminUsersQueryDto);

    assert.deepStrictEqual(referralFindManyCalls, [
      {
        where: { level: ReferralLevel.FIRST },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: {
          referred: {
            include: {
              webAccount: true,
            },
          },
          referrer: {
            select: {
              id: true,
              username: true,
              email: true,
            },
          },
        },
        take: 3,
      },
    ]);
    assert.equal(actualResult.hasMore, true);
    assert.equal(
      actualResult.nextCursor,
      Buffer.from(
        JSON.stringify({
          source: "invited",
          createdAt: "2026-04-22T05:30:00.000Z",
          id: "referral-2",
        }),
        "utf8",
      ).toString("base64url"),
    );
    assert.deepStrictEqual(
      actualResult.items.map((item) => item.id),
      ["user-invited-1", "user-invited-2"],
    );
    assert.deepStrictEqual(
      actualResult.items.map(
        (item) => item.invitedContext?.qualifiedPurchaseChannel,
      ),
      ["CRYPTO_BOT", null],
    );
    assert.equal(
      "login" in (actualResult.items[0]?.webAccountContext ?? {}),
      false,
    );
    assert.equal(
      "email" in (actualResult.items[0]?.webAccountContext ?? {}),
      false,
    );
  });

  it("delegates current-subscription devices reads through internal-user seam unchanged", async () => {
    const getSubscriptionDevicesCalls: AdminUserIdentifierQueryDto[] = [];
    const query = { userId: "user-1" } as AdminUserIdentifierQueryDto;
    const internalResult = buildSubscriptionDevicesResult();
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        buildSearchResult(),
      getSubscriptionDevices: async (
        input: AdminUserIdentifierQueryDto,
      ): Promise<InternalUserSubscriptionDevicesInterface> => {
        getSubscriptionDevicesCalls.push(input);
        return internalResult;
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.getSubscriptionDevices(query);
    assert.equal(getSubscriptionDevicesCalls.length, 1);
    assert.equal(getSubscriptionDevicesCalls[0]?.userId, "user-1");
    assert.equal(
      actualResult.devices[0]?.deviceRef,
      buildDeviceRefForTest("device-1"),
    );
    assert.equal("hwid" in (actualResult.devices[0] ?? {}), false);
    assert.equal(actualResult.deviceCount, internalResult.deviceCount);
  });

  it("resolves opaque deviceRef before delegating single-device revocation through internal-user seam", async () => {
    const revokeSubscriptionDeviceCalls: Array<{
      query: AdminUserIdentifierQueryDto;
      hwid: string;
    }> = [];
    const query = { telegramId: "123456789" } as AdminUserIdentifierQueryDto;
    const input = {
      query,
      deviceRef: buildDeviceRefForTest("device-1"),
    };
    const internalResult = buildSubscriptionDevicesResult();
    const internalUserService = {
      getSearchResult: async (): Promise<AdminUserSearchResultInterface> =>
        buildSearchResult(),
      getSubscriptionDevices:
        async (): Promise<InternalUserSubscriptionDevicesInterface> =>
          internalResult,
      revokeSubscriptionDevice: async (payload: {
        query: AdminUserIdentifierQueryDto;
        hwid: string;
      }): Promise<InternalUserSubscriptionDevicesInterface> => {
        revokeSubscriptionDeviceCalls.push(payload);
        return internalResult;
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.revokeSubscriptionDevice(input);
    assert.equal(revokeSubscriptionDeviceCalls.length, 1);
    assert.equal(revokeSubscriptionDeviceCalls[0]?.hwid, "device-1");
    assert.equal(
      revokeSubscriptionDeviceCalls[0]?.query.telegramId,
      "123456789",
    );
    assert.equal(
      actualResult.devices[0]?.deviceRef,
      buildDeviceRefForTest("device-1"),
    );
    assert.equal("hwid" in (actualResult.devices[0] ?? {}), false);
  });

  it("resolves canonical userId and delegates rules acceptance to internal-user service", async () => {
    const query = { email: "user@example.com" } as AdminUserIdentifierQueryDto;
    const expectedSession = buildSessionResult();
    const getSearchResultCalls: AdminUserSearchQueryDto[] = [];
    const acceptRulesCalls: Array<{ userId: string }> = [];
    const internalUserService = {
      getSearchResult: async (
        input: AdminUserSearchQueryDto,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return buildSearchResult();
      },
      acceptRules: async (input: {
        userId: string;
      }): Promise<InternalUserSessionInterface> => {
        acceptRulesCalls.push(input);
        return expectedSession;
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.acceptRules(query);
    assert.equal(getSearchResultCalls.length, 1);
    assert.equal(getSearchResultCalls[0]?.email, "user@example.com");
    assert.deepStrictEqual(acceptRulesCalls, [{ userId: "user-1" }]);
    assert.deepStrictEqual(actualResult, expectedSession);
  });

  it("resolves canonical userId and delegates link prompt snooze to internal-user service", async () => {
    const query = { login: "user-login" } as AdminUserIdentifierQueryDto;
    const expectedSession = buildSessionResult();
    const getSearchResultCalls: AdminUserSearchQueryDto[] = [];
    const snoozeCalls: Array<{ userId: string }> = [];
    const internalUserService = {
      getSearchResult: async (
        input: AdminUserSearchQueryDto,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return buildSearchResult();
      },
      snoozeWebAccountLinkPrompt: async (input: {
        userId: string;
      }): Promise<InternalUserSessionInterface> => {
        snoozeCalls.push(input);
        return expectedSession;
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.snoozeWebAccountLinkPrompt(query);
    assert.equal(getSearchResultCalls.length, 1);
    assert.equal(getSearchResultCalls[0]?.login, "user-login");
    assert.deepStrictEqual(snoozeCalls, [{ userId: "user-1" }]);
    assert.deepStrictEqual(actualResult, expectedSession);
  });

  it("issues device provisioning challenges without returning secrets or provider device payloads", async () => {
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
    } as AdminUserDeviceProvisioningChallengeQueryDto;
    const dto = {
      reason: "support-confirmed-stale-device",
    } as IssueAdminUserDeviceProvisioningChallengeDto;
    const createCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const transactionEvents: string[] = [];
    const internalUserService = {} as unknown as InternalUserService;
    const userTransactionsHistoryService =
      {} as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {} as unknown as UserNotificationsService;
    const prismaService = {
      subscription: {
        findFirst: async (): Promise<{ id: string } | null> => ({
          id: query.subscriptionId,
        }),
      },
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<null> => null,
        create: async (): Promise<never> => {
          throw new Error("root challenge create must not be used");
        },
      },
      adminAuditLog: {
        create: async (): Promise<never> => {
          throw new Error("root audit create must not be used");
        },
      },
      $transaction: async <T>(callback: (tx: {
        adminDeviceProvisioningChallenge: {
          create: (input: unknown) => Promise<{
            id: string;
            status: "PENDING";
            reason: string | null;
            expiresAt: Date;
            consumedAt: Date | null;
            revokedAt: Date | null;
            attemptsLeft: number;
            createdAt: Date;
            updatedAt: Date;
          }>;
        };
        adminAuditLog: { create: (input: unknown) => Promise<{ id: string }> };
      }) => Promise<T>): Promise<T> => {
        transactionEvents.push("transaction.begin");
        const result = await callback({
          adminDeviceProvisioningChallenge: {
            create: async (input: unknown) => {
              transactionEvents.push("challenge.create");
              createCalls.push(input);
              return {
                id: "challenge-1",
                status: "PENDING",
                reason: dto.reason ?? null,
                expiresAt: new Date("2026-12-24T12:15:00.000Z"),
                consumedAt: null,
                revokedAt: null,
                attemptsLeft: 5,
                createdAt: new Date("2026-04-24T12:00:00.000Z"),
                updatedAt: new Date("2026-04-24T12:00:00.000Z"),
              };
            },
          },
          adminAuditLog: {
            create: async (input: unknown) => {
              transactionEvents.push("audit.create");
              auditCalls.push(input);
              return { id: "audit-1" };
            },
          },
        });
        transactionEvents.push("transaction.commit");
        return result;
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );

    const actualResult = await service.issueDeviceProvisioningChallenge({
      query,
      dto,
      adminUserId: "admin-1",
    });

    assert.equal(createCalls.length, 1);
    assert.equal(auditCalls.length, 1);
    assert.deepStrictEqual(transactionEvents, [
      "transaction.begin",
      "challenge.create",
      "audit.create",
      "transaction.commit",
    ]);
    assert.equal(actualResult.id, "challenge-1");
    assert.equal(actualResult.status, "PENDING");
    assert.equal(actualResult.reason, "support-confirmed-stale-device");
    assert.equal(JSON.stringify(actualResult).includes("challengeHash"), false);
    assert.equal(
      JSON.stringify(actualResult).includes("idempotencyKey"),
      false,
    );
    assert.equal(JSON.stringify(actualResult).includes("hwid"), false);
    assert.equal(JSON.stringify(actualResult).includes("userUuid"), false);
    assert.equal(
      JSON.stringify(createCalls[0]).includes("challengeHash"),
      true,
    );
  });

  it("reuses an active device provisioning challenge without creating a new one", async () => {
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
    } as AdminUserDeviceProvisioningChallengeQueryDto;
    const createCalls: unknown[] = [];
    const existingChallenge = {
      id: "challenge-existing",
      status: "PENDING" as const,
      reason: "already-issued",
      expiresAt: new Date("2026-12-24T12:15:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      attemptsLeft: 5,
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
    };
    const prismaService = {
      subscription: {
        findFirst: async (): Promise<{ id: string } | null> => ({
          id: query.subscriptionId,
        }),
      },
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<typeof existingChallenge> =>
          existingChallenge,
        create: async (input: unknown): Promise<typeof existingChallenge> => {
          createCalls.push(input);
          return existingChallenge;
        },
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
    );

    const actualResult = await service.issueDeviceProvisioningChallenge({
      query,
      dto: {
        reason: "new-request",
      } as IssueAdminUserDeviceProvisioningChallengeDto,
      adminUserId: "admin-1",
    });

    assert.equal(createCalls.length, 0);
    assert.equal(actualResult.id, "challenge-existing");
    assert.equal(actualResult.reason, "already-issued");
    assert.equal(JSON.stringify(actualResult).includes("challengeHash"), false);
  });

  it("revokes an active device provisioning challenge without exposing secrets", async () => {
    const query = {
      userId: "11111111-1111-4111-8111-111111111111",
      subscriptionId: "22222222-2222-4222-8222-222222222222",
    } as AdminUserDeviceProvisioningChallengeQueryDto;
    const updateCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const transactionEvents: string[] = [];
    const existingChallenge = {
      id: "challenge-existing",
      targetUserId: query.userId,
      subscriptionId: query.subscriptionId,
      status: "PENDING" as const,
      reason: "already-issued",
      expiresAt: new Date("2026-12-24T12:15:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      attemptsLeft: 5,
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
    };
    const prismaService = {
      subscription: {
        findFirst: async (): Promise<{ id: string }> => ({
          id: query.subscriptionId,
        }),
      },
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<typeof existingChallenge> =>
          existingChallenge,
        update: async (): Promise<never> => {
          throw new Error("root challenge update must not be used");
        },
      },
      adminAuditLog: {
        create: async (): Promise<never> => {
          throw new Error("root audit create must not be used");
        },
      },
      $transaction: async <T>(callback: (tx: {
        adminDeviceProvisioningChallenge: {
          update: (input: unknown) => Promise<Omit<typeof existingChallenge, "status" | "revokedAt"> & {
            status: "REVOKED";
            revokedAt: Date;
          }>;
        };
        adminAuditLog: { create: (input: unknown) => Promise<{ id: string }> };
      }) => Promise<T>): Promise<T> => {
        transactionEvents.push("transaction.begin");
        const result = await callback({
          adminDeviceProvisioningChallenge: {
            update: async (input: unknown) => {
              transactionEvents.push("challenge.update");
              updateCalls.push(input);
              return {
                ...existingChallenge,
                status: "REVOKED",
                revokedAt: new Date("2026-04-24T12:05:00.000Z"),
              };
            },
          },
          adminAuditLog: {
            create: async (input: unknown) => {
              transactionEvents.push("audit.create");
              auditCalls.push(input);
              return { id: "audit-1" };
            },
          },
        });
        transactionEvents.push("transaction.commit");
        return result;
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
    );

    const actualResult = await service.revokeDeviceProvisioningChallenge({
      query,
      challengeId: "challenge-existing",
      adminUserId: "admin-1",
    });

    assert.equal(updateCalls.length, 1);
    assert.equal(auditCalls.length, 1);
    assert.deepStrictEqual(transactionEvents, [
      "transaction.begin",
      "challenge.update",
      "audit.create",
      "transaction.commit",
    ]);
    assert.equal(actualResult.status, "REVOKED");
    assert.equal(actualResult.revokedAt, "2026-04-24T12:05:00.000Z");
    assert.equal(JSON.stringify(actualResult).includes("challengeHash"), false);
    assert.equal(JSON.stringify(actualResult).includes("hwid"), false);
  });

  it("redeems an active device provisioning challenge through backend-only Remnawave adapter", async () => {
    const createDeviceCalls: unknown[] = [];
    const updateCalls: unknown[] = [];
    const updateManyCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const executionEvents: string[] = [];
    const challenge = {
      id: "challenge-existing",
      adminUserId: "admin-1",
      targetUserId: "user-1",
      subscriptionId: "subscription-1",
      purpose: "DEVICE_PROVISIONING" as const,
      status: "PENDING" as const,
      reason: "already-issued",
      expiresAt: new Date("2026-12-24T12:15:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      attemptsLeft: 5,
      meta: null,
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
      subscription: {
        id: "subscription-1",
        remnawaveId: "remnawave-user-uuid-1",
      },
    };
    const claimTransactionClient = {
      adminDeviceProvisioningChallenge: {
        updateMany: async (input: unknown): Promise<{ count: number }> => {
          executionEvents.push("challenge.claim.updateMany");
          updateManyCalls.push(input);
          return { count: 1 };
        },
        findUnique: async (): Promise<Omit<typeof challenge, "status"> & { status: "PROCESSING" }> => {
          executionEvents.push("challenge.claim.findUnique");
          return {
            ...challenge,
            status: "PROCESSING",
            updatedAt: new Date("2026-04-24T12:01:00.000Z"),
          };
        },
      },
    } as unknown as PrismaService;
    const postProviderTransactionClient = {
      adminDeviceProvisioningChallenge: {
        update: async (
          input: unknown,
        ): Promise<
          Omit<typeof challenge, "status" | "consumedAt"> & {
            status: "CONSUMED";
            consumedAt: Date;
          }
        > => {
          executionEvents.push("challenge.update");
          updateCalls.push(input);
          return {
            ...challenge,
            status: "CONSUMED",
            consumedAt: new Date("2026-04-24T12:05:00.000Z"),
          };
        },
      },
      adminAuditLog: {
        create: async (input: unknown): Promise<{ id: string }> => {
          executionEvents.push("audit.create");
          auditCalls.push(input);
          return { id: "audit-1" };
        },
      },
    } as unknown as PrismaService;
    let transactionIndex = 0;
    const prismaService = {
      $transaction: async <T>(callback: (tx: PrismaService) => Promise<T>): Promise<T> => {
        transactionIndex += 1;
        if (transactionIndex === 1) {
          executionEvents.push("claim.transaction.begin");
          const result = await callback(claimTransactionClient);
          executionEvents.push("claim.transaction.commit");
          return result;
        }
        executionEvents.push("post-provider.transaction.begin");
        const result = await callback(postProviderTransactionClient);
        executionEvents.push("post-provider.transaction.commit");
        return result;
      },
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<typeof challenge> => challenge,
        findUnique: async (): Promise<never> => {
          throw new Error("root adminDeviceProvisioningChallenge.findUnique should not be used inside redeem claim");
        },
        updateMany: async (): Promise<never> => {
          throw new Error("root adminDeviceProvisioningChallenge.updateMany should not be used inside redeem claim");
        },
        update: async (): Promise<never> => {
          throw new Error("root adminDeviceProvisioningChallenge.update should not be used for redeem success");
        },
      },
      adminAuditLog: {
        create: async (): Promise<never> => {
          throw new Error("root adminAuditLog.create should not be used for redeem success");
        },
      },
    } as unknown as PrismaService;
    const remnawaveApiService = {
      createUserSubscriptionDevice: async (
        input: unknown,
      ): Promise<{ deviceCount: number; devices: readonly [] }> => {
        executionEvents.push("remnawave.createUserSubscriptionDevice");
        createDeviceCalls.push(input);
        return { deviceCount: 2, devices: [] };
      },
    } as unknown as RemnawaveApiService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    const actualResult = await service.redeemDeviceProvisioningChallenge({
      challengeId: "challenge-existing",
      dto: {
        hwid: " raw-hwid-1 ",
        platform: "ios",
        osVersion: "17.0",
        deviceModel: "iPhone",
        userAgent: "RezeisApp/1.0",
      } as RedeemDeviceProvisioningChallengeDto,
    });

    assert.deepStrictEqual(createDeviceCalls, [
      {
        remnawaveSubscriptionId: "remnawave-user-uuid-1",
        hwid: "raw-hwid-1",
        platform: "ios",
        osVersion: "17.0",
        deviceModel: "iPhone",
        userAgent: "RezeisApp/1.0",
      },
    ]);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateManyCalls.length, 1);
    assert.equal(auditCalls.length, 1);
    assert.deepStrictEqual(executionEvents, [
      "claim.transaction.begin",
      "challenge.claim.updateMany",
      "challenge.claim.findUnique",
      "claim.transaction.commit",
      "remnawave.createUserSubscriptionDevice",
      "post-provider.transaction.begin",
      "challenge.update",
      "audit.create",
      "post-provider.transaction.commit",
    ]);
    assert.deepStrictEqual(actualResult, {
      challengeId: "challenge-existing",
      status: "CONSUMED",
      consumedAt: "2026-04-24T12:05:00.000Z",
      deviceCount: 2,
    });
    assert.equal(JSON.stringify(actualResult).includes("hwid"), false);
    assert.equal(
      JSON.stringify(actualResult).includes("remnawave-user-uuid-1"),
      false,
    );
  });

  it("does not run provider-failure recovery writes when redeem post-provider transaction fails", async () => {
    const executionEvents: string[] = [];
    const rootUpdateCalls: unknown[] = [];
    const challenge = {
      id: "challenge-existing",
      purpose: "DEVICE_PROVISIONING" as const,
      status: "PENDING" as const,
      reason: "operator-issued",
      expiresAt: new Date("2026-12-24T12:15:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      attemptsLeft: 4,
      meta: { scope: "current-subscription" },
      adminUserId: "admin-1",
      targetUserId: "user-1",
      subscriptionId: "subscription-1",
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
      subscription: {
        id: "subscription-1",
        remnawaveId: "remnawave-user-uuid-1",
      },
    };
    const claimTransactionClient = {
      adminDeviceProvisioningChallenge: {
        updateMany: async (): Promise<{ count: number }> => {
          executionEvents.push("challenge.claim.updateMany");
          return { count: 1 };
        },
        findUnique: async (): Promise<Omit<typeof challenge, "status"> & { status: "PROCESSING" }> => {
          executionEvents.push("challenge.claim.findUnique");
          return {
            ...challenge,
            status: "PROCESSING",
            updatedAt: new Date("2026-04-24T12:01:00.000Z"),
          };
        },
      },
    } as unknown as PrismaService;
    let transactionIndex = 0;
    const prismaService = {
      $transaction: async <T>(callback: (tx: PrismaService) => Promise<T>): Promise<T> => {
        transactionIndex += 1;
        if (transactionIndex === 1) {
          executionEvents.push("claim.transaction.begin");
          const result = await callback(claimTransactionClient);
          executionEvents.push("claim.transaction.commit");
          return result;
        }
        executionEvents.push("post-provider.transaction.begin");
        throw new Error("post-provider transaction failed");
      },
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<typeof challenge> => challenge,
        update: async (input: unknown): Promise<never> => {
          rootUpdateCalls.push(input);
          throw new Error("root provider-failure recovery update should not run after post-provider transaction failure");
        },
      },
    } as unknown as PrismaService;
    const remnawaveApiService = {
      createUserSubscriptionDevice: async (): Promise<{ deviceCount: number; devices: readonly [] }> => {
        executionEvents.push("remnawave.createUserSubscriptionDevice");
        return { deviceCount: 2, devices: [] };
      },
    } as unknown as RemnawaveApiService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    await assert.rejects(
      () =>
        service.redeemDeviceProvisioningChallenge({
          challengeId: "challenge-existing",
          dto: { hwid: "raw-hwid-1" } as RedeemDeviceProvisioningChallengeDto,
        }),
      /post-provider transaction failed/,
    );

    assert.deepStrictEqual(executionEvents, [
      "claim.transaction.begin",
      "challenge.claim.updateMany",
      "challenge.claim.findUnique",
      "claim.transaction.commit",
      "remnawave.createUserSubscriptionDevice",
      "post-provider.transaction.begin",
    ]);
    assert.deepStrictEqual(rootUpdateCalls, []);
  });

  it("returns consumed redemption result idempotently without calling provider again", async () => {
    const createDeviceCalls: unknown[] = [];
    const challenge = {
      id: "challenge-consumed",
      purpose: "DEVICE_PROVISIONING" as const,
      status: "CONSUMED" as const,
      reason: "already-issued",
      expiresAt: new Date("2026-12-24T12:15:00.000Z"),
      consumedAt: new Date("2026-04-24T12:05:00.000Z"),
      revokedAt: null,
      attemptsLeft: 4,
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:05:00.000Z"),
      subscription: {
        id: "subscription-1",
        remnawaveId: "remnawave-user-uuid-1",
      },
    };
    const prismaService = {
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<typeof challenge> => challenge,
      },
    } as unknown as PrismaService;
    const remnawaveApiService = {
      createUserSubscriptionDevice: async (input: unknown): Promise<never> => {
        createDeviceCalls.push(input);
        throw new Error("unexpected provider call");
      },
    } as unknown as RemnawaveApiService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    const actualResult = await service.redeemDeviceProvisioningChallenge({
      challengeId: "challenge-consumed",
      dto: { hwid: "raw-hwid-1" } as RedeemDeviceProvisioningChallengeDto,
    });

    assert.deepStrictEqual(createDeviceCalls, []);
    assert.deepStrictEqual(actualResult, {
      challengeId: "challenge-consumed",
      status: "CONSUMED",
      consumedAt: "2026-04-24T12:05:00.000Z",
      deviceCount: 0,
    });
  });

  it("reopens a challenge with bounded provider failure code after provider failure", async () => {
    const updateCalls: unknown[] = [];
    const updateManyCalls: unknown[] = [];
    const challenge = {
      id: "challenge-existing",
      adminUserId: "admin-1",
      targetUserId: "user-1",
      subscriptionId: "subscription-1",
      purpose: "DEVICE_PROVISIONING" as const,
      status: "PENDING" as const,
      reason: "already-issued",
      expiresAt: new Date("2026-12-24T12:15:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      attemptsLeft: 2,
      meta: null,
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
      subscription: {
        id: "subscription-1",
        remnawaveId: "remnawave-user-uuid-1",
      },
    };
    const rawProviderDiagnostic =
      "provider failed https://remnawave.example/profile/0194f4b6-7cc7-7ecb-9f62-123456789abc?token=raw-provider-token-secret subscriptionUrl=configUrl auth cookie";
    const providerError = new Error(rawProviderDiagnostic);
    const prismaService = {
      $transaction: async <T>(callback: (tx: PrismaService) => Promise<T>): Promise<T> =>
        callback(prismaService as unknown as PrismaService),
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<typeof challenge> => challenge,
        findUnique: async (): Promise<Omit<typeof challenge, "status"> & { status: "PROCESSING" }> => ({
          ...challenge,
          status: "PROCESSING",
        }),
        updateMany: async (input: unknown): Promise<{ count: number }> => {
          updateManyCalls.push(input);
          return { count: 1 };
        },
        update: async (input: unknown): Promise<typeof challenge> => {
          updateCalls.push(input);
          return challenge;
        },
      },
    } as unknown as PrismaService;
    const remnawaveApiService = {
      createUserSubscriptionDevice: async (): Promise<never> => {
        throw providerError;
      },
    } as unknown as RemnawaveApiService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    await assert.rejects(
      () =>
        service.redeemDeviceProvisioningChallenge({
          challengeId: "challenge-existing",
          dto: { hwid: "raw-hwid-1" } as RedeemDeviceProvisioningChallengeDto,
        }),
      /provider failed/,
    );

    assert.equal(updateManyCalls.length, 1);
    assert.equal(updateCalls.length, 1);
    const serializedUpdate = JSON.stringify(updateCalls[0]);
    assert.equal(serializedUpdate.includes('"attemptsLeft":1'), true);
    assert.equal(serializedUpdate.includes('"status":"PENDING"'), true);
    assert.equal(serializedUpdate.includes('"lastFailureCode":"REMNAWAVE_PROVIDER_ERROR"'), true);
    assert.equal(serializedUpdate.includes(rawProviderDiagnostic), false);
    assert.equal(serializedUpdate.includes('raw-provider-token-secret'), false);
    assert.equal(serializedUpdate.includes('0194f4b6-7cc7-7ecb-9f62-123456789abc'), false);
    assert.equal(serializedUpdate.includes('https://remnawave.example'), false);
  });

  it("returns consumed success if another worker consumed the challenge first", async () => {
    const createDeviceCalls: unknown[] = [];
    const updateManyCalls: unknown[] = [];
    const initialChallenge = {
      id: "challenge-existing",
      purpose: "DEVICE_PROVISIONING" as const,
      status: "PENDING" as const,
      reason: "already-issued",
      expiresAt: new Date("2026-12-24T12:15:00.000Z"),
      consumedAt: null,
      revokedAt: null,
      attemptsLeft: 5,
      meta: null,
      createdAt: new Date("2026-04-24T12:00:00.000Z"),
      updatedAt: new Date("2026-04-24T12:00:00.000Z"),
      subscription: {
        id: "subscription-1",
        remnawaveId: "remnawave-user-uuid-1",
      },
    };
    const consumedChallenge = {
      ...initialChallenge,
      status: "CONSUMED" as const,
      consumedAt: new Date("2026-04-24T12:05:00.000Z"),
      updatedAt: new Date("2026-04-24T12:05:00.000Z"),
    };
    const prismaService = {
      $transaction: async <T>(callback: (tx: PrismaService) => Promise<T>): Promise<T> =>
        callback(prismaService as unknown as PrismaService),
      adminDeviceProvisioningChallenge: {
        findFirst: async (): Promise<typeof initialChallenge> => initialChallenge,
        findUnique: async (): Promise<typeof consumedChallenge> => consumedChallenge,
        updateMany: async (input: unknown): Promise<{ count: number }> => {
          updateManyCalls.push(input);
          return { count: 0 };
        },
      },
    } as unknown as PrismaService;
    const remnawaveApiService = {
      createUserSubscriptionDevice: async (input: unknown): Promise<never> => {
        createDeviceCalls.push(input);
        throw new Error("unexpected provider call");
      },
    } as unknown as RemnawaveApiService;
    const service = new AdminUsersService(
      {} as unknown as InternalUserService,
      {} as unknown as UserTransactionsHistoryService,
      {} as unknown as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      remnawaveApiService,
    );

    const actualResult = await service.redeemDeviceProvisioningChallenge({
      challengeId: "challenge-existing",
      dto: { hwid: "raw-hwid-1" } as RedeemDeviceProvisioningChallengeDto,
    });

    assert.equal(updateManyCalls.length, 1);
    assert.deepStrictEqual(createDeviceCalls, []);
    assert.deepStrictEqual(actualResult, {
      challengeId: "challenge-existing",
      status: "CONSUMED",
      consumedAt: "2026-04-24T12:05:00.000Z",
      deviceCount: 0,
    });
  });

  it("rejects inactive or missing device provisioning challenges before provider calls", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly challenge: null | {
        readonly id: string;
        readonly purpose: "DEVICE_PROVISIONING" | "OTHER_PURPOSE";
        readonly status: "PENDING" | "REVOKED" | "CONSUMED";
        readonly expiresAt: Date;
        readonly consumedAt: Date | null;
        readonly revokedAt: Date | null;
        readonly attemptsLeft: number;
        readonly subscription: {
          readonly remnawaveId: string;
        };
      };
    }> = [
      { name: "missing", challenge: null },
      {
        name: "expired",
        challenge: {
          id: "challenge-expired",
          purpose: "DEVICE_PROVISIONING",
          status: "PENDING",
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
          consumedAt: null,
          revokedAt: null,
          attemptsLeft: 5,
          subscription: { remnawaveId: "remnawave-user-uuid-1" },
        },
      },
      {
        name: "revoked",
        challenge: {
          id: "challenge-revoked",
          purpose: "DEVICE_PROVISIONING",
          status: "REVOKED",
          expiresAt: new Date("2026-12-24T12:15:00.000Z"),
          consumedAt: null,
          revokedAt: new Date("2026-04-24T12:05:00.000Z"),
          attemptsLeft: 5,
          subscription: { remnawaveId: "remnawave-user-uuid-1" },
        },
      },
      {
        name: "consumed",
        challenge: {
          id: "challenge-consumed",
          purpose: "DEVICE_PROVISIONING",
          status: "CONSUMED",
          expiresAt: new Date("2026-12-24T12:15:00.000Z"),
          consumedAt: new Date("2026-04-24T12:05:00.000Z"),
          revokedAt: null,
          attemptsLeft: 5,
          subscription: { remnawaveId: "remnawave-user-uuid-1" },
        },
      },
      {
        name: "wrong purpose",
        challenge: {
          id: "challenge-wrong-purpose",
          purpose: "OTHER_PURPOSE",
          status: "PENDING",
          expiresAt: new Date("2026-12-24T12:15:00.000Z"),
          consumedAt: null,
          revokedAt: null,
          attemptsLeft: 5,
          subscription: { remnawaveId: "remnawave-user-uuid-1" },
        },
      },
    ];

    for (const testCase of cases) {
      const createDeviceCalls: unknown[] = [];
      const updateCalls: unknown[] = [];
      const prismaService = {
        adminDeviceProvisioningChallenge: {
          findFirst: async (): Promise<typeof testCase.challenge> =>
            testCase.challenge,
          update: async (input: unknown): Promise<never> => {
            updateCalls.push(input);
            throw new Error("unexpected update");
          },
        },
      } as unknown as PrismaService;
      const remnawaveApiService = {
        createUserSubscriptionDevice: async (
          input: unknown,
        ): Promise<never> => {
          createDeviceCalls.push(input);
          throw new Error("unexpected provider call");
        },
      } as unknown as RemnawaveApiService;
      const service = new AdminUsersService(
        {} as unknown as InternalUserService,
        {} as unknown as UserTransactionsHistoryService,
        {} as unknown as UserNotificationsService,
        prismaService,
        undefined,
        undefined,
        remnawaveApiService,
      );

      if (testCase.name === "consumed") {
        const actualResult = await service.redeemDeviceProvisioningChallenge({
          challengeId: testCase.name,
          dto: { hwid: "raw-hwid-1" } as RedeemDeviceProvisioningChallengeDto,
        });
        assert.deepStrictEqual(actualResult, {
          challengeId: "challenge-consumed",
          status: "CONSUMED",
          consumedAt: "2026-04-24T12:05:00.000Z",
          deviceCount: 0,
        });
      } else {
        await assert.rejects(
          () =>
            service.redeemDeviceProvisioningChallenge({
              challengeId: testCase.name,
              dto: { hwid: "raw-hwid-1" } as RedeemDeviceProvisioningChallengeDto,
            }),
          testCase.challenge === null ||
            testCase.challenge.purpose !== "DEVICE_PROVISIONING"
            ? /DEVICE_PROVISIONING_CHALLENGE_NOT_FOUND/
            : /DEVICE_PROVISIONING_CHALLENGE_NOT_ACTIVE/,
        );
      }
      assert.deepStrictEqual(createDeviceCalls, []);
      assert.deepStrictEqual(updateCalls, []);
    }
  });

  it("resolves canonical userId and delegates email challenge issuance to internal-user service", async () => {
    const query = { telegramId: "123456789" } as AdminUserIdentifierQueryDto;
    const expectedChallenge = buildEmailVerificationChallengeResult();
    const getSearchResultCalls: AdminUserSearchQueryDto[] = [];
    const issueCalls: Array<{ userId: string }> = [];
    const internalUserService = {
      getSearchResult: async (
        input: AdminUserSearchQueryDto,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return buildSearchResult();
      },
      issueWebAccountEmailVerificationChallenge: async (input: {
        userId: string;
      }): Promise<InternalWebAccountEmailVerificationChallengeInterface> => {
        issueCalls.push(input);
        return expectedChallenge;
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult =
      await service.issueWebAccountEmailVerificationChallenge(query);
    assert.equal(getSearchResultCalls.length, 1);
    assert.equal(getSearchResultCalls[0]?.telegramId, "123456789");
    assert.deepStrictEqual(issueCalls, [{ userId: "user-1" }]);
    assert.deepStrictEqual(actualResult, expectedChallenge);
  });

  it("resolves canonical userId and delegates activity transactions reads to user-activity service", async () => {
    const query = {
      email: "user@example.com",
      status: TransactionStatus.COMPLETED,
      gatewayType: PaymentGatewayType.CRYPTOMUS,
      purchaseType: PurchaseType.NEW,
      page: 2,
      limit: 10,
    } as AdminUserActivityTransactionsQueryDto;
    const expectedResult = buildTransactionsResult();
    const getSearchResultCalls: AdminUserSearchQueryDto[] = [];
    const listTransactionsCalls: Array<Record<string, unknown>> = [];
    const internalUserService = {
      getSearchResult: async (
        input: AdminUserSearchQueryDto,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return buildSearchResult();
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions: async (
        input: Record<string, unknown>,
      ): Promise<PaginatedUserActivityTransactionsInterface> => {
        listTransactionsCalls.push(input);
        return expectedResult;
      },
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications:
        async (): Promise<PaginatedUserActivityNotificationsInterface> =>
          buildNotificationsResult(),
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.listActivityTransactions(query);
    assert.equal(getSearchResultCalls.length, 1);
    assert.equal(getSearchResultCalls[0]?.email, "user@example.com");
    assert.deepStrictEqual(listTransactionsCalls, [
      {
        userId: "user-1",
        status: TransactionStatus.COMPLETED,
        gatewayType: PaymentGatewayType.CRYPTOMUS,
        purchaseType: PurchaseType.NEW,
        page: 2,
        limit: 10,
      },
    ]);
    assert.deepStrictEqual(actualResult, expectedResult);
  });

  it("resolves canonical userId and delegates activity notifications reads to user-activity service", async () => {
    const query = {
      telegramId: "123456789",
      isRead: false,
      type: "subscription.expiring",
      page: 3,
      limit: 5,
    } as AdminUserActivityNotificationsQueryDto;
    const expectedResult = buildNotificationsResult();
    const getSearchResultCalls: AdminUserSearchQueryDto[] = [];
    const listNotificationsCalls: Array<Record<string, unknown>> = [];
    const internalUserService = {
      getSearchResult: async (
        input: AdminUserSearchQueryDto,
      ): Promise<AdminUserSearchResultInterface> => {
        getSearchResultCalls.push(input);
        return buildSearchResult();
      },
    } as unknown as InternalUserService;
    const userTransactionsHistoryService = {
      listTransactions:
        async (): Promise<PaginatedUserActivityTransactionsInterface> =>
          buildTransactionsResult(),
    } as unknown as UserTransactionsHistoryService;
    const userNotificationsService = {
      listNotifications: async (
        input: Record<string, unknown>,
      ): Promise<PaginatedUserActivityNotificationsInterface> => {
        listNotificationsCalls.push(input);
        return expectedResult;
      },
    } as unknown as UserNotificationsService;
    const prismaService = {
      user: {
        findMany: async (): Promise<never[]> => [],
      },
    } as unknown as PrismaService;
    const service = new AdminUsersService(
      internalUserService,
      userTransactionsHistoryService,
      userNotificationsService,
      prismaService,
    );
    const actualResult = await service.listActivityNotifications(query);
    assert.equal(getSearchResultCalls.length, 1);
    assert.equal(getSearchResultCalls[0]?.telegramId, "123456789");
    assert.deepStrictEqual(listNotificationsCalls, [
      {
        userId: "user-1",
        isRead: false,
        type: "subscription.expiring",
        page: 3,
        limit: 5,
      },
    ]);
    assert.deepStrictEqual(actualResult, expectedResult);
  });

  it("hides Telegram delivery message identifiers in support message delivery responses and audit metadata", async () => {
    let auditMetadata: unknown = null;
    const sentMessages: unknown[] = [];
    const prismaService = {
      adminAuditLog: {
        findMany: async () => [],
        findFirst: async () => ({
          id: "draft-audit-1",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          metadata: {
            targetUserId: "user-1",
            messageBody: "Support message content",
            messageLength: 24,
            messagePreview: "Message content hidden",
          },
        }),
        create: async (input: { readonly data: { readonly metadata: unknown } }) => {
          auditMetadata = input.data.metadata;
          return { id: "delivery-audit-1", createdAt: new Date("2026-04-01T00:05:00.000Z") };
        },
      },
      user: {
        findUnique: async () => ({ id: "user-1", telegramId: 123456789n, isBotBlocked: false }),
      },
    } as unknown as PrismaService;
    const deliveryService = {
      send: async (input: unknown) => {
        sentMessages.push(input);
        return { deliveryState: "delivered", telegramMessageId: 987654321 };
      },
    } as never;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      undefined,
      deliveryService,
    );

    const result = await service.sendUserSupportMessageDraft({
      adminUserId: "admin-1",
      userId: "user-1",
      draftId: "draft-1",
      dto: { reason: "operator confirmed" },
    });

    assert.equal(result.deliveryState, "delivered");
    assert.equal(result.telegramMessageId, null);
    assert.equal(sentMessages.length, 1);
    const serializedAudit = JSON.stringify(auditMetadata);
    assert.equal(serializedAudit.includes("987654321"), false);
    assert.equal(serializedAudit.includes("telegramMessageId\":"), false);
    assert.equal(serializedAudit.includes("telegramMessageIdPresent"), true);
  });

  it("hides historical Telegram delivery message identifiers on support message idempotent replay", async () => {
    const idempotencyKeyHash = createHash("sha256").update("support-delivery-key").digest("hex");
    const prismaService = {
      adminAuditLog: {
        findMany: async () => [
          {
            id: "delivery-audit-1",
            createdAt: new Date("2026-04-01T00:05:00.000Z"),
            metadata: {
              targetUserId: "user-1",
              draftId: "draft-1",
              deliveryState: "delivered",
              delivered: true,
              telegramMessageId: 987654321,
              idempotencyKeyHash,
            },
          },
        ],
        findFirst: async () => {
          throw new Error("draft lookup should be skipped on replay");
        },
        create: async () => {
          throw new Error("audit create should be skipped on replay");
        },
      },
    } as unknown as PrismaService;
    const deliveryService = {
      send: async () => {
        throw new Error("Telegram delivery should be skipped on replay");
      },
    } as never;
    const service = new AdminUsersService(
      {} as InternalUserService,
      {} as UserTransactionsHistoryService,
      {} as UserNotificationsService,
      prismaService,
      undefined,
      undefined,
      undefined,
      deliveryService,
    );

    const result = await service.sendUserSupportMessageDraft({
      adminUserId: "admin-1",
      userId: "user-1",
      draftId: "draft-1",
      dto: { idempotencyKey: "support-delivery-key" },
    });

    assert.equal(result.idempotentReplay, true);
    assert.equal(result.deliveryState, "delivered");
    assert.equal(result.delivered, true);
    assert.equal(result.telegramMessageId, null);
    assert.equal(JSON.stringify(result).includes("987654321"), false);
  });
});
