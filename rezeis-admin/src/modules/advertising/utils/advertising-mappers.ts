import {
  AdCampaign,
  AdConversion,
  AdPlacement,
  AdPlacementRequest,
  AdSignupBonusType,
  Prisma,
} from '@prisma/client';

import {
  AdCampaignView,
  AdConversionView,
  AdPlacementRequestView,
  AdPlacementView,
  AdSignupBonusConfig,
} from '../interfaces/advertising.interface';
import { AdvertisingConfiguration } from '../../../common/config/advertising.config';
import { readJsonObject } from '../../../common/utils/read-json-object.util';
import { buildAdDeepLinks, buildAdPayload } from './tracking-code.util';

// Re-exported for existing import sites (single source of truth in common/utils).
export { readJsonObject };

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parses the stored signup-bonus JSON into a typed config (or `null`). */
export function readSignupBonus(
  type: AdSignupBonusType,
  raw: Prisma.JsonValue | null,
): AdSignupBonusConfig | null {
  if (type === 'NONE') {
    return null;
  }
  const obj = readJsonObject(raw);
  const squads = Array.isArray(obj['trialSquadUuids'])
    ? (obj['trialSquadUuids'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  return {
    type,
    trialDurationDays: num(obj['trialDurationDays']),
    trialTrafficGb: num(obj['trialTrafficGb']),
    trialDeviceLimit: num(obj['trialDeviceLimit']),
    trialSquadUuids: squads,
    tariffPlanId: str(obj['tariffPlanId']),
    tariffDurationDays: num(obj['tariffDurationDays']),
  };
}

export function mapPlacement(
  placement: AdPlacement,
  config: AdvertisingConfiguration,
): AdPlacementView {
  return {
    id: placement.id,
    campaignId: placement.campaignId,
    platform: placement.platform,
    channel: placement.channel,
    ownerType: placement.ownerType,
    partnerId: placement.partnerId,
    trackingCode: placement.trackingCode,
    payload: buildAdPayload(placement.trackingCode),
    links: buildAdDeepLinks({
      adminReiwaBotUsername: config.adminReiwaBotUsername,
      miniAppShortName: config.miniAppShortName,
      miniAppWebBaseUrl: config.webBaseUrl,
      code: placement.trackingCode,
    }),
    attributionWindowDays: placement.attributionWindowDays,
    promoCodeId: placement.promoCodeId,
    spendAmountMinor: placement.spendAmount,
    spendCurrency: placement.spendCurrency,
    signupBonusType: placement.signupBonusType,
    signupBonus: readSignupBonus(placement.signupBonusType, placement.signupBonus),
    status: placement.status,
    createdAt: placement.createdAt.toISOString(),
    updatedAt: placement.updatedAt.toISOString(),
  };
}

export function mapCampaign(
  campaign: AdCampaign & { placements?: AdPlacement[] },
  config: AdvertisingConfiguration,
): AdCampaignView {
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    notes: campaign.notes,
    createdBy: campaign.createdBy,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
    placements: (campaign.placements ?? []).map((p) => mapPlacement(p, config)),
  };
}

export function mapRequest(request: AdPlacementRequest): AdPlacementRequestView {
  return {
    id: request.id,
    partnerId: request.partnerId,
    platforms: request.platforms,
    channel: request.channel,
    notes: request.notes,
    proposedWindowDays: request.proposedWindowDays,
    approvedWindowDays: request.approvedWindowDays,
    selfFundedBudgetNote: request.selfFundedBudgetNote,
    status: request.status,
    reviewedBy: request.reviewedBy,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    campaignId: request.campaignId,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

export function mapConversion(conversion: AdConversion): AdConversionView {
  return {
    id: conversion.id,
    placementId: conversion.placementId,
    campaignId: conversion.campaignId,
    userId: conversion.userId,
    transactionId: conversion.transactionId,
    amountMinor: conversion.amount,
    currency: conversion.currency,
    status: conversion.status,
    occurredAt: conversion.occurredAt.toISOString(),
  };
}
