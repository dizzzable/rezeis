import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  SHARING_TUNABLE_RANGES as S,
} from '../../anti-fraud/sharing-detection.config';
import {
  SUBSCRIPTION_UA_TUNABLE_RANGES as U,
} from '../../anti-fraud/subscription-ua-detection.config';
import {
  TRAFFIC_ABUSE_TUNABLE_RANGES as T,
} from '../../anti-fraud/traffic-abuse.config';

/**
 * Patch payload for `PATCH /admin/settings/anti-fraud`.
 *
 * Every field is optional and every field accepts `null`:
 *   - absent  → leave the stored value alone
 *   - `null`  → clear the panel value, fall back to the environment variable
 *               (for `subscriptionUa`, to the built-in default — that section
 *               has no environment layer)
 *   - value   → store it (a panel value wins over the environment variable)
 *
 * The bounds are NOT literals — they are read from the range tables in the two
 * anti-fraud config files, which are also what the env parser and the merge
 * validator use. One declaration, so a bound can never be right in one layer
 * and stale in another.
 *
 * Out-of-range input is REJECTED (400 naming the field), never clamped.
 * Clamping is how `traffic-abuse.config.ts` silently collapsed every default to
 * its range floor; `mergeAntiFraudSettings` re-checks the same bounds as a
 * second gate in case this DTO is ever loosened.
 */
class UpdateSharingDetectionSettingsDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean()
  public readonly enableHwidOverage?: boolean | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean()
  public readonly enableIpSharing?: boolean | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean()
  public readonly enableSharedHwid?: boolean | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean()
  public readonly ipNetworkGrouping?: boolean | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.ipWindowMinutes.min) @Max(S.ipWindowMinutes.max)
  public readonly ipWindowMinutes?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.ipConcurrencyWindowSeconds.min) @Max(S.ipConcurrencyWindowSeconds.max)
  public readonly ipConcurrencyWindowSeconds?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.maxNodesPerRun.min) @Max(S.maxNodesPerRun.max)
  public readonly maxNodesPerRun?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.maxIpsInMetadata.min) @Max(S.maxIpsInMetadata.max)
  public readonly maxIpsInMetadata?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.ipV4PrefixLength.min) @Max(S.ipV4PrefixLength.max)
  public readonly ipV4PrefixLength?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.ipV6PrefixLength.min) @Max(S.ipV6PrefixLength.max)
  public readonly ipV6PrefixLength?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.ipOverageMargin.min) @Max(S.ipOverageMargin.max)
  public readonly ipOverageMargin?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.sharedHwidMinAccounts.min) @Max(S.sharedHwidMinAccounts.max)
  public readonly sharedHwidMinAccounts?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(S.sharedHwidMaxAccounts.min) @Max(S.sharedHwidMaxAccounts.max)
  public readonly sharedHwidMaxAccounts?: number | null;
}

class UpdateTrafficAbuseSettingsDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean()
  public readonly enabled?: boolean | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsNumber() @Min(T.minGb.min) @Max(T.minGb.max)
  public readonly minGb?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsNumber() @Min(T.medianMultiplier.min) @Max(T.medianMultiplier.max)
  public readonly medianMultiplier?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsNumber() @Min(T.sharePercent.min) @Max(T.sharePercent.max)
  public readonly sharePercent?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsNumber() @Min(T.maxNodesPerRun.min) @Max(T.maxNodesPerRun.max)
  public readonly maxNodesPerRun?: number | null;
}

class UpdateSubscriptionUaSettingsDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsBoolean()
  public readonly enableSubscriptionUaTunnel?: boolean | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(U.uaEvidenceWindowMinutes.min) @Max(U.uaEvidenceWindowMinutes.max)
  public readonly uaEvidenceWindowMinutes?: number | null;

  @IsOptional() @ValidateIf((_o, v) => v !== null)
  @IsInt() @Min(U.uaRequestPageSize.min) @Max(U.uaRequestPageSize.max)
  public readonly uaRequestPageSize?: number | null;
}

export class UpdateAntiFraudSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSharingDetectionSettingsDto)
  public readonly sharing?: UpdateSharingDetectionSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateTrafficAbuseSettingsDto)
  public readonly trafficAbuse?: UpdateTrafficAbuseSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSubscriptionUaSettingsDto)
  public readonly subscriptionUa?: UpdateSubscriptionUaSettingsDto;
}
