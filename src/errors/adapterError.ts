export type AdapterErrorCode =
  | "INVALID_REQUEST"
  | "UNKNOWN_MODEL"
  | "CURSOR_BIN_NOT_FOUND"
  | "INVALID_WORKING_DIRECTORY"
  | "CURSOR_TIMEOUT"
  | "CURSOR_NON_ZERO_EXIT"
  | "CURSOR_MALFORMED_OUTPUT"
  | "INTERNAL_ERROR";

export class AdapterError extends Error {
  readonly statusCode: number;
  readonly code: AdapterErrorCode;
  readonly details?: unknown;

  constructor(code: AdapterErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const asAdapterError = (error: unknown): AdapterError => {
  if (error instanceof AdapterError) {
    return error;
  }

  return new AdapterError("INTERNAL_ERROR", "Unexpected internal error.", 500);
};
