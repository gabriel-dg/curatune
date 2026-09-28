// Typed errors with the stable codes used by spotikit (spotikit commit b3531aa, src/spotikit/errors.py).
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
  | "API_ERROR";

export type Details = Record<string, unknown>;

export class SpotikitError extends Error {
  readonly code: ErrorCode;
  readonly details: Details;

  constructor(code: ErrorCode, message: string, details: Details = {}) {
    super(message);
    this.name = "SpotikitError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details: Details } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
