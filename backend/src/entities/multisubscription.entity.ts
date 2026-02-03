/**
 * Multisubscription entity interface
 * Represents a bundle of subscriptions for a user
 */
export interface Multisubscription {
  id: string;
  userId: string;
  name: string;
  description?: string;
  subscriptionIds: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create multisubscription DTO
 */
export type CreateMultisubscriptionDto = Omit<Multisubscription, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * Update multisubscription DTO
 */
export type UpdateMultisubscriptionDto = Partial<Omit<Multisubscription, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Multisubscription filters for pagination
 */
export interface MultisubscriptionFilters {
  userId?: string;
  isActive?: boolean;
  search?: string;
}
