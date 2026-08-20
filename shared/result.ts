/**
 * Transport-safe result type used by every IPC handler.
 *
 * Errors never cross the IPC bridge as thrown exceptions: Electron serialises
 * those into opaque `Error: Error invoking remote method ...` strings that are
 * useless in the UI. Handlers return a discriminated union instead, so the
 * renderer always gets a stable `code` it can branch on and a message it can
 * show to the user.
 */
export type IpcErrorCode =
  | 'CANCELLED'
  | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'NOT_A_PROJECT'
  | 'PATH_OUTSIDE_PROJECT'
  | 'PERMISSION_DENIED'
  | 'ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  /** The operation exists, but not on the platform the app is running on. */
  | 'UNSUPPORTED_PLATFORM'
  | 'IO_ERROR'
  | 'INTERNAL';

export interface IpcFailure {
  ok: false;
  code: IpcErrorCode;
  message: string;
  /** Optional developer-facing detail; never shown verbatim in the UI. */
  detail?: string;
}

export interface IpcSuccess<T> {
  ok: true;
  value: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

export function ok<T>(value: T): IpcSuccess<T> {
  return { ok: true, value };
}

export function fail(code: IpcErrorCode, message: string, detail?: string): IpcFailure {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail };
}

/** Narrowing helper for renderer code. */
export function isFailure<T>(result: IpcResult<T>): result is IpcFailure {
  return result.ok === false;
}

/**
 * Unwraps a result or throws a plain `Error` carrying the code. Use in renderer
 * call sites that already sit inside a try/catch or an error boundary.
 */
export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw new IpcError(result.code, result.message, result.detail);
}
