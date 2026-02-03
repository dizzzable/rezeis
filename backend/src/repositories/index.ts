import type { Pool } from 'pg';
import { BaseRepository, RepositoryError, type PaginationOptions, type PaginatedResult } from './base.repository.js';
import { UserRepository } from './user.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { PlanRepository } from './plan.repository.js';
import { StatisticsRepository } from './statistics.repository.js';
import { AdminRepository } from './admin.repository.js';
import { BackupRepository } from './backup.repository.js';
import { BroadcastRepository } from './broadcast.repository.js';
import { PromocodeRepository } from './promocode.repository.js';
import { PromocodeActivationRepository } from './promocode-activation.repository.js';
import { GatewayRepository } from './gateway.repository.js';
import { BannerRepository } from './banner.repository.js';
import { PartnerRepository } from './partner.repository.js';
import { ReferralRepository, ReferralRuleRepository, ReferralRewardRepository } from './referral.repository.js';
import { MultisubscriptionRepository } from './multisubscription.repository.js';
import { TrialTrackingRepository } from './trial-tracking.repository.js';
import { UserPersonalDiscountRepository } from './user-personal-discount.repository.js';

/**
 * Repositories interface
 */
export interface Repositories {
  users: UserRepository;
  subscriptions: SubscriptionRepository;
  plans: PlanRepository;
  statistics: StatisticsRepository;
  admins: AdminRepository;
  backups: BackupRepository;
  broadcasts: BroadcastRepository;
  promocodes: PromocodeRepository;
  promocodeActivations: PromocodeActivationRepository;
  gateways: GatewayRepository;
  banners: BannerRepository;
  partners: PartnerRepository;
  referrals: ReferralRepository;
  referralRules: ReferralRuleRepository;
  referralRewards: ReferralRewardRepository;
  multisubscriptions: MultisubscriptionRepository;
  trialTracking: TrialTrackingRepository;
  personalDiscounts: UserPersonalDiscountRepository;
}

/**
 * Create all repositories with database pool
 * @param db - PostgreSQL pool instance
 * @returns Repositories object
 */
export function createRepositories(db: Pool): Repositories {
  return {
    users: new UserRepository(db),
    subscriptions: new SubscriptionRepository(db),
    plans: new PlanRepository(db),
    statistics: new StatisticsRepository(db),
    admins: new AdminRepository(db),
    backups: new BackupRepository(db),
    broadcasts: new BroadcastRepository(db),
    promocodes: new PromocodeRepository(db),
    promocodeActivations: new PromocodeActivationRepository(db),
    gateways: new GatewayRepository(db),
    banners: new BannerRepository(db),
    partners: new PartnerRepository(db),
    referrals: new ReferralRepository(db),
    referralRules: new ReferralRuleRepository(db),
    referralRewards: new ReferralRewardRepository(db),
    multisubscriptions: new MultisubscriptionRepository(db),
    trialTracking: new TrialTrackingRepository(db),
    personalDiscounts: new UserPersonalDiscountRepository(db),
  };
}

// Export all repositories and types
export { BaseRepository, RepositoryError, type PaginationOptions, type PaginatedResult };
export { UserRepository } from './user.repository.js';
export { SubscriptionRepository } from './subscription.repository.js';
export { PlanRepository } from './plan.repository.js';
export { StatisticsRepository } from './statistics.repository.js';
export { AdminRepository } from './admin.repository.js';
export { BackupRepository } from './backup.repository.js';
export { BroadcastRepository } from './broadcast.repository.js';
export { PromocodeRepository } from './promocode.repository.js';
export { PromocodeActivationRepository } from './promocode-activation.repository.js';
export { GatewayRepository } from './gateway.repository.js';
export { BannerRepository } from './banner.repository.js';
export { PartnerRepository } from './partner.repository.js';
export { ReferralRepository, ReferralRuleRepository, ReferralRewardRepository } from './referral.repository.js';
export { MultisubscriptionRepository } from './multisubscription.repository.js';
export { TrialTrackingRepository } from './trial-tracking.repository.js';
export { UserPersonalDiscountRepository } from './user-personal-discount.repository.js';
export { NotificationRepository } from './notification.repository.js';

// Prisma-based Remnawave repositories (new)
export {
    RemnawaveConfigPrismaRepository,
    RemnawaveServerPrismaRepository,
    UserVpnKeyPrismaRepository,
    RemnawaveSyncLogPrismaRepository,
    type RemnawaveConfigEntity,
    type RemnawaveServerEntity,
    type UserVpnKeyEntity,
    type RemnawaveSyncLogEntity,
    type CreateRemnawaveConfigDto,
    type UpdateRemnawaveConfigDto,
    type CreateRemnawaveServerDto,
    type UpdateRemnawaveServerDto,
    type CreateUserVpnKeyDto,
    type UpdateUserVpnKeyDto,
    type CreateRemnawaveSyncLogDto,
    type UpdateRemnawaveSyncLogDto,
    type RemnawaveServerFilters,
    type UserVpnKeyFilters,
    type RemnawaveSyncLogFilters,
    type TrafficStats,
    type ServerTrafficStat,
    type UserTrafficStats,
    type VpnKeyTrafficInfo,
} from './remnawave-prisma.repository.js';

// Legacy SQL-based Remnawave repositories
export {
    RemnawaveConfigRepository,
    RemnawaveServerRepository,
    UserVpnKeyRepository,
    RemnawaveSyncLogRepository,
} from './remnawave.repository.js';
