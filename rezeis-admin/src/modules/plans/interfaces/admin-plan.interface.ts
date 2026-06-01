import { Currency, PlanAvailability, PlanType } from '@prisma/client';

import { ArchivedPlanRenewModeValue } from '../utils/archived-plan-renew-mode.util';
import { TrafficLimitStrategyValue } from '../dto/traffic-limit-strategy.dto';
import { TrialSettings } from '../utils/trial-settings.util';

export interface AdminPlanPriceInterface {
  readonly id: string;
  readonly currency: Currency;
  readonly price: string;
}

export interface AdminPlanDurationInterface {
  readonly id: string;
  readonly days: number;
  readonly prices: readonly AdminPlanPriceInterface[];
}

export interface AdminPlanInterface {
  readonly id: string;
  readonly orderIndex: number;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly icon: string | null;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  readonly archivedRenewMode: ArchivedPlanRenewModeValue;
  readonly type: PlanType;
  readonly availability: PlanAvailability;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
  readonly upgradeToPlanIds: readonly string[];
  readonly replacementPlanIds: readonly string[];
  readonly allowedUserIds: readonly string[];
  readonly trialSettings: TrialSettings;
  readonly durations: readonly AdminPlanDurationInterface[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
