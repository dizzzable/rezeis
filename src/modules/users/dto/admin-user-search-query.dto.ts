import { InternalUserSessionQueryDto } from '../../internal-user/dto/internal-user-session-query.dto';

/**
 * Accepts exactly one user identifier for admin user lookups.
 */
export class AdminUserSearchQueryDto extends InternalUserSessionQueryDto {}
