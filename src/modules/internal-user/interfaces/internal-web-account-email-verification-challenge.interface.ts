/**
 * Describes the narrow linked web-account email verification challenge payload exposed to internal clients.
 */
export interface InternalWebAccountEmailVerificationChallengeInterface {
  readonly webAccountId: string;
  readonly email: string;
  readonly challengeExpiresAt: string;
}
