// Typed errors with the stable codes used by curatune (curatune commit b3531aa, src/curatune/errors.py).
// Messages and details must never contain tokens, authorization codes, or PKCE verifiers.

export type ErrorCode =
  | "CONFIG_ERROR"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AUTH_ERROR"
  | "AUTH_STATE_MISMATCH"
  | "INVALID_REFERENCE"
  | "INVALID_ARGUMENT"
  | "API_BAD_REQUEST"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "API_QUOTA_EXCEEDED"
  | "NETWORK_ERROR"
  | "UNTRUSTED_URL"
  | "CONCURRENT_MODIFICATION"
  | "DUPLICATE_NAME"
  | "PLAN_INVALID"
  | "PLAN_INCONSISTENT"
  | "PLAN_CHECKSUM_MISMATCH"
  | "PLAN_ALREADY_APPLIED"
  | "PLAN_NOT_FOUND"
  | "NO_CHANGES"
  | "SNAPSHOT_MISMATCH"
  | "APPLY_FAILED"
  | "VERIFICATION_FAILED"
  | "RECORDING_DATES_MISSING"
  | "API_ERROR";

export type Details = Record<string, unknown>;

export class CuratuneError extends Error {
  readonly code: ErrorCode;
  readonly details: Details;

  constructor(code: ErrorCode, message: string, details: Details = {}) {
    super(message);
    this.name = "CuratuneError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details: Details } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
