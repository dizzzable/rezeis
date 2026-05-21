// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import BroadcastPage from "@/features/broadcast/broadcast-page";
import { broadcastApi } from "@/features/broadcast/broadcast-api";
import { renderWithProviders } from "@/test/test-utils";

function expectSensitiveStringAbsentOutsideControls(container: HTMLElement, value: string): void {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const control of Array.from(clone.querySelectorAll("input, textarea, select"))) {
    control.remove();
  }
  expect(clone).not.toHaveTextContent(value);
  for (const link of Array.from(container.querySelectorAll("a"))) {
    expect(link.getAttribute("href") ?? "").not.toContain(value);
  }
}
describe.skip("broadcast page smoke", () => {
  it("creates a draft and previews audience without send controls", async () => {
    vi.spyOn(broadcastApi, "listDrafts").mockResolvedValue([
      {
        id: "broadcast-1",
        taskId: "broadcast-draft-1",
        audience: "ALL",
        payload: {
          title: "Existing draft",
          message: "Existing bounded draft message",
        },
        totalCount: 10,
        successCount: 0,
        failedCount: 0,
        createdAt: "2026-04-24T12:00:00.000Z",
      },
    ]);
    vi.spyOn(broadcastApi, "previewAudience").mockResolvedValue({
      audience: "ALL",
      totalCount: 10,
      sampleUserIds: ["user-1", "user-2"],
    });
    const createDraftSpy = vi
      .spyOn(broadcastApi, "createDraft")
      .mockResolvedValue({
        id: "broadcast-2",
        taskId: "broadcast-draft-2",
        audience: "ALL",
        payload: {
          title: "Service update",
          message: "New draft message",
        },
        totalCount: 10,
        successCount: 0,
        failedCount: 0,
        createdAt: "2026-04-24T13:00:00.000Z",
      });
    const updateDraftSpy = vi
      .spyOn(broadcastApi, "updateDraft")
      .mockResolvedValue({
        id: "broadcast-1",
        taskId: "broadcast-draft-1",
        audience: "BLOCKED",
        payload: {
          title: "Updated draft",
          message: "Updated bounded draft message",
          buttonText: "Open app",
          buttonUrl: "https://example.com",
        },
        totalCount: 2,
        successCount: 0,
        failedCount: 0,
        createdAt: "2026-04-24T12:00:00.000Z",
      });
    vi.spyOn(broadcastApi, "previewDraft").mockResolvedValue({
      draftId: "broadcast-1",
      isValid: true,
      titlePreview: "Existing draft",
      messagePreview: "Existing bounded draft message",
      audience: "ALL",
      totalCount: 10,
      issues: [{ code: "RAW_BACKEND_ISSUE", severity: "WARNING", message: "raw broadcast issue message with user-777" }],
    });
    vi.spyOn(broadcastApi, "getDraftReadiness").mockResolvedValue({
      draftId: "broadcast-1",
      readyForFutureDelivery: true,
      blockedReasonCodes: [],
      checks: [
        {
          code: "SENDING_DISABLED",
          label:
            "Sending worker and provider calls are intentionally disabled.",
          passed: true,
          severity: "INFO",
        },
      ],
    });
    const prepareSendSpy = vi.spyOn(broadcastApi, "prepareSend").mockResolvedValue({
      runId: "run-1",
      draftId: "broadcast-1",
      status: "READY",
      deliveryEnabled: false,
      audienceCount: 10,
      eligibleTelegramUsers: 7,
      preparedMessages: 7,
      blockedReasonCodes: [],
    });
    vi.spyOn(broadcastApi, "listDeliveryRuns").mockResolvedValue([
      {
        runId: "run-1",
        draftId: "broadcast-1",
        status: "READY",
        deliveryEnabled: false,
        audienceCount: 10,
        eligibleTelegramUsers: 7,
        preparedMessages: 0,
        blockedReasonCodes: [],
        createdAt: "2026-04-24T12:30:00.000Z",
      },
    ]);
    vi.spyOn(broadcastApi, "getDeliveryRun").mockResolvedValue({
      runId: "run-1",
      draftId: "broadcast-1",
      status: "READY",
      deliveryEnabled: false,
      audienceCount: 10,
      eligibleTelegramUsers: 7,
      preparedMessages: 7,
      blockedReasonCodes: [],
      createdAt: "2026-04-24T12:30:00.000Z",
      recipientStatusCounts: [{ status: "STAGED", count: 7 }],
      sampleRecipientUserIds: ["user-1"],
      sampleRecipients: [{ recipientId: "recipient-1", userId: "user-1", status: "DELIVERED" }],
    });
    const executeNextRecipientSpy = vi.spyOn(broadcastApi, "executeNextRecipient").mockResolvedValue({
      runId: "run-1",
      recipientId: "recipient-1",
      userId: "user-1",
      status: "DELIVERED",
      telegramMessageId: 456,
      errorCode: null,
      checkedAt: "2026-04-24T12:31:00.000Z",
    });
    const executeBatchSpy = vi.spyOn(broadcastApi, "executeBatch").mockResolvedValue({
      runId: "run-1",
      attempted: 2,
      delivered: 2,
      failed: 0,
      remainingStaged: 5,
      checkedAt: "2026-04-24T12:32:00.000Z",
    });
    const deleteRecipientMessageSpy = vi.spyOn(broadcastApi, "deleteRecipientMessage").mockResolvedValue({
      runId: "run-1",
      recipientId: "recipient-1",
      userId: "user-1",
      status: "DELETED",
      deleted: true,
      checkedAt: "2026-04-24T12:33:00.000Z",
    });
    const deleteDeliveredBatchSpy = vi.spyOn(broadcastApi, "deleteDeliveredBatch").mockResolvedValue({
      runId: "run-1",
      attempted: 2,
      deleted: 2,
      blocked: 0,
      remainingDelivered: 3,
      checkedAt: "2026-04-24T12:34:00.000Z",
    });
    const retryFailedSpy = vi.spyOn(broadcastApi, "retryFailed").mockResolvedValue({
      runId: "run-1",
      retriedRecipients: 2,
      checkedAt: "2026-04-24T12:35:00.000Z",
    });

    const { container } = renderWithProviders(<BroadcastPage />);

    expect(await screen.findByText("Drafts and delivery readiness")).toBeInTheDocument();
    expect(await screen.findByText("Existing draft")).toBeInTheDocument();
    expect(await screen.findByText("Message content hidden · length 30")).toBeInTheDocument();
    expectSensitiveStringAbsentOutsideControls(container, "Existing bounded draft message");
    expect(await screen.findByText("Total audience")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "UNSUBSCRIBED" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "EXPIRED_SUBSCRIPTION" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "TRIAL_SUBSCRIPTION" }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText("10")).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    expect(
      await screen.findByText("Selected draft detail"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Message preview and validation"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Send readiness checklist"),
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText("Ready for future delivery review")).length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByText(
        "✓ Sending worker and provider calls are intentionally disabled.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Title preview hidden"),
    ).toBeInTheDocument();
    expect(await screen.findByText("Message preview hidden · length 30")).toBeInTheDocument();
    expect(await screen.findByText("WARNING: issue details hidden · code RAW_BACKEND_ISSUE")).toBeInTheDocument();
    expectSensitiveStringAbsentOutsideControls(container, "raw broadcast issue message with user-777");
    expectSensitiveStringAbsentOutsideControls(container, "Existing bounded draft message");
    expect(await screen.findByText("Delivery run preparation")).toBeInTheDocument();
    expect(await screen.findByText("Delivery run history")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare delivery run" }));
    await waitFor(() => {
      expect(prepareSendSpy).toHaveBeenCalledWith("broadcast-1");
    });
    expect(await screen.findByText("Preparation status: READY")).toBeInTheDocument();
    expect(await screen.findByText("Prepared messages: 7 · Delivery enabled: false")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Inspect recipients" }));
    expect(await screen.findByText("Delivery recipient detail")).toBeInTheDocument();
    expect(await screen.findByText("STAGED: 7")).toBeInTheDocument();
    expect(screen.queryByText("recipient-1")).not.toBeInTheDocument();
    expect(screen.queryByText("user-1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execute next staged recipient" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execute manual batch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete delivered batch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry failed recipients" })).not.toBeInTheDocument();
    expect(executeNextRecipientSpy).not.toHaveBeenCalled();
    expect(executeBatchSpy).not.toHaveBeenCalled();
    expect(deleteRecipientMessageSpy).not.toHaveBeenCalled();
    expect(deleteDeliveredBatchSpy).not.toHaveBeenCalled();
    expect(retryFailedSpy).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Updated draft" },
    });
    fireEvent.change(screen.getByLabelText("Button text"), { target: { value: "Open app" } });
    fireEvent.change(screen.getByLabelText("Button URL"), { target: { value: "https://example.com" } });
    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://example.com/image.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: "Update draft" }));
    await waitFor(() => {
      expect(updateDraftSpy).toHaveBeenCalledWith({
        draftId: "broadcast-1",
        audience: "ALL",
        title: "Updated draft",
        message: "Existing bounded draft message",
        buttonText: "Open app",
        buttonUrl: "https://example.com",
        mediaUrl: "https://example.com/image.jpg",
      });
    });
    expect(
      screen.queryByRole("button", { name: /send/i }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Service update" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "New draft message" },
    });
    fireEvent.change(screen.getByLabelText("Button text"), { target: { value: "Open app" } });
    fireEvent.change(screen.getByLabelText("Button URL"), { target: { value: "https://example.com" } });
    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://example.com/image.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(createDraftSpy).toHaveBeenCalledWith({
        audience: "ALL",
        title: "Service update",
        message: "New draft message",
        buttonText: "Open app",
        buttonUrl: "https://example.com",
        mediaUrl: "https://example.com/image.jpg",
      });
    });
  });
});
