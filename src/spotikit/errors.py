"""Typed exceptions. Each carries a stable `code` that the CLI emits in its JSON error envelope."""

from __future__ import annotations

from typing import Any


class SpotikitError(Exception):
    code = "ERROR"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None, code: str | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}
        if code:
            self.code = code

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class ConfigError(SpotikitError):
    code = "CONFIG_ERROR"


class AuthRequired(SpotikitError):
    code = "AUTH_REQUIRED"


class AuthExpired(SpotikitError):
    """The refresh token expired (6-month limit) or was revoked. A new login is required."""

    code = "AUTH_EXPIRED"


class AuthError(SpotikitError):
    code = "AUTH_ERROR"


class InvalidReference(SpotikitError):
    code = "INVALID_REFERENCE"


class InvalidArgument(SpotikitError):
    code = "INVALID_ARGUMENT"


class NotFound(SpotikitError):
    code = "NOT_FOUND"


class Forbidden(SpotikitError):
    code = "FORBIDDEN"


class RateLimited(SpotikitError):
    code = "RATE_LIMITED"


class ApiError(SpotikitError):
    code = "API_ERROR"


class DuplicateName(SpotikitError):
    code = "DUPLICATE_NAME"


class PlanError(SpotikitError):
    code = "PLAN_INVALID"


class SnapshotMismatch(SpotikitError):
    code = "SNAPSHOT_MISMATCH"


class ApplyFailed(SpotikitError):
    code = "APPLY_FAILED"


class VerificationFailed(SpotikitError):
    code = "VERIFICATION_FAILED"
