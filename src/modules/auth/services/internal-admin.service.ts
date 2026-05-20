import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { appConfig } from '../../../common/config/app.config';
import { InternalAdminRequest } from '../interfaces/internal-admin-request.interface';

interface InternalAdminTestResponse {
  readonly status: string;
  readonly service: string;
  readonly auth: {
    readonly type: string;
    readonly isAuthorized: boolean;
  };
  readonly request: InternalAdminRequest;
  readonly timestamp: string;
}

/**
 * Builds internal admin responses for protected routes.
 */
@Injectable()
export class InternalAdminService {
  public constructor(
    @Inject(appConfig.KEY)
    private readonly appConfiguration: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Returns a structured response for the internal auth smoke test endpoint.
   */
  public getTestResponse(request: InternalAdminRequest): InternalAdminTestResponse {
    return {
      status: 'ok',
      service: this.appConfiguration.serviceName,
      auth: {
        type: 'internal-api-key',
        isAuthorized: true,
      },
      request,
      timestamp: new Date().toISOString(),
    };
  }
}
