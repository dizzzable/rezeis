/**
 * API module exports
 *
 * This module provides HTTP client configuration and authentication services
 * for communicating with the backend API.
 *
 * @example
 * ```typescript
 * import { apiClient, authService } from './api';
 *
 * // Use API client for requests
 * const response = await apiClient.get('/some-endpoint');
 *
 * // Use auth service for authentication
 * await authService.usernameLogin({ credentials: { username, password } });
 * ```
 */

// Client exports
export { default as apiClient, getToken, setToken, clearTokens, getErrorMessage, isAxiosError } from './client';
export type { AxiosError } from 'axios';

// Auth service exports
export { authService, telegramAuth, usernameLogin, register, logout, getMe, refreshToken, isAuthenticated } from './auth.service';

// Entity services exports
export { usersService } from './users.service';
export { subscriptionsService } from './subscriptions.service';
export { plansService } from './plans.service';
export { statisticsService } from './statistics.service';
export { accessService } from './access.service';
export { backupService } from './backup.service';
export { broadcastService } from './broadcast.service';
export { promocodesService } from './promocodes.service';
export { gatewaysService } from './gateways.service';
export { bannersService } from './banners.service';
export { partnersService } from './partners.service';
export { adminPartnerService } from './admin-partner.service';
export { partnerClientService } from './partner-client.service';
export { referralsService } from './referrals.service';
export { remnawaveService } from './remnawave.service';
export { importerService } from './importer.service';
export { notificationsService } from './notifications.service';
export { clientService } from './client.service';
export type {
  UserStats,
  UserSubscription,
  PlanWithDurations,
  CreatePaymentData,
  Payment,
  PaymentHistoryItem,
  PaymentHistoryResponse,
  QRCodeData,
  ReferralWithUser,
  PartnerData,
  Notification,
  NotificationsResponse,
  WithdrawReferralResponse,
  PayoutRequestData,
  PayoutRequestResponse,
  RenewSubscriptionResponse,
} from './client.service';
