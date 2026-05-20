import { InternalUserSessionInterface } from './internal-user-session.interface';
import { InternalUserSubscriptionInterface } from './internal-user-subscription.interface';

/**
 * Describes the aggregated internal-user read payload for one resolved user snapshot.
 */
export interface InternalUserSearchResultInterface {
  readonly session: InternalUserSessionInterface;
  readonly subscription: InternalUserSubscriptionInterface | null;
}
