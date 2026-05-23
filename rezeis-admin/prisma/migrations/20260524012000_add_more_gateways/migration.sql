-- AlterEnum: add new payment gateways
ALTER TYPE "PaymentGatewayType" ADD VALUE 'WATA';
ALTER TYPE "PaymentGatewayType" ADD VALUE 'AURAPAY';
ALTER TYPE "PaymentGatewayType" ADD VALUE 'ROLLYPAY';
ALTER TYPE "PaymentGatewayType" ADD VALUE 'SEVERPAY';
ALTER TYPE "PaymentGatewayType" ADD VALUE 'LAVA';
