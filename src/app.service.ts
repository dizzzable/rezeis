import { Injectable } from '@nestjs/common';

interface AppStatusResponse {
  readonly name: string;
  readonly status: string;
  readonly timestamp: string;
}

/**
 * Provides baseline application state.
 */
@Injectable()
export class AppService {
  /**
   * Returns a static application status payload.
   */
  public getStatus(): AppStatusResponse {
    return {
      name: 'rezeis-admin',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
