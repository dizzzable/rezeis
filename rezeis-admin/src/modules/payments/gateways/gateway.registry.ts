/**
 * Gateway registry — maps PaymentGatewayType → IPaymentGateway adapter.
 *
 * Adapters are registered at module init. The registry is injected wherever
 * checkout creation or webhook processing is needed.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { IPaymentGateway } from './gateway.interface';

@Injectable()
export class GatewayRegistry {
  private readonly logger = new Logger(GatewayRegistry.name);
  private readonly adapters = new Map<string, IPaymentGateway>();

  register(adapter: IPaymentGateway): void {
    this.adapters.set(adapter.type, adapter);
    this.logger.log(`Registered payment gateway: ${adapter.type}`);
  }

  get(type: string): IPaymentGateway {
    const adapter = this.adapters.get(type.toUpperCase());
    if (!adapter) throw new NotFoundException(`Payment gateway not found: ${type}`);
    return adapter;
  }

  has(type: string): boolean {
    return this.adapters.has(type.toUpperCase());
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
