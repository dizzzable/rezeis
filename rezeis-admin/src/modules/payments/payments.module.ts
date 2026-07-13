import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { OutboundHttpModule } from '../../common/http/outbound-http.module';
import { AddOnEntitlementsModule } from '../add-on-entitlements/add-on-entitlements.module';
import { AuthModule } from '../auth/auth.module';
import { PartnersModule } from '../partners/partners.module';
import { AdvertisingModule } from '../advertising/advertising.module';
import { PlansModule } from '../plans/plans.module';
import { ProfileSyncModule } from '../profile-sync/profile-sync.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SettingsModule } from '../settings/settings.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PAYMENT_RECONCILIATION_QUEUE } from './constants/payment-reconciliation.constant';
import { MOY_NALOG_QUEUE } from './constants/moy-nalog.constant';
import { AdminPaymentGatewaysController } from './controllers/admin-payment-gateways.controller';
import { AdminPaymentReconciliationController } from './controllers/admin-payment-reconciliation.controller';
import { AdminPaymentTransactionsController } from './controllers/admin-payment-transactions.controller';
import { AdminPaymentWebhooksController } from './controllers/admin-payment-webhooks.controller';
import { InternalPaymentWebhooksController } from './controllers/internal-payment-webhooks.controller';
import { InternalPaymentsController } from './controllers/internal-payments.controller';
import { InternalAddOnsPurchaseController } from './controllers/internal-addons-purchase.controller';
import { PublicPaymentWebhooksController } from './controllers/public-payment-webhooks.controller';
import { PaymentReconciliationProcessor } from './processors/payment-reconciliation.processor';
import { MoyNalogProcessor } from './processors/moy-nalog.processor';
import { PaymentAutoRetryService } from './services/payment-auto-retry.service';
import { PaymentPendingExpiryService } from './services/payment-pending-expiry.service';
import { PaymentOpsAlertService } from './services/payment-ops-alert.service';
import { PaymentProviderExecutionService } from './services/payment-provider-execution.service';
import { PaymentGatewayRegistryService } from './services/payment-gateway-registry.service';
import { PaymentWebhookInboxService } from './services/payment-webhook-inbox.service';
import { PaymentWebhookIngressService } from './services/payment-webhook-ingress.service';
import { PaymentWebhookNormalizerService } from './services/payment-webhook-normalizer.service';
import { PaymentWebhookOpsService } from './services/payment-webhook-ops.service';
import { PaymentWebhookPayloadRedactionService } from './services/payment-webhook-payload-redaction.service';
import { PaymentReconciliationService } from './services/payment-reconciliation.service';
import { MoyNalogApiService } from './services/moy-nalog-api.service';
import { MoyNalogQueueService } from './services/moy-nalog-queue.service';
import { PaymentSubscriptionMutationService } from './services/payment-subscription-mutation.service';
import { PaymentsCheckoutService } from './services/payments-checkout.service';
import { PaymentsRenewalCheckoutService } from './services/payments-renewal-checkout.service';
import { PaymentsTransactionsService } from './services/payments-transactions.service';
import { AddOnPurchaseService } from './services/addon-purchase.service';
import { AddOnFulfillmentRecoveryService } from './services/add-on-fulfillment-recovery.service';
import { PartnerBalancePaymentService } from './services/partner-balance-payment.service';
import { TelegramStarsWebhookService } from './services/telegram-stars-webhook.service';

@Module({
  imports: [
    AuthModule,
    OutboundHttpModule,
    AddOnEntitlementsModule,
    RemnawaveModule,
    SubscriptionsModule,
    PlansModule,
    PartnersModule,
    AdvertisingModule,
    ReferralsModule,
    SettingsModule,
    ProfileSyncModule,
    BullModule.registerQueue({
      name: PAYMENT_RECONCILIATION_QUEUE,
    }),
    BullModule.registerQueue({
      name: MOY_NALOG_QUEUE,
    }),
  ],
  controllers: [
    AdminPaymentGatewaysController,
    AdminPaymentTransactionsController,
    AdminPaymentWebhooksController,
    AdminPaymentReconciliationController,
    PublicPaymentWebhooksController,
    InternalPaymentWebhooksController,
    InternalPaymentsController,
    InternalAddOnsPurchaseController,
  ],
  providers: [
    PaymentGatewayRegistryService,
    PaymentsTransactionsService,
    PaymentsCheckoutService,
    PaymentsRenewalCheckoutService,
    AddOnPurchaseService,
    PartnerBalancePaymentService,
    PaymentOpsAlertService,
    PaymentProviderExecutionService,
    PaymentWebhookNormalizerService,
    PaymentWebhookInboxService,
    PaymentWebhookPayloadRedactionService,
    PaymentWebhookIngressService,
    PaymentWebhookOpsService,
    TelegramStarsWebhookService,
    PaymentSubscriptionMutationService,
    PaymentReconciliationService,
    PaymentReconciliationProcessor,
    MoyNalogApiService,
    MoyNalogQueueService,
    MoyNalogProcessor,
    PaymentAutoRetryService,
    PaymentPendingExpiryService,
    AddOnFulfillmentRecoveryService,
  ],
})
export class PaymentsModule {}
