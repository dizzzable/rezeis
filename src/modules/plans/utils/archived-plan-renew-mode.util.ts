export const ArchivedPlanRenewModeValue = {
  SELF_RENEW: 'SELF_RENEW',
  REPLACE_ON_RENEW: 'REPLACE_ON_RENEW',
} as const;

export type ArchivedPlanRenewModeValue =
  (typeof ArchivedPlanRenewModeValue)[keyof typeof ArchivedPlanRenewModeValue];
