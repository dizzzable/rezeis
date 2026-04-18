import { Controller, Get } from '@nestjs/common';

import { AppService } from './app.service';

interface AppStatusResponse {
  readonly name: string;
  readonly status: string;
  readonly timestamp: string;
}

/**
 * Exposes baseline application endpoints.
 */
@Controller()
export class AppController {
  public constructor(private readonly appService: AppService) {}

  /**
   * Returns a baseline service status payload.
   */
  @Get()
  public getStatus(): AppStatusResponse {
    return this.appService.getStatus();
  }
}
