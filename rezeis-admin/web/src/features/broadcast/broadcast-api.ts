import { z } from "zod";
import { api } from "@/lib/api";

const audienceSchema = z.enum([
  "ALL",
  "BLOCKED",
  "ACTIVE_SUBSCRIPTION",
  "UNSUBSCRIBED",
  "EXPIRED_SUBSCRIPTION",
  "TRIAL_SUBSCRIPTION",
  "RECENT_REGISTERED",
]);
const draftSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  audience: audienceSchema,
  payload: z.object({ title: z.string(), message: z.string(), buttonText: z.string().nullable().optional(), buttonUrl: z.string().nullable().optional(), mediaUrl: z.string().nullable().optional() }),
  totalCount: z.number(),
  successCount: z.number(),
  failedCount: z.number(),
  createdAt: z.string(),
});
const previewSchema = z.object({
  audience: audienceSchema,
  totalCount: z.number(),
  sampleUserIds: z.array(z.string()),
});
const draftPreviewSchema = z.object({
  draftId: z.string(),
  isValid: z.boolean(),
  titlePreview: z.string(),
  messagePreview: z.string(),
  audience: audienceSchema,
  totalCount: z.number(),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["ERROR", "WARNING"]),
      message: z.string(),
    }),
  ),
});
const readinessSchema = z.object({
  draftId: z.string(),
  readyForFutureDelivery: z.boolean(),
  checks: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      passed: z.boolean(),
      severity: z.enum(["BLOCKER", "WARNING", "INFO"]),
    }),
  ),
  blockedReasonCodes: z.array(z.string()),
});
const prepareSendSchema = z.object({
  runId: z.string().optional(),
  draftId: z.string(),
  status: z.enum(["READY", "BLOCKED", "IN_PROGRESS", "COMPLETED", "COMPLETED_WITH_FAILURES"]),
  deliveryEnabled: z.literal(false),
  audienceCount: z.number(),
  eligibleTelegramUsers: z.number(),
  preparedMessages: z.number(),
  blockedReasonCodes: z.array(z.string()),
});
const deliveryRunSchema = prepareSendSchema.extend({
  runId: z.string(),
  createdAt: z.string(),
});
const deliveryRunDetailSchema = deliveryRunSchema.extend({
  recipientStatusCounts: z.array(z.object({ status: z.string(), count: z.number() })),
  sampleRecipientUserIds: z.array(z.string()),
  sampleRecipients: z.array(z.object({ recipientId: z.string(), userId: z.string(), status: z.string() })),
});
const executeRecipientSchema = z.object({
  runId: z.string(),
  recipientId: z.string(),
  userId: z.string(),
  status: z.enum(["DELIVERED", "FAILED"]),
  telegramMessageId: z.number().nullable(),
  errorCode: z.string().nullable(),
  checkedAt: z.string(),
});
const executeBatchSchema = z.object({
  runId: z.string(),
  attempted: z.number(),
  delivered: z.number(),
  failed: z.number(),
  remainingStaged: z.number(),
  checkedAt: z.string(),
});
const cancelRunSchema = z.object({
  runId: z.string(),
  status: z.enum(["CANCELLED", "BLOCKED"]),
  cancelledRecipients: z.number(),
  checkedAt: z.string(),
});
const deleteRecipientMessageSchema = z.object({
  runId: z.string(),
  recipientId: z.string(),
  userId: z.string(),
  status: z.enum(["DELETED", "BLOCKED"]),
  deleted: z.boolean(),
  checkedAt: z.string(),
});
const deleteDeliveredBatchSchema = z.object({
  runId: z.string(),
  attempted: z.number(),
  deleted: z.number(),
  blocked: z.number(),
  remainingDelivered: z.number(),
  checkedAt: z.string(),
});
const retryFailedSchema = z.object({
  runId: z.string(),
  retriedRecipients: z.number(),
  checkedAt: z.string(),
});

export type BroadcastAudience = z.infer<typeof audienceSchema>;
export type BroadcastDraft = z.infer<typeof draftSchema>;
export type BroadcastAudiencePreview = z.infer<typeof previewSchema>;
export type BroadcastDraftPreview = z.infer<typeof draftPreviewSchema>;
export type BroadcastDraftReadiness = z.infer<typeof readinessSchema>;
export type BroadcastPrepareSend = z.infer<typeof prepareSendSchema>;
export type BroadcastDeliveryRun = z.infer<typeof deliveryRunSchema>;
export type BroadcastDeliveryRunDetail = z.infer<typeof deliveryRunDetailSchema>;
export type BroadcastExecuteRecipient = z.infer<typeof executeRecipientSchema>;
export type BroadcastExecuteBatch = z.infer<typeof executeBatchSchema>;
export type BroadcastCancelRun = z.infer<typeof cancelRunSchema>;
export type BroadcastDeleteRecipientMessage = z.infer<typeof deleteRecipientMessageSchema>;
export type BroadcastDeleteDeliveredBatch = z.infer<typeof deleteDeliveredBatchSchema>;
export type BroadcastRetryFailed = z.infer<typeof retryFailedSchema>;

