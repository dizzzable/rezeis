export const API_TOKEN_JWT_TYPE = 'api_token';
export const API_TOKEN_JWT_AUDIENCE = 'rezeis-internal-api';
export const API_TOKEN_LAST_USED_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
export const API_TOKEN_TTL_DAYS = 180;
export const API_TOKEN_TTL_MS = API_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
export const API_TOKEN_JWT_EXPIRES_IN = `${API_TOKEN_TTL_DAYS}d`;
