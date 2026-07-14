import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AddOnEntitlementActorType,
  AddOnEntitlementState,
  AddOnLifetime,
  AddOnType,
  Currency,
  EntitlementIncidentKind,
  EntitlementIncidentSeverity,
  Prisma,
} from '@prisma/client';

import {
  EntitlementCommand,
  EntitlementState,
  transitionEntitlementState,
} from '../domain/add-on-entitlement-state';

export interface EntitlementTransitionInput {
  readonly entitlementId: string;
  readonly command: EntitlementCommand;
  readonly commandKey: string;
  readonly correlationId: string;
  readonly actorType: AddOnEntitlementActorType;
  readonly actorId?: string;
  readonly reason: string;
  readonly metadata?: Prisma.InputJsonObject;
}

export interface EntitlementTransitionResult {
  readonly entitlementId: string;
  readonly state: EntitlementState;
  readonly changed: boolean;
  readonly eventId: string | null;
}

export interface TerminateEntitlementsInput {
  readonly subscriptionId: string;
  readonly correlationId: string;
  readonly reason: string;
}

export interface CreatePendingEntitlementInput {
  readonly subscriptionId: string;
  readonly termId: string;
  readonly sourceTransactionId: string;
  readonly sourceLineKey: string;
  readonly addOnId: string | null;
  readonly catalogRevision: number;
  readonly receiptName: string;
  readonly type: AddOnType;
  readonly valuePerUnit: number;
  readonly totalValue: bigint;
  readonly lifetime: AddOnLifetime;
  readonly applicabilitySnapshot: Prisma.InputJsonObject;
  readonly unitAmount: Prisma.Decimal | string | number;
  readonly totalAmount: Prisma.Decimal | string | number;
  readonly currency: Currency;
  readonly purchasedAt: Date;
  readonly scheduledActivationAt: Date;
  readonly expiresAt: Date | null;
  readonly expiryEpochId: string | null;
  readonly correlationId: string;
}

export interface CreatePendingEntitlementResult {
  readonly entitlementId: string;
  readonly state: EntitlementState;
  readonly created: boolean;
  readonly eventId: string;
}

export interface RecordRefundOrChargebackInput {
  readonly entitlementId: string;
  readonly commandKey: string;
  readonly supportRef: string;
  readonly summaryCode: string;
  readonly correlationId: string;
  readonly metadata?: Prisma.InputJsonObject;
}

export interface RecordRefundOrChargebackResult {
  readonly entitlementId: string;
  readonly state: EntitlementState;
  readonly incidentId: string;
  readonly eventId: string;
  readonly created: boolean;
}

type RecordedEvent = {
  readonly id: string;
  readonly toState: AddOnEntitlementState;
  readonly metadata: unknown;
};

type ImmutableEntitlementSnapshot = {
  readonly subscriptionId: string;
  readonly termId: string;
  readonly sourceTransactionId: string;
  readonly sourceLineKey: string;
  readonly addOnId: string | null;
  readonly catalogRevision: number;
  readonly receiptName: string;
  readonly type: AddOnType;
  readonly valuePerUnit: number;
  readonly quantity: number;
  readonly totalValue: bigint;
  readonly lifetime: AddOnLifetime;
  readonly applicabilitySnapshot: unknown;
  readonly unitAmount: { toString(): string };
  readonly totalAmount: { toString(): string };
  readonly currency: Currency;
  readonly purchasedAt: Date;
  readonly scheduledActivationAt: Date;
  readonly expiresAt: Date | null;
  readonly expiryEpochId: string | null;
};

