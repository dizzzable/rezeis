import type { INestApplication } from '@nestjs/common';
import helmet, { type HelmetOptions } from 'helmet';

import { CorrelationIdMiddleware } from '../middlewares/correlation-id.middleware';
import { createHttpCompressionMiddleware } from './http-compression';
import { noRobotsMiddleware } from './no-robots';
import {
  buildTrustedProxyValue,
  EXPRESS_TRUST_PROXY_SETTING,
  TrustedProxyMode,
} from './trusted-proxy';

export const EXPRESS_POWERED_BY_SETTING = 'x-powered-by';

export interface HttpRuntimeOptions {
  readonly trustProxy?: TrustedProxyMode;
  readonly nodeEnv?: string;
}

type RuntimeApplication = Pick<INestApplication, 'use'> & {
  readonly disable?: (setting: string) => unknown;
  readonly set?: (setting: string, value: unknown) => unknown;
};

export function configureHttpRuntimeMiddleware(app: RuntimeApplication, options: HttpRuntimeOptions = {}): void {
  app.set?.(EXPRESS_TRUST_PROXY_SETTING, buildTrustedProxyValue(options.trustProxy));
  app.disable?.(EXPRESS_POWERED_BY_SETTING);
  app.use(noRobotsMiddleware);
  app.use(helmet(buildHelmetOptions(options.nodeEnv)));
  app.use(createHttpCompressionMiddleware());
  app.use((req: unknown, res: unknown, next: unknown) => {
    new CorrelationIdMiddleware().use(req as never, res as never, next as never);
  });
}

export function buildHelmetOptions(nodeEnv = process.env.NODE_ENV): HelmetOptions {
  return {
    contentSecurityPolicy: nodeEnv === 'production'
      ? {
          useDefaults: false,
          reportOnly: true,
          directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            scriptSrc: ["'self'"],
            scriptSrcAttr: ["'none'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            fontSrc: ["'self'", 'data:'],
            connectSrc: ["'self'", 'https:', 'wss:', 'ws:'],
            mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
            workerSrc: ["'self'", 'blob:'],
            manifestSrc: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  };
}
