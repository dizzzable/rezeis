/**
 * Plan entity interface
 */
export interface Plan {
  id: string;
  name: string;
  description?: string;
  price: number;
  durationDays: number;
  trafficLimit?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create plan DTO
 */
export type CreatePlanDTO = Omit<Plan, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Update plan DTO
 */
export type UpdatePlanDTO = Partial<Omit<Plan, 'id' | 'createdAt' | 'updatedAt'>>;
