const LOGIN_PATTERN = /^[A-Za-z0-9._-]+$/;

interface LoginPolicyInterface {
  readonly pattern: RegExp;
  readonly minLength: number;
  readonly maxLength: number;
  sanitizeLogin: (login: string) => string;
  normalizeLogin: (login: string) => string;
  isValidLogin: (login: string) => boolean;
}

/**
 * Defines the shared login contract for admin and linked web-account credentials.
 */
export const loginPolicy: LoginPolicyInterface = {
  pattern: LOGIN_PATTERN,
  minLength: 3,
  maxLength: 64,
  sanitizeLogin: (login: string): string => login.trim(),
  normalizeLogin: (login: string): string => login.trim().toLowerCase(),
  isValidLogin: (login: string): boolean => {
    const sanitizedLogin: string = login.trim();
    return (
      sanitizedLogin.length >= 3 &&
      sanitizedLogin.length <= 64 &&
      LOGIN_PATTERN.test(sanitizedLogin)
    );
  },
};
