import { TResult } from '../types/result.type';
import { AppException } from '../exception/app-exception';
import { ERRORS } from '../errors/errors';

/**
 * Unwraps a TResult — returns value on success, throws AppException on failure.
 */
export function errorHandler<T>(result: TResult<T>): T {
  if (result.isOk === true) {
    return result.value;
  }
  const failed = result as { isOk: false; error: { code: string; message: string; httpCode: number } };
  const errorEntry = Object.values(ERRORS).find((e) => e.code === failed.error.code);
  throw new AppException(errorEntry ?? ERRORS.INTERNAL_SERVER_ERROR);
}
