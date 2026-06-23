-- Add the internal "partner balance" payment method. A partner can spend
-- their accrued balance to pay for a subscription; such transactions are
-- completed synchronously (no external provider) after debiting the balance.
ALTER TYPE "PaymentGatewayType" ADD VALUE IF NOT EXISTS 'PARTNER_BALANCE';