@Injectable()
export class AddOnEntitlementService {
  public async recordRefundOrChargebackInTransaction(
    tx: Prisma.TransactionClient,
    input: RecordRefundOrChargebackInput,
  ): Promise<RecordRefundOrChargebackResult> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "add_on_entitlements"
      WHERE "id" = ${input.entitlementId}
      FOR UPDATE
    `);
    if (locked.length !== 1) {
      throw new NotFoundException('Entitlement not found');
    }
    const entitlement = await tx.addOnEntitlement.findUnique({
      where: { id: input.entitlementId },
      select: { id: true, subscriptionId: true, state: true },
    });
    if (entitlement === null) {
      throw new NotFoundException('Entitlement not found');
    }

    const replay = await this.findRecordedCommand(tx, entitlement.id, input.commandKey);
    if (replay !== null) {
      const incidentId = this.assertRefundCommandFingerprint(replay, input);
      return {
        entitlementId: entitlement.id,
        state: entitlement.state as EntitlementState,
        incidentId,
        eventId: replay.id,
        created: false,
      };
    }

    const incident = await tx.entitlementIncident.upsert({
      where: { supportRef: input.supportRef },
      update: {},
      create: {
        subscriptionId: entitlement.subscriptionId,
        entitlementId: entitlement.id,
        kind: EntitlementIncidentKind.REFUND_OR_CHARGEBACK,
        severity: EntitlementIncidentSeverity.WARNING,
        supportRef: input.supportRef,
        summaryCode: input.summaryCode,
        metadata: input.metadata ?? {},
      },
      select: {
        id: true,
        subscriptionId: true,
        entitlementId: true,
        kind: true,
        supportRef: true,
        summaryCode: true,
      },
    });
    if (
      incident.subscriptionId !== entitlement.subscriptionId ||
      incident.entitlementId !== entitlement.id ||
      incident.kind !== EntitlementIncidentKind.REFUND_OR_CHARGEBACK ||
      incident.summaryCode !== input.summaryCode
    ) {
      throw new ConflictException('Refund support reference is already bound to another incident');
    }

    const event = await tx.addOnEntitlementEvent.create({
      data: {
        entitlementId: entitlement.id,
        fromState: entitlement.state,
        toState: entitlement.state,
        reason: input.summaryCode,
        actorType: AddOnEntitlementActorType.SYSTEM,
        correlationId: input.correlationId,
        commandKey: input.commandKey,
        metadata: {
          ...(input.metadata ?? {}),
          incidentId: incident.id,
          refundFingerprint: this.refundCommandFingerprint(input),
        },
      },
      select: { id: true },
    });
    return {
      entitlementId: entitlement.id,
      state: entitlement.state as EntitlementState,
      incidentId: incident.id,
      eventId: event.id,
      created: true,
    };
  }

  public async createPendingInTransaction(
    tx: Prisma.TransactionClient,
    input: CreatePendingEntitlementInput,
  ): Promise<CreatePendingEntitlementResult> {
    const source = await tx.$queryRaw<Array<{ id: string; subscriptionId: string | null }>>(Prisma.sql`
      SELECT "id", "subscription_id" AS "subscriptionId"
      FROM "transactions"
      WHERE "id" = ${input.sourceTransactionId}
      FOR UPDATE
    `);
    if (source.length !== 1) {
      throw new NotFoundException('Source transaction not found');
    }
    if (source[0]?.subscriptionId !== input.subscriptionId) {
      // Combined-renewal binding: a combined renewal transaction carries
      // `subscriptionId = null` (the presence of TransactionItem lines is what
      // marks it as combined), so the entitlement's link to the PAYING
      // transaction is proven by a matching renewal line rather than by the
      // transaction's own `subscriptionId`. Any other mismatch is a hard bind
      // violation. The line is locked FOR UPDATE so it serializes against the
      // combined-renewal application (which stamps `appliedAt` on the line).
      if (source[0]?.subscriptionId !== null) {
        throw new ConflictException('Source transaction is not bound to the target subscription');
      }
      const line = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "transaction_items"
        WHERE "transaction_id" = ${input.sourceTransactionId}
          AND "subscription_id" = ${input.subscriptionId}
        FOR UPDATE
      `);
      if (line.length === 0) {
        throw new ConflictException('Source transaction has no renewal line for the target subscription');
      }
    }
    const subscription = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    if (subscription.length !== 1) {
      throw new NotFoundException('Subscription not found');
    }
    if (subscription[0]?.status !== 'ACTIVE') {
      throw new ConflictException('Subscription is not active for add-on fulfillment');
    }
    const term = await tx.$queryRaw<Array<{ id: string; subscriptionId: string }>>(Prisma.sql`
      SELECT "id", "subscription_id" AS "subscriptionId"
      FROM "subscription_terms"
      WHERE "id" = ${input.termId}
      FOR UPDATE
    `);
    if (term.length !== 1 || term[0]?.subscriptionId !== input.subscriptionId) {
      throw new ConflictException('Subscription term is not bound to the target subscription');
    }
    if (input.expiryEpochId !== null) {
      const epoch = await tx.$queryRaw<Array<{ id: string; termId: string }>>(Prisma.sql`
        SELECT "id", "term_id" AS "termId"
        FROM "subscription_reset_epochs"
        WHERE "id" = ${input.expiryEpochId}
        FOR UPDATE
      `);
      if (epoch.length !== 1 || epoch[0]?.termId !== input.termId) {
        throw new ConflictException('Expiry epoch is not bound to the target term');
      }
    }
    const commandKey = `create:${input.sourceTransactionId}:${input.sourceLineKey}`;
    const entitlement = await tx.addOnEntitlement.upsert({
      where: {
        sourceTransactionId_sourceLineKey: {
          sourceTransactionId: input.sourceTransactionId,
          sourceLineKey: input.sourceLineKey,
        },
      },
      update: {},
      create: {
        subscriptionId: input.subscriptionId,
        termId: input.termId,
        sourceTransactionId: input.sourceTransactionId,
        sourceLineKey: input.sourceLineKey,
        addOnId: input.addOnId,
        catalogRevision: input.catalogRevision,
        receiptName: input.receiptName,
        type: input.type,
        valuePerUnit: input.valuePerUnit,
        quantity: 1,
        totalValue: input.totalValue,
        lifetime: input.lifetime,
        applicabilitySnapshot: input.applicabilitySnapshot,
        unitAmount: input.unitAmount,
        totalAmount: input.totalAmount,
        currency: input.currency,
        purchasedAt: input.purchasedAt,
        scheduledActivationAt: input.scheduledActivationAt,
        expiresAt: input.expiresAt,
        expiryEpochId: input.expiryEpochId,
        state: AddOnEntitlementState.PENDING_ACTIVATION,
      },
      select: {
        id: true,
        state: true,
        version: true,
        subscriptionId: true,
        termId: true,
        sourceTransactionId: true,
        sourceLineKey: true,
        addOnId: true,
        catalogRevision: true,
        receiptName: true,
        type: true,
        valuePerUnit: true,
        quantity: true,
        totalValue: true,
        lifetime: true,
        applicabilitySnapshot: true,
        unitAmount: true,
        totalAmount: true,
        currency: true,
        purchasedAt: true,
        scheduledActivationAt: true,
        expiresAt: true,
        expiryEpochId: true,
      },
    });

    this.assertImmutableSnapshot(entitlement, input);
    const replay = await this.findRecordedCommand(tx, entitlement.id, commandKey);
    if (replay !== null) {
      this.assertCreateExpiryFingerprint(replay, entitlement, input);
      return {
        entitlementId: entitlement.id,
        state: entitlement.state as EntitlementState,
        created: false,
        eventId: replay.id,
      };
    }

    const event = await tx.addOnEntitlementEvent.create({
      data: {
        entitlementId: entitlement.id,
        fromState: null,
        toState: AddOnEntitlementState.PENDING_ACTIVATION,
        reason: 'PURCHASE_COMMITTED',
        actorType: AddOnEntitlementActorType.SYSTEM,
        correlationId: input.correlationId,
        commandKey,
        metadata: {
          sourceTransactionId: input.sourceTransactionId,
          sourceLineKey: input.sourceLineKey,
          createExpiryFingerprint: this.createExpiryFingerprint(input),
        },
      },
      select: { id: true },
    });

    return {
      entitlementId: entitlement.id,
      state: AddOnEntitlementState.PENDING_ACTIVATION,
      created: true,
      eventId: event.id,
    };
  }

  public async transitionInTransaction(
    tx: Prisma.TransactionClient,
    input: EntitlementTransitionInput,
  ): Promise<EntitlementTransitionResult> {
    const replay = await this.findRecordedCommand(tx, input.entitlementId, input.commandKey);
    if (replay !== null) {
      this.assertTransitionCommandFingerprint(replay, input);
      return this.replayResult(input.entitlementId, replay);
    }

    const entitlement = await tx.addOnEntitlement.findUnique({
      where: { id: input.entitlementId },
      select: { id: true, state: true, version: true },
    });
    if (entitlement === null) {
      throw new NotFoundException('Entitlement not found');
    }

    const transition = transitionEntitlementState(
      entitlement.state as EntitlementState,
      input.command,
    );
    if (!transition.changed) {
      return {
        entitlementId: entitlement.id,
        state: entitlement.state as EntitlementState,
        changed: false,
        eventId: null,
      };
    }

    const now = new Date();
    const updateData: Prisma.AddOnEntitlementUpdateManyMutationInput = {
      state: transition.state,
      version: { increment: 1 },
    };
    if (transition.state === 'ACTIVE') {
      updateData.activatedAt = now;
    }
    if (transition.state === 'EXPIRED' || transition.state === 'REVERSED') {
      updateData.terminalAt = now;
      updateData.terminalReason = input.reason;
    }

    const claimed = await tx.addOnEntitlement.updateMany({
      where: {
        id: entitlement.id,
        state: entitlement.state,
        version: entitlement.version,
      },
      data: updateData,
    });
    if (claimed.count !== 1) {
      const winner = await this.findRecordedCommand(tx, entitlement.id, input.commandKey);
      if (winner !== null) {
        this.assertTransitionCommandFingerprint(winner, input);
        return this.replayResult(entitlement.id, winner);
      }
      throw new ConflictException('Entitlement transition was superseded');
    }

    const event = await tx.addOnEntitlementEvent.create({
      data: {
        entitlementId: entitlement.id,
        fromState: entitlement.state,
        toState: transition.state,
        reason: input.reason,
        actorType: input.actorType,
        actorId: input.actorId,
        correlationId: input.correlationId,
        commandKey: input.commandKey,
        metadata: {
          ...(input.metadata ?? {}),
          commandFingerprint: this.transitionCommandFingerprint(input),
        },
      },
      select: { id: true },
    });

    return {
      entitlementId: entitlement.id,
      state: transition.state,
      changed: true,
      eventId: event.id,
    };
  }

  public async terminateForSubscriptionDeletion(
    tx: Prisma.TransactionClient,
    input: TerminateEntitlementsInput,
  ): Promise<number> {
    const rows = await tx.addOnEntitlement.findMany({
      where: {
        subscriptionId: input.subscriptionId,
        state: { in: ['PENDING_ACTIVATION', 'ACTIVE', 'EXPIRING'] },
      },
      select: { id: true, state: true, version: true },
    });
    const terminalAt = new Date();

    for (const row of rows) {
      const commandKey = `subscription-delete:${input.subscriptionId}`;
      const replay = await this.findRecordedCommand(tx, row.id, commandKey);
      if (replay !== null) {
        continue;
      }
      const claimed = await tx.addOnEntitlement.updateMany({
        where: { id: row.id, state: row.state, version: row.version },
        data: {
          state: AddOnEntitlementState.REVERSED,
          version: { increment: 1 },
          terminalAt,
          terminalReason: input.reason,
        },
      });
      if (claimed.count !== 1) {
        const winner = await this.findRecordedCommand(tx, row.id, commandKey);
        if (winner !== null) {
          continue;
        }
        throw new ConflictException('Entitlement termination was superseded');
      }
      await tx.addOnEntitlementEvent.create({
        data: {
          entitlementId: row.id,
          fromState: row.state,
          toState: AddOnEntitlementState.REVERSED,
          reason: input.reason,
          actorType: AddOnEntitlementActorType.SYSTEM,
          correlationId: input.correlationId,
          commandKey,
          metadata: { source: 'SUBSCRIPTION_DELETED' },
        },
      });
    }

    return rows.length;
  }

  private assertImmutableSnapshot(
    row: ImmutableEntitlementSnapshot,
    input: CreatePendingEntitlementInput,
  ): void {
    const matches =
      row.subscriptionId === input.subscriptionId &&
      row.termId === input.termId &&
      row.sourceTransactionId === input.sourceTransactionId &&
      row.sourceLineKey === input.sourceLineKey &&
      row.addOnId === input.addOnId &&
      row.catalogRevision === input.catalogRevision &&
      row.receiptName === input.receiptName &&
      row.type === input.type &&
      row.valuePerUnit === input.valuePerUnit &&
      row.quantity === 1 &&
      row.totalValue === input.totalValue &&
      row.lifetime === input.lifetime &&
      this.canonicalJson(row.applicabilitySnapshot) === this.canonicalJson(input.applicabilitySnapshot) &&
      new Prisma.Decimal(row.unitAmount.toString()).equals(new Prisma.Decimal(input.unitAmount)) &&
      new Prisma.Decimal(row.totalAmount.toString()).equals(new Prisma.Decimal(input.totalAmount)) &&
      row.currency === input.currency &&
      row.purchasedAt.getTime() === input.purchasedAt.getTime() &&
      row.scheduledActivationAt.getTime() === input.scheduledActivationAt.getTime();

    if (!matches) {
      throw new ConflictException('Source line is already bound to a different entitlement snapshot');
    }
  }

  private createExpiryFingerprint(input: CreatePendingEntitlementInput): Prisma.InputJsonObject {
    return {
      expiresAt: input.expiresAt?.toISOString() ?? null,
      expiryEpochId: input.expiryEpochId,
    };
  }

  private assertCreateExpiryFingerprint(
    event: RecordedEvent,
    row: ImmutableEntitlementSnapshot & { readonly state: AddOnEntitlementState },
    input: CreatePendingEntitlementInput,
  ): void {
    const metadata =
      event.metadata !== null && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
        ? (event.metadata as Record<string, unknown>)
        : {};
    const recorded = metadata.createExpiryFingerprint;
    if (recorded === undefined) {
      // Compatibility for events created before createExpiryFingerprint shipped:
      // only an untouched PENDING aggregate still carries provable create-time
      // expiry values. Once lifecycle progressed, those columns may have been
      // refined and absence of the original fingerprint must remain fail-closed.
      const sameLegacyExpiry =
        row.state === AddOnEntitlementState.PENDING_ACTIVATION &&
        (row.expiresAt?.getTime() ?? null) === (input.expiresAt?.getTime() ?? null) &&
        row.expiryEpochId === input.expiryEpochId;
      if (sameLegacyExpiry) return;
      throw new ConflictException('Source line is already bound to a different expiry snapshot');
    }
    if (
      this.canonicalJson(recorded) !==
      this.canonicalJson(this.createExpiryFingerprint(input))
    ) {
      throw new ConflictException('Source line is already bound to a different expiry snapshot');
    }
  }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.canonicalJson(entry)).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${this.canonicalJson(entry)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private refundCommandFingerprint(
    input: RecordRefundOrChargebackInput,
  ): Prisma.InputJsonObject {
    return {
      supportRef: input.supportRef,
      summaryCode: input.summaryCode,
      metadata: input.metadata ?? {},
    };
  }

  private assertRefundCommandFingerprint(
    event: RecordedEvent,
    input: RecordRefundOrChargebackInput,
  ): string {
    const metadata = event.metadata;
    const record =
      metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
    if (
      typeof record.incidentId !== 'string' ||
      record.refundFingerprint === undefined ||
      this.canonicalJson(record.refundFingerprint) !== this.canonicalJson(this.refundCommandFingerprint(input))
    ) {
      throw new ConflictException('Refund command key is already bound to another refund payload');
    }
    return record.incidentId;
  }

  private transitionCommandFingerprint(
    input: EntitlementTransitionInput,
  ): Prisma.InputJsonObject {
    return {
      command: input.command,
      reason: input.reason,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      metadata: input.metadata ?? {},
    };
  }

  private assertTransitionCommandFingerprint(
    event: RecordedEvent,
    input: EntitlementTransitionInput,
  ): void {
    const metadata = event.metadata;
    const recorded =
      metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).commandFingerprint
        : undefined;
    if (
      recorded === undefined ||
      this.canonicalJson(recorded) !== this.canonicalJson(this.transitionCommandFingerprint(input))
    ) {
      throw new ConflictException('Lifecycle command key is already bound to another command payload');
    }
  }

  private async findRecordedCommand(
    tx: Prisma.TransactionClient,
    entitlementId: string,
    commandKey: string,
  ): Promise<RecordedEvent | null> {
    return tx.addOnEntitlementEvent.findUnique({
      where: { entitlementId_commandKey: { entitlementId, commandKey } },
      select: { id: true, toState: true, metadata: true },
    });
  }

  private replayResult(
    entitlementId: string,
    event: RecordedEvent,
  ): EntitlementTransitionResult {
    return {
      entitlementId,
      state: event.toState as EntitlementState,
      changed: false,
      eventId: event.id,
    };
  }
}
