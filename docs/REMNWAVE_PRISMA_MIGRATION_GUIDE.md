# Remnawave Tables Migration to Prisma - Guide

## Overview

This guide documents the migration of Remnawave-related database tables from raw SQL to Prisma ORM for the rezeis project.

## Tables Migrated

The following tables have been added to the Prisma schema:

1. **remnawave_config** - Configuration for Remnawave API
2. **remnawave_servers** - Server information from Remnawave panel
3. **user_vpn_keys** - VPN keys for users
4. **remnawave_sync_logs** - Synchronization operation logs
5. **remnawave_user_links** - Links between Telegram users and Remnawave profiles (already existed)

## New Enum Added

```prisma
enum SyncLogStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
}
```

## Files Created/Modified

### New Files

1. **`backend/src/lib/prisma.ts`** - Prisma client singleton
2. **`backend/src/services/multi-subscription-sync-prisma.service.ts`** - Prisma-based sync service
3. **`backend/src/repositories/remnawave-prisma.repository.ts`** - Prisma-based repositories
4. **`backend/prisma/migrations/20250203130000_add_remnawave_tables/migration.sql`** - Database migration

### Modified Files

1. **`backend/prisma/schema.prisma`** - Added new models and enum
2. **`backend/package.json`** - Added `@prisma/client` and `prisma` dependencies
3. **`backend/src/services/remnawave.service.ts`** - Made Pool parameter optional
4. **`backend/src/services/index.ts`** - Exported new Prisma-based service
5. **`backend/src/repositories/index.ts`** - Exported new Prisma-based repositories

## Migration Steps

### Step 1: Install Dependencies

```bash
cd rezeis/backend
npm install
```

### Step 2: Generate Prisma Client

```bash
npx prisma generate
```

This generates the TypeScript types for the Prisma client based on the schema.

### Step 3: Run Database Migration

```bash
npx prisma migrate dev --name add_remnawave_tables
```

Or apply the migration directly:

```bash
npx prisma migrate deploy
```

### Step 4: Verify Migration

Check that the tables were created successfully:

```bash
npx prisma studio
```

This opens Prisma Studio where you can view and manage the database.

## Using the New Prisma-Based Code

### Prisma Client

```typescript
import { prisma } from './lib/prisma.js';

// Example: Create a new server
const server = await prisma.remnawaveServer.create({
  data: {
    remnawave_id: 'server-uuid',
    name: 'Server Name',
    address: '192.168.1.1',
    port: 443,
    protocol: 'vless',
  },
});
```

### Prisma Repositories

```typescript
import {
  RemnawaveServerPrismaRepository,
  UserVpnKeyPrismaRepository,
} from './repositories/index.js';

const serverRepo = new RemnawaveServerPrismaRepository();
const keyRepo = new UserVpnKeyPrismaRepository();

// Find active servers
const activeServers = await serverRepo.findActive();

// Get traffic stats
const stats = await keyRepo.getTrafficStats();
```

### Multi-Subscription Sync Service (Prisma)

```typescript
import { MultiSubscriptionSyncPrismaService } from './services/index.js';

const syncService = new MultiSubscriptionSyncPrismaService();

// Sync all users
const report = await syncService.syncAllUsers();

// Get linked profiles
const profiles = await syncService.getLinkedProfiles('123456789');
```

## Backward Compatibility

The original SQL-based services and repositories remain functional. You can gradually migrate to Prisma:

```typescript
// Old way (still works)
import { MultiSubscriptionSyncService } from './services/multi-subscription-sync.service.js';
const oldService = new MultiSubscriptionSyncService(pool);

// New way (Prisma)
import { MultiSubscriptionSyncPrismaService } from './services/multi-subscription-sync-prisma.service.js';
const newService = new MultiSubscriptionSyncPrismaService();
```

## Model Relations

### UserVpnKey Relations

```prisma
model UserVpnKey {
  user         User          @relation(fields: [user_id], references: [id], onDelete: Cascade)
  subscription Subscription? @relation(fields: [subscription_id], references: [id], onDelete: SetNull)
  server       RemnawaveServer @relation(fields: [server_id], references: [id], onDelete: Cascade)
}
```

### Usage with Relations

```typescript
// Get VPN keys with related data
const keys = await prisma.userVpnKey.findMany({
  where: { user_id: userId },
  include: {
    server: true,
    subscription: true,
  },
});
```

## Type Mapping

| SQL Type | Prisma Type | TypeScript Type |
|----------|-------------|-----------------|
| UUID | String | string |
| TEXT | String | string |
| INTEGER | Int | number |
| BOOLEAN | Boolean | boolean |
| TIMESTAMP | DateTime | Date |
| JSONB | Json | Record<string, unknown> |
| ENUM | Enum | Enum values |

## Troubleshooting

### Type Errors

If you see TypeScript errors like `Cannot find module '@prisma/client'`, ensure you have:

1. Run `npm install`
2. Run `npx prisma generate`

### Database Connection

Ensure your `DATABASE_URL` environment variable is set correctly:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/dbname?schema=public"
```

### Migration Failures

If a migration fails, check:

1. Database connectivity
2. Existing table conflicts
3. User permissions

To reset and re-run migrations (⚠️ **WARNING: This will delete data**):

```bash
npx prisma migrate reset
```

## Next Steps

1. **Testing**: Test all Remnawave-related functionality
2. **Migration**: Gradually replace SQL queries with Prisma calls
3. **Cleanup**: Once fully migrated, remove legacy SQL repositories
4. **Optimization**: Use Prisma's query optimization features

## Benefits of Prisma Migration

1. **Type Safety**: Full TypeScript support with auto-generated types
2. **Relations**: Easy handling of database relations
3. **Migrations**: Version-controlled schema changes
4. **Prisma Studio**: Visual database management tool
5. **Query Optimization**: Built-in query optimization
6. **Transactions**: Simplified transaction handling

## Support

For issues or questions regarding this migration, refer to:
- [Prisma Documentation](https://www.prisma.io/docs/)
- [Prisma Client API Reference](https://www.prisma.io/docs/reference/api-reference/prisma-client-reference)
