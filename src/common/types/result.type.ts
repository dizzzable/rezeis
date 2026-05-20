/**
 * Result type pattern (inspired by remnawave backend-main).
 * Forces explicit error handling without relying on exceptions for control flow.
 */

export type TResult<T> =
  | { readonly isOk: true; readonly value: T }
  | { readonly isOk: false; readonly error: TError };

export interface TError {
  readonly code: string;
  readonly message: string;
  readonly httpCode: number;
}

export function ok<T>(value: T): TResult<T> {
  return { isOk: true, value };
}

export function fail<T = never>(error: TError): TResult<T> {
  return { isOk: false, error };
}
