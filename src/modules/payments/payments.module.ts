import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { redisConfig } from '../../common/config/redis.config';
import { RemnawaveModule } from '../remnawave/remnawave.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PAYMENT_RECONCILIATION_QUEUE } from './constants/payment-reconciliation.constant';
import { AdminPaymentGatewaysController } from './controllers/admin-payment-gateways.controller';
import { AdminPaymentReconciliationController } from './controllers/admin-payment-reconciliation.controller';
import { AdminPaymentTransactionsController } from './controllers/admin-payment-transactions.controller';
import { AdminPaymentWebhooksController } from './controllers/admin-payment-webhooks.controller';
import { InternalPaymentWebhooksController } from './controllers/internal-payment-webhooks.controller';
import { InternalPaymentsController } from './controllers/internal-payments.controller';
import { PublicPaymentWebhooksController } from './controllers/public-payment-webhooks.controller';
import { PaymentReconciliationProcessor } from './processors/payment-reconciliation.processor';
import { PaymentOpsAlertService } from './services/payment-ops-alert.service';
import { PaymentProviderExecutionService } from './services/payment-provider-execution.service';
import { PaymentGatewayRegistryService } from './services/payment-gateway-registry.service';
import { PaymentWebhookInboxService } from './services/payment-webhook-inbox.service';
import { PaymentWebhookIngressService } from './services/payment-webhook-ingress.service';
import { PaymentWebhookNormalizerService } from './services/payment-webhook-normalizer.service';
import { PaymentWebhookOpsService } from './services/payment-webhook-ops.service';
import { PaymentWebhookPayloadRedactionService } from './services/payment-webhook-payload-redaction.service';
import { PaymentReconciliationService } from './services/payment-reconciliation.service';
import { PaymentSubscriptionMutationService } from './services/payment-subscription-mutation.service';
import { PaymentsCheckoutService } from './services/payments-checkout.service';
import { PaymentsTransactionsService } from './services/payments-transactions.service';
import { TelegramStarsWebhookService } from './services/telegram-stars-webhook.service';

@Module({
  imports: [
    AuthModule,
    HttpModule,
    RemnawaveModule,
    SubscriptionsModule,
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (configuration: ConfigType<typeof redisConfig>) => ({
        connection: {
          url: configuration.url,
        },
      }),
    }),
    BullModule.registerQueue({
      name: PAYMENT_RECONCILIATION_QUEUE,
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
  ],
  providers: [
    PaymentGatewayRegistryService,
    PaymentsTransactionsService,
    PaymentsCheckoutService,
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
  ],
})
export class PaymentsModule {}
