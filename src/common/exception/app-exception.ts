import { HttpException } from '@nestjs/common';

type ErrorDef = { code: string; message: string; httpCode: number };

/**
 * Application exception with structured error code.
 * Works with ERRORS constants from common/errors.
 *
 * Usage:
 *   throw AppException.from(ERRORS.USER_NOT_FOUND);
 */
export class AppException extends HttpException {
  readonly errorCode: string;

  constructor(error: ErrorDef) {
    super(
      { statusCode: error.httpCode, message: error.message, errorCode: error.code },
      error.httpCode,
    );
    this.errorCode = error.code;
  }

  static from(error: ErrorDef): AppException {
    return new AppException(error);
  }
}
