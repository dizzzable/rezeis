-- AlterEnum: add CryptoPay (@CryptoBot Crypto Pay API) payment gateway.
-- Idempotent so a re-run (or a partially-applied deploy) never fails.
ALTER TYPE "PaymentGatewayType" ADD VALUE IF NOT EXISTS 'CRYPTOPAY';
