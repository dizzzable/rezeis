import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton
 * This ensures we have a single instance of PrismaClient across the application
 */
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
        ? ['query', 'info', 'warn', 'error']
        : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

/**
 * Disconnect Prisma client
 * Call this when shutting down the application
 */
export async function disconnectPrisma(): Promise<void> {
    await prisma.$disconnect();
}
