/**
 * User role type
 */
export type UserRole = 'super_admin' | 'admin' | 'user';

/**
 * User entity
 */
export interface User {
  id: string;
  username: string;
  telegramId?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  role: UserRole;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create user DTO
 */
export interface CreateUserDTO {
  username: string;
  password?: string;
  telegramId?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  role?: UserRole;
  isActive?: boolean;
}

/**
 * Update user DTO
 */
export interface UpdateUserDTO {
  username?: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  role?: UserRole;
  isActive?: boolean;
}

/**
 * Get users params
 */
export interface GetUsersParams {
  page?: number;
  limit?: number;
  role?: UserRole;
  isActive?: boolean;
  search?: string;
}

/**
 * Subscription status type
 */
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'pending';

/**
 * Subscription entity
 */
export interface Subscription {
  id: string;
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  startDate: string;
  endDate: string;
  remnawaveUuid?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create subscription DTO
 */
export interface CreateSubscriptionDTO {
  userId: string;
  planId: string;
  status?: SubscriptionStatus;
  startDate: string;
  endDate: string;
  remnawaveUuid?: string;
}

/**
 * Update subscription DTO
 */
export interface UpdateSubscriptionDTO {
  planId?: string;
  status?: SubscriptionStatus;
  startDate?: string;
  endDate?: string;
  remnawaveUuid?: string;
}

/**
 * Get subscriptions params
 */
export interface GetSubscriptionsParams {
  page?: number;
  limit?: number;
  status?: SubscriptionStatus;
  userId?: string;
  planId?: string;
}

/**
 * Plan entity
 */
export interface Plan {
  id: string;
  name: string;
  description?: string;
  price: number;
  durationDays: number;
  trafficLimit?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create plan DTO
 */
export interface CreatePlanDTO {
  name: string;
  description?: string;
  price: number;
  durationDays: number;
  trafficLimit?: number;
  isActive?: boolean;
}

/**
 * Update plan DTO
 */
export interface UpdatePlanDTO {
  name?: string;
  description?: string;
  price?: number;
  durationDays?: number;
  trafficLimit?: number;
  isActive?: boolean;
}

/**
 * Paginated result
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Dashboard stats
 */
export interface DashboardStats {
  totalRevenue: number;
  newUsersToday: number;
  newSubscriptionsToday: number;
  activeUsersToday: number;
}

/**
 * Revenue stats
 */
export interface RevenueStats {
  totalRevenue: number;
  periodRevenue: number;
  averageDailyRevenue: number;
  growthRate: number;
}

/**
 * User stats
 */
export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  blockedUsers: number;
  newUsersThisMonth: number;
  growthRate: number;
}

/**
 * Subscription stats
 */
export interface SubscriptionStats {
  totalSubscriptions: number;
  activeSubscriptions: number;
  expiredSubscriptions: number;
  cancelledSubscriptions: number;
  expiringSoon: number;
}

/**
 * Daily statistics
 */
export interface DailyStatistics {
  id: string;
  date: string;
  newUsers: number;
  activeUsers: number;
  newSubscriptions: number;
  revenue: number;
  createdAt: string;
}

/**
 * Admin role type
 */
export type AdminRole = 'super_admin' | 'admin';

/**
 * Admin entity
 */
export interface Admin {
  id: string;
  telegramId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  role: AdminRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create admin DTO
 */
export interface CreateAdminDTO {
  telegramId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  role?: AdminRole;
  isActive?: boolean;
}

/**
 * Update admin DTO
 */
export interface UpdateAdminDTO {
  username?: string;
  firstName?: string;
  lastName?: string;
  role?: AdminRole;
  isActive?: boolean;
}

/**
 * Get admins params
 */
export interface GetAdminsParams {
  page?: number;
  limit?: number;
  role?: AdminRole;
  isActive?: boolean;
  search?: string;
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

/**
 * Backup status type
 */
export type BackupStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Backup type
 */
export type BackupType = 'manual' | 'scheduled';

/**
 * Backup schedule type
 */
export type BackupSchedule = 'daily' | 'weekly';

/**
 * Backup entity
 */
export interface Backup {
  id: string;
  filename: string;
  size: number;
  status: BackupStatus;
  type: BackupType;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
}

/**
 * Backup config entity
 */
export interface BackupConfig {
  id: string;
  isEnabled: boolean;
  schedule: BackupSchedule;
  backupTime: string;
  retentionCount: number;
  updatedAt: string;
}

/**
 * Create backup DTO
 */
export interface CreateBackupDTO {
  type?: BackupType;
}

/**
 * Update backup config DTO
 */
export interface UpdateBackupConfigDTO {
  isEnabled?: boolean;
  schedule?: BackupSchedule;
  backupTime?: string;
  retentionCount?: number;
}

/**
 * Get backups params
 */
export interface GetBackupsParams {
  page?: number;
  limit?: number;
  status?: BackupStatus;
  type?: BackupType;
}

/**
 * Broadcast audience type
 */
export type BroadcastAudience = 'ALL' | 'PLAN' | 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'EXPIRED' | 'TRIAL';

/**
 * Broadcast status type
 */
export type BroadcastStatus = 'draft' | 'pending' | 'sending' | 'completed' | 'failed';

/**
 * Broadcast button type
 */
export type BroadcastButtonType = 'url' | 'goto';

/**
 * Broadcast button
 */
export interface BroadcastButton {
  id: string;
  broadcastId: string;
  text: string;
  type: BroadcastButtonType;
  value: string;
  createdAt: string;
}

/**
 * Broadcast entity
 */
export interface Broadcast {
  id: string;
  audience: BroadcastAudience;
  planId?: string;
  content: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video';
  status: BroadcastStatus;
  recipientsCount: number;
  sentCount: number;
  failedCount: number;
  createdBy: string;
  createdAt: string;
  sentAt?: string;
  errorMessage?: string;
}

/**
 * Broadcast with buttons
 */
export interface BroadcastWithButtons extends Broadcast {
  buttons: BroadcastButton[];
}

/**
 * Create broadcast input
 */
export interface CreateBroadcastInput {
  audience: BroadcastAudience;
  planId?: string;
  content: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video';
  buttons?: {
    text: string;
    type: BroadcastButtonType;
    value: string;
  }[];
}

/**
 * Update broadcast input
 */
export interface UpdateBroadcastInput {
  audience?: BroadcastAudience;
  planId?: string;
  content?: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video';
  buttons?: {
    text: string;
    type: BroadcastButtonType;
    value: string;
  }[];
}

/**
 * Audience count
 */
export interface AudienceCount {
  audience: BroadcastAudience;
  planId?: string;
  count: number;
}

/**
 * Get broadcasts params
 */
export interface GetBroadcastsParams {
  page?: number;
  limit?: number;
  status?: BroadcastStatus;
  audience?: BroadcastAudience;
}

/**
 * Discount type for promocodes
 */
export type DiscountType = 'percentage' | 'fixed_amount';

/**
 * Promocode entity
 */
export interface Promocode {
  id: string;
  code: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  maxUses?: number;
  usedCount: number;
  expiresAt?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create promocode DTO
 */
export interface CreatePromocodeDTO {
  code: string;
  description?: string;
  discountType: DiscountType;
  discountValue: number;
  maxUses?: number;
  expiresAt?: string;
  isActive?: boolean;
}

/**
 * Update promocode DTO
 */
export interface UpdatePromocodeDTO {
  code?: string;
  description?: string;
  discountType?: DiscountType;
  discountValue?: number;
  maxUses?: number;
  expiresAt?: string;
  isActive?: boolean;
}

/**
 * Get promocodes params
 */
export interface GetPromocodesParams {
  page?: number;
  limit?: number;
  isActive?: boolean;
  search?: string;
}

/**
 * Validate promocode response
 */
export interface ValidatePromocodeResponse {
  valid: boolean;
  promocode?: Promocode;
}

/**
 * Apply promocode response
 */
export interface ApplyPromocodeResponse {
  success: boolean;
  discountAmount: number;
  finalPrice: number;
  promocode: Promocode;
}

/**
 * Gateway type
 */
export type GatewayType = 'stripe' | 'paypal' | 'cryptomus' | 'yookassa' | 'custom';

/**
 * Gateway configuration interface
 */
export interface GatewayConfig {
  // Stripe
  publishableKey?: string;
  secretKey?: string;
  webhookSecret?: string;
  // PayPal
  clientId?: string;
  clientSecret?: string;
  // Cryptomus
  apiKey?: string;
  merchantId?: string;
  // YooKassa
  shopId?: string;
  secretKeyYookassa?: string;
  // Custom
  endpoint?: string;
  apiToken?: string;
  customFields?: Record<string, unknown>;
}

/**
 * Gateway entity
 */
export interface Gateway {
  id: string;
  name: string;
  type: GatewayType;
  isActive: boolean;
  isDefault: boolean;
  config: GatewayConfig;
  displayOrder: number;
  iconUrl?: string;
  description?: string;
  supportedCurrencies: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create gateway DTO
 */
export interface CreateGatewayDTO {
  name: string;
  type: GatewayType;
  isActive?: boolean;
  isDefault?: boolean;
  config?: GatewayConfig;
  displayOrder?: number;
  iconUrl?: string;
  description?: string;
  supportedCurrencies?: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
}

/**
 * Update gateway DTO
 */
export interface UpdateGatewayDTO {
  name?: string;
  type?: GatewayType;
  isActive?: boolean;
  isDefault?: boolean;
  config?: GatewayConfig;
  displayOrder?: number;
  iconUrl?: string;
  description?: string;
  supportedCurrencies?: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
}

/**
 * Get gateways params
 */
export interface GetGatewaysParams {
  isActive?: boolean;
}

/**
 * Banner position type
 */
export type BannerPosition = 'home_top' | 'home_bottom' | 'plans_page' | 'sidebar';

/**
 * Banner entity
 */
export interface Banner {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl: string;
  linkUrl?: string;
  position: BannerPosition;
  displayOrder: number;
  isActive: boolean;
  startsAt?: string;
  endsAt?: string;
  clickCount: number;
  impressionCount: number;
  backgroundColor?: string;
  textColor?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create banner DTO
 */
export interface CreateBannerDTO {
  title: string;
  subtitle?: string;
  imageUrl: string;
  linkUrl?: string;
  position: BannerPosition;
  displayOrder?: number;
  isActive?: boolean;
  startsAt?: string;
  endsAt?: string;
  backgroundColor?: string;
  textColor?: string;
}

/**
 * Update banner DTO
 */
export interface UpdateBannerDTO {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  linkUrl?: string;
  position?: BannerPosition;
  displayOrder?: number;
  isActive?: boolean;
  startsAt?: string;
  endsAt?: string;
  backgroundColor?: string;
  textColor?: string;
}

/**
 * Get banners params
 */
export interface GetBannersParams {
  page?: number;
  limit?: number;
  position?: BannerPosition;
  isActive?: boolean;
}

/**
 * Banner statistics
 */
export interface BannerStatistics {
  bannerId: string;
  clickCount: number;
  impressionCount: number;
  ctr: number;
}

/**
 * Banner filters for position
 */
export type BannerPositionFilter = BannerPosition | 'all';

// ============================================
// Partner Program Types
// ============================================

/**
 * Partner status type
 */
export type PartnerStatus = 'pending' | 'active' | 'suspended' | 'rejected';

/**
 * Earning status type
 */
export type EarningStatus = 'pending' | 'approved' | 'paid' | 'cancelled';

/**
 * Payout status type
 */
export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

/**
 * Payout method type
 */
export type PayoutMethod = 'bank_transfer' | 'paypal' | 'crypto' | 'other';

/**
 * Partner entity
 */
export interface Partner {
  id: string;
  userId: string;
  commissionRate: number;
  totalEarnings: number;
  paidEarnings: number;
  pendingEarnings: number;
  referralCode: string;
  referralCount: number;
  payoutMethod: PayoutMethod | null;
  payoutDetails: Record<string, unknown>;
  status: PartnerStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Partner earning entity
 */
export interface PartnerEarning {
  id: string;
  partnerId: string;
  referredUserId: string | null;
  subscriptionId: string | null;
  amount: number;
  commissionRate: number;
  status: EarningStatus;
  createdAt: string;
  paidAt: string | null;
}

/**
 * Partner payout entity
 */
export interface PartnerPayout {
  id: string;
  partnerId: string;
  amount: number;
  method: PayoutMethod;
  status: PayoutStatus;
  transactionId: string | null;
  notes: string | null;
  createdAt: string;
  processedAt: string | null;
}

/**
 * Create partner DTO
 */
export interface CreatePartnerDTO {
  userId: string;
  commissionRate?: number;
  payoutMethod?: PayoutMethod;
  payoutDetails?: Record<string, unknown>;
  referralCode?: string;
}

/**
 * Update partner DTO
 */
export interface UpdatePartnerDTO {
  commissionRate?: number;
  payoutMethod?: PayoutMethod;
  payoutDetails?: Record<string, unknown>;
  status?: PartnerStatus;
  totalEarnings?: number;
  paidEarnings?: number;
  pendingEarnings?: number;
  referralCount?: number;
}

/**
 * Create payout DTO
 */
export interface CreatePayoutDTO {
  amount: number;
  method: PayoutMethod;
  notes?: string;
}

/**
 * Process payout DTO
 */
export interface ProcessPayoutDTO {
  transactionId?: string;
  notes?: string;
}

/**
 * Get partners params
 */
export interface GetPartnersParams {
  page?: number;
  limit?: number;
  status?: PartnerStatus;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Partner statistics
 */
export interface PartnerStats {
  totalPartners: number;
  pendingPartners: number;
  activePartners: number;
  suspendedPartners: number;
  totalEarnings: number;
  totalPaid: number;
  totalPending: number;
  totalReferrals: number;
}

/**
 * Partner dashboard
 */
export interface PartnerDashboard {
  partner: Partner;
  earnings: {
    total: number;
    paid: number;
    pending: number;
  };
  recentEarnings: PartnerEarning[];
  recentPayouts: PartnerPayout[];
  referrals: number;
}

/**
 * Payout filters
 */
export interface PayoutFilters {
  status?: PayoutStatus;
  partnerId?: string;
  page?: number;
  limit?: number;
}

/**
 * Earning filters
 */
export interface EarningFilters {
  status?: EarningStatus;
  partnerId?: string;
  page?: number;
  limit?: number;
}

// ============================================
// Referral System Types
// ============================================

/**
 * Referral status type
 */
export type ReferralStatus = 'active' | 'completed' | 'cancelled';

/**
 * Referral reward status type
 */
export type ReferralRewardStatus = 'pending' | 'approved' | 'paid' | 'cancelled';

/**
 * Referral rule type
 */
export type ReferralRuleType = 'first_purchase' | 'cumulative' | 'subscription';

/**
 * Referral rule entity
 */
export interface ReferralRule {
  id: string;
  name: string;
  description: string;
  type: ReferralRuleType;
  referrerReward: number;
  referredReward: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive: boolean;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Referral entity
 */
export interface Referral {
  id: string;
  referrerId: string;
  referredId: string;
  referralCode?: string;
  status: ReferralStatus;
  referrerReward: number;
  referredReward: number;
  ruleId?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelledReason?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Referral reward entity
 */
export interface ReferralReward {
  id: string;
  referralId: string;
  userId: string;
  amount: number;
  status: ReferralRewardStatus;
  ruleId?: string;
  description?: string;
  paidAt?: string;
  paidBy?: string;
  paidMethod?: string;
  transactionId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Referral statistics
 */
export interface ReferralStatistics {
  totalReferrals: number;
  activeReferrals: number;
  completedReferrals: number;
  totalRewardsPaid: number;
  pendingRewards: number;
  topReferrers: Array<{
    userId: string;
    referralCount: number;
    totalRewards: number;
  }>;
}

/**
 * Create referral rule DTO
 */
export interface CreateReferralRuleDTO {
  name: string;
  description: string;
  type: ReferralRuleType;
  referrerReward: number;
  referredReward: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive?: boolean;
  startDate?: string;
  endDate?: string;
}

/**
 * Update referral rule DTO
 */
export interface UpdateReferralRuleDTO {
  name?: string;
  description?: string;
  type?: ReferralRuleType;
  referrerReward?: number;
  referredReward?: number;
  minPurchaseAmount?: number;
  appliesToPlans?: string[];
  isActive?: boolean;
  startDate?: string;
  endDate?: string;
}

/**
 * Create referral DTO
 */
export interface CreateReferralDTO {
  referrerId: string;
  referredId: string;
  referralCode?: string;
  ruleId?: string;
  referrerReward?: number;
  referredReward?: number;
  status?: ReferralStatus;
  notes?: string;
}

/**
 * Update referral DTO
 */
export interface UpdateReferralDTO {
  status?: ReferralStatus;
  completedAt?: string;
  cancelledAt?: string;
  cancelledReason?: string;
  notes?: string;
}

/**
 * Get referrals params
 */
export interface GetReferralsParams {
  page?: number;
  limit?: number;
  status?: ReferralStatus;
  referrerId?: string;
  referredId?: string;
  ruleId?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Get referral rules params
 */
export interface GetReferralRulesParams {
  page?: number;
  limit?: number;
  isActive?: boolean;
  type?: ReferralRuleType;
  search?: string;
}

/**
 * Top referrer item
 */
export interface TopReferrer {
  userId: string;
  referralCount: number;
  totalRewards: number;
}

// ============================================
// User Details Types
// ============================================

/**
 * User activity item
 */
export interface UserActivity {
  id: string;
  userId: string;
  action: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

/**
 * User subscription with plan info
 */
export interface UserSubscriptionWithPlan {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  planPrice: number;
  status: SubscriptionStatus;
  startDate: string;
  endDate: string;
  remnawaveUuid?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * User partner info
 */
export interface UserPartnerInfo {
  id: string;
  userId: string;
  commissionRate: number;
  totalEarnings: number;
  paidEarnings: number;
  pendingEarnings: number;
  referralCode: string;
  referralCount: number;
  status: PartnerStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * User referral info
 */
export interface UserReferralInfo {
  id: string;
  referrerId: string;
  referredId: string;
  referralCode?: string;
  status: ReferralStatus;
  referrerReward: number;
  referredReward: number;
  createdAt: string;
  completedAt?: string;
}

/**
 * User stats
 */
export interface UserStats {
  totalSubscriptions: number;
  activeSubscriptions: number;
  totalSpent: number;
  partnerEarnings: number;
  referralsCount: number;
  rewardsEarned: number;
}

/**
 * User details response
 */
export interface UserDetails {
  user: User;
  subscriptions: UserSubscriptionWithPlan[];
  partner: UserPartnerInfo | null;
  partnerEarnings: {
    id: string;
    partnerId: string;
    amount: number;
    status: string;
    createdAt: string;
  }[];
  referralsSent: UserReferralInfo[];
  referralsReceived: UserReferralInfo | null;
  referralRewards: {
    id: string;
    referralId: string;
    userId: string;
    amount: number;
    status: string;
    createdAt: string;
    paidAt?: string;
  }[];
  activity: UserActivity[];
  stats: UserStats;
}

// ============================================
// Multisubscription Types
// ============================================

/**
 * Multisubscription entity - a bundle of subscriptions for a user
 */
export interface Multisubscription {
  id: string;
  userId: string;
  name: string;
  description?: string;
  subscriptionIds: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create multisubscription input
 */
export interface CreateMultisubscriptionInput {
  userId: string;
  name: string;
  description?: string;
  subscriptionIds: string[];
  isActive?: boolean;
}

/**
 * Update multisubscription input
 */
export interface UpdateMultisubscriptionInput {
  name?: string;
  description?: string;
  subscriptionIds?: string[];
  isActive?: boolean;
}

/**
 * Get multisubscriptions params
 */
export interface GetMultisubscriptionsParams {
  page?: number;
  limit?: number;
  userId?: string;
  isActive?: boolean;
  search?: string;
  sortBy?: 'created_at' | 'name' | 'updated_at' | 'id' | 'userId';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Multisubscription statistics
 */
export interface MultisubscriptionStatistics {
  total: number;
  active: number;
  inactive: number;
}