export const broadcastApi = {
  async listDrafts(): Promise<readonly BroadcastDraft[]> {
    const response = await api.get("/admin/broadcast/drafts");
    return z.object({ data: z.array(draftSchema) }).parse(response.data).data;
  },
  async createDraft(input: {
    readonly audience: BroadcastAudience;
    readonly title: string;
    readonly message: string;
    readonly buttonText?: string;
    readonly buttonUrl?: string;
    readonly mediaUrl?: string;
  }): Promise<BroadcastDraft> {
    const response = await api.post("/admin/broadcast/drafts", input);
    return z.object({ data: draftSchema }).parse(response.data).data;
  },
  async updateDraft(input: {
    readonly draftId: string;
    readonly audience: BroadcastAudience;
    readonly title: string;
    readonly message: string;
    readonly buttonText?: string;
    readonly buttonUrl?: string;
    readonly mediaUrl?: string;
  }): Promise<BroadcastDraft> {
    const { draftId, ...body } = input;
    const response = await api.patch(
      `/admin/broadcast/drafts/${encodeURIComponent(draftId)}`,
      body,
    );
    return z.object({ data: draftSchema }).parse(response.data).data;
  },
  async previewAudience(
    audience: BroadcastAudience,
  ): Promise<BroadcastAudiencePreview> {
    const response = await api.get("/admin/broadcast/audience-preview", {
      params: { audience },
    });
    return z.object({ data: previewSchema }).parse(response.data).data;
  },
  async previewDraft(draftId: string): Promise<BroadcastDraftPreview> {
    const response = await api.get(
      `/admin/broadcast/drafts/${encodeURIComponent(draftId)}/preview`,
    );
    return z.object({ data: draftPreviewSchema }).parse(response.data).data;
  },
  async getDraftReadiness(draftId: string): Promise<BroadcastDraftReadiness> {
    const response = await api.get(
      `/admin/broadcast/drafts/${encodeURIComponent(draftId)}/readiness`,
    );
    return z.object({ data: readinessSchema }).parse(response.data).data;
  },
  async prepareSend(draftId: string): Promise<BroadcastPrepareSend> {
    const response = await api.post(
      `/admin/broadcast/drafts/${encodeURIComponent(draftId)}/prepare-send`,
      {},
    );
    return z.object({ data: prepareSendSchema }).parse(response.data).data;
  },
  async listDeliveryRuns(draftId: string): Promise<readonly BroadcastDeliveryRun[]> {
    const response = await api.get(
      `/admin/broadcast/drafts/${encodeURIComponent(draftId)}/delivery-runs`,
    );
    return z.object({ data: z.array(deliveryRunSchema) }).parse(response.data).data;
  },
  async getDeliveryRun(runId: string): Promise<BroadcastDeliveryRunDetail> {
    const response = await api.get(`/admin/broadcast/delivery-runs/${encodeURIComponent(runId)}`);
    return z.object({ data: deliveryRunDetailSchema }).parse(response.data).data;
  },
  async executeNextRecipient(runId: string): Promise<BroadcastExecuteRecipient> {
    const response = await api.post(
      `/admin/broadcast/delivery-runs/${encodeURIComponent(runId)}/execute-next-recipient`,
      {},
    );
    return z.object({ data: executeRecipientSchema }).parse(response.data).data;
  },
  async executeBatch(runId: string): Promise<BroadcastExecuteBatch> {
    const response = await api.post(
      `/admin/broadcast/delivery-runs/${encodeURIComponent(runId)}/execute-batch`,
      {},
    );
    return z.object({ data: executeBatchSchema }).parse(response.data).data;
  },
  async cancelRun(runId: string): Promise<BroadcastCancelRun> {
    const response = await api.post(
      `/admin/broadcast/delivery-runs/${encodeURIComponent(runId)}/cancel`,
      {},
    );
    return z.object({ data: cancelRunSchema }).parse(response.data).data;
  },
  async deleteRecipientMessage(recipientId: string): Promise<BroadcastDeleteRecipientMessage> {
    const response = await api.post(
      `/admin/broadcast/delivery-recipients/${encodeURIComponent(recipientId)}/delete-message`,
      {},
    );
    return z.object({ data: deleteRecipientMessageSchema }).parse(response.data).data;
  },
  async deleteDeliveredBatch(runId: string): Promise<BroadcastDeleteDeliveredBatch> {
    const response = await api.post(
      `/admin/broadcast/delivery-runs/${encodeURIComponent(runId)}/delete-delivered-batch`,
      {},
    );
    return z.object({ data: deleteDeliveredBatchSchema }).parse(response.data).data;
  },
  async retryFailed(runId: string): Promise<BroadcastRetryFailed> {
    const response = await api.post(
      `/admin/broadcast/delivery-runs/${encodeURIComponent(runId)}/retry-failed`,
      {},
    );
    return z.object({ data: retryFailedSchema }).parse(response.data).data;
  },
};
