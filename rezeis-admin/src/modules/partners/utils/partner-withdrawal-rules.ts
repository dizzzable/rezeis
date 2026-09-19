import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

/**
 * The rules of a partner withdrawal request, and the refusals that name them.
 * ═══════════════════════════════════════════════════════════════════════════
 * Every refusal here is a real HTTP error with a stable `code` the cabinet
 * branches on — the codes are allowlisted in `AdminSafeExceptionFilter`, which
 * would otherwise strip them. The internal withdraw route used to answer three
 * of them as a 2xx `{ error }` body, which a client that only catches reads as
 * a created request; the other three reached the cabinet as bare 400s it
 * could only reword as "failed".
 *
 * The messages stay the English sentences these refusals always carried, so a
 * caller that reads `message` sees what it saw before; the cabinet words them
 * in the customer's language from the code.
 *
 * THE STATUSES. 409 for the state of the program or of this partner (no
 * partner here, the invited-only program, the partner switched off) and 422
 * for an amount the program cannot accept (more than the balance, less than
 * the minimum). Never 401 or 403 on this internal route: the cabinet's admin
 * client classifies those as "the panel rejected our token"
 * (`UpstreamError.isAuthFailure`), and a customer's refusal must not read as
 * the cabinet losing its credentials.
 */

export const PARTNER_NOT_FOUND_CODE = 'PARTNER_NOT_FOUND';
export const PARTNER_PROGRAM_INVITED_ONLY_CODE = 'PARTNER_PROGRAM_INVITED_ONLY';
export const PARTNER_NOT_ACTIVE_CODE = 'PARTNER_NOT_ACTIVE';
export const WITHDRAWAL_INSUFFICIENT_BALANCE_CODE = 'WITHDRAWAL_INSUFFICIENT_BALANCE';
export const WITHDRAWAL_BELOW_MINIMUM_CODE = 'WITHDRAWAL_BELOW_MINIMUM';

/** The balance columns are Postgres `integer`: no minimum above this can be met. */
const MAX_MINOR_UNITS = 2_147_483_647;

/**
 * The operator's «Правила вывода» → «Минимальная сумма вывода (копейки)»:
 * `partnerSettings.minWithdrawalAmount`, in minor units of the balance
 * currency. `0` means there is none — which is what an install that never set
 * it has: the column defaults to `{}`, and nothing ever wrote a default in.
 *
 * Read leniently, because the value is operator data written by more than one
 * build: a whole number, or a string of digits (an older form sent the field
 * as typed). Anything else — absent, `null`, negative, junk — is "no minimum",
 * never a refusal of every request.
 */
export function readMinWithdrawalAmount(partnerSettings: unknown): number {
  if (typeof partnerSettings !== 'object' || partnerSettings === null || Array.isArray(partnerSettings)) {
    return 0;
  }
  const raw: unknown = (partnerSettings as Record<string, unknown>)['minWithdrawalAmount'];
  let value: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    value = Math.floor(raw);
  } else if (typeof raw === 'string' && /^\d{1,10}$/.test(raw.trim())) {
    value = Number(raw.trim());
  }
  if (value === null || value <= 0) return 0;
  return Math.min(value, MAX_MINOR_UNITS);
}

/** An unknown user, or a user who is not a partner: both are "no partner here" to the cabinet. */
export function partnerNotFound(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'Partner not found',
    code: PARTNER_NOT_FOUND_CODE,
  });
}

/** `partnerSettings.invitedOnly` is on, and this partner was not invited. */
export function partnerProgramInvitedOnly(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'The partner program is open to invited users only',
    code: PARTNER_PROGRAM_INVITED_ONLY_CODE,
  });
}

/** The operator switched this partner off («Партнёры» → the partner's switch). */
export function partnerNotActive(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'Partner is not active',
    code: PARTNER_NOT_ACTIVE_CODE,
  });
}

/** The balance holds less than the amount asked for. */
export function insufficientPartnerBalance(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: 'Insufficient partner balance',
    code: WITHDRAWAL_INSUFFICIENT_BALANCE_CODE,
  });
}

/**
 * Below the operator's minimum. Carries the minimum itself, in minor units,
 * through `CODES_CARRYING_MIN_WITHDRAWAL_AMOUNT`, so the cabinet can say how
 * much it takes without another read.
 */
export function withdrawalBelowMinimum(minimum: number): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: `The minimum withdrawal is ${minimum} minor units`,
    code: WITHDRAWAL_BELOW_MINIMUM_CODE,
    minWithdrawalAmount: minimum,
  });
}
