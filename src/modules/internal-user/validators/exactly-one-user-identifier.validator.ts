import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

interface InternalUserIdentifierCarrier {
  readonly userId?: string;
  readonly telegramId?: string;
  readonly email?: string;
  readonly login?: string;
}

/**
 * Validates that exactly one supported user identifier is present.
 */
@ValidatorConstraint({ name: 'ExactlyOneUserIdentifier', async: false })
export class ExactlyOneUserIdentifierValidator implements ValidatorConstraintInterface {
  /**
   * Checks whether the payload includes exactly one identifier.
   */
  public validate(_value: unknown, validationArguments: ValidationArguments): boolean {
    const object = validationArguments.object as InternalUserIdentifierCarrier;
    return countDefinedIdentifiers(object) === 1;
  }

  /**
   * Returns the validation error message for invalid identifier payloads.
   */
  public defaultMessage(): string {
    return 'Exactly one identifier must be provided: userId, telegramId, email, or login';
  }
}

function countDefinedIdentifiers(object: InternalUserIdentifierCarrier): number {
  const values = [object.userId, object.telegramId, object.email, object.login];
  return values.filter((value) => value !== undefined && value !== null).length;
}
