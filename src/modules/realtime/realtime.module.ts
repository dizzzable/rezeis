import { forwardRef, Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';

import { authConfig } from '../../common/config/auth.config';
import { AuthModule } from '../auth/auth.module';
import { InternalUserRealtimeController } from './controllers/internal-user-realtime.controller';
import { RealtimeGateway } from './realtime.gateway';
import { UserRealtimeService } from './services/user-realtime.service';

/**
 * Global realtime module — the gateway is exported so SystemEventsService
 * (and any feature that wants to trigger ad-hoc broadcasts) can inject it
 * without explicit imports.
 *
 * Two surfaces live here:
 *   - `RealtimeGateway` — Socket.IO endpoint for admin clients
 *     (`/realtime` namespace, JWT-authenticated).
 *   - `InternalUserRealtimeController` — SSE endpoint that reiwa proxies
 *     to user PWA / Telegram Mini App, scoped by user via projection
 *     whitelist.
 *
 * The JwtModule import is local: we only need it to verify incoming
 * handshake tokens. We deliberately do not import AuthModule's full
 * dependency graph there to avoid a cyclic dependency.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [authConfig.KEY],
      useFactory: (
        authConfiguration: ConfigType<typeof authConfig>,
      ): JwtModuleOptions => ({
        secret: authConfiguration.jwtSecret,
      }),
    }),
  ],
  controllers: [InternalUserRealtimeController],
  providers: [RealtimeGateway, UserRealtimeService],
  exports: [RealtimeGateway, UserRealtimeService],
})
export class RealtimeModule {}

// Re-export the broadcaster surface so consumers can rely on a stable
// import path without reaching into internal files.
export type RealtimeBroadcaster = Pick<
  RealtimeGateway,
  'broadcast' | 'disconnectAdmin' | 'connectedCount'
>;

// `forwardRef` is re-exported here only to keep the public module-surface
// import-friendly for callers that ever need to break a cycle.
export { forwardRef };
