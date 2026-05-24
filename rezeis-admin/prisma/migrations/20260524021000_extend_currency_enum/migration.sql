-- Add cryptocurrency values to the Currency enum so payment gateway rows
-- can declare LTC / BNB / DASH / SOL / XMR / USDC / TRX as their default
-- currency (Cryptomus and Heleket support all of these).
ALTER TYPE "Currency" ADD VALUE 'LTC';
ALTER TYPE "Currency" ADD VALUE 'BNB';
ALTER TYPE "Currency" ADD VALUE 'DASH';
ALTER TYPE "Currency" ADD VALUE 'SOL';
ALTER TYPE "Currency" ADD VALUE 'XMR';
ALTER TYPE "Currency" ADD VALUE 'USDC';
ALTER TYPE "Currency" ADD VALUE 'TRX';
