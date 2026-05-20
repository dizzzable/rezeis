import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { InternalUserSessionQueryDto } from '../dto/internal-user-session-query.dto';

export interface InternalUserIdentifier {
  readonly type: 'userId' | 'telegramId' | 'email' | 'login';
  readonly value: string;
}

/**
 * Picks exactly one identifier from the session query DTO.
 *
 * The DTO accepts four mutually-exclusive identifiers (`userId`,
 * `telegramId`, `email`, `login`) so that internal callers can lookup the
 * same user from any direction. We reject ambiguous queries where the
 * caller passes more than one — picking would hide bugs upstream.
 */
export function resolveInternalUserIdentifier(
  query: InternalUserSessionQueryDto,
): InternalUserIdentifier {
  const identifiers: InternalUserIdentifier[] = [];
  if (query.userId) {
    identifiers.push({ type: 'userId', value: query.userId });
  }
  if (query.telegramId) {
    identifiers.push({ type: 'telegramId', value: query.telegramId });
  }
  if (query.email) {
    identifiers.push({ type: 'email', value: query.email });
  }
  if (query.login) {
    identifiers.push({ type: 'login', value: query.login });
  }
  if (identifiers.length !== 1) {
    throw new BadRequestException(
      'Exactly one identifier must be provided: userId, telegramId, email, or login',
    );
  }
  return identifiers[0];
}

export function buildUserWhereUniqueInput(
  identifier: InternalUserIdentifier,
): Prisma.UserWhereUniqueInput {
  if (identifier.type === 'userId') {
    return { id: identifier.value };
  }
  if (identifier.type === 'telegramId') {
    return { telegramId: BigInt(identifier.value) };
  }
  return { email: identifier.value };
}

export function normalizeLookupEmail(email: string): string {
  return email.trim().toLowerCase();
}
