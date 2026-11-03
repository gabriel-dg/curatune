"""Typed exceptions. Each carries a stable `code` that the CLI emits in its JSON error envelope."""

from __future__ import annotations

from typing import Any


class CuratuneError(Exception):
    code = "ERROR"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None, code: str | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}
        if code:
            self.code = code

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class ConfigError(CuratuneError):
    code = "CONFIG_ERROR"


class AuthRequired(CuratuneError):
    code = "AUTH_REQUIRED"


class AuthExpired(CuratuneError):
    """The refresh token expired (6-month limit) or was revoked. A new login is required."""

    code = "AUTH_EXPIRED"


class AuthError(CuratuneError):
    code = "AUTH_ERROR"


class InvalidReference(CuratuneError):
    code = "INVALID_REFERENCE"


class InvalidArgument(CuratuneError):
    code = "INVALID_ARGUMENT"


class NotFound(CuratuneError):
    code = "NOT_FOUND"


class Forbidden(CuratuneError):
    code = "FORBIDDEN"


class RateLimited(CuratuneError):
    code = "RATE_LIMITED"


class ApiQuotaExceeded(CuratuneError):
    """The quota of the app's developer account (shared by all its Development Mode apps) is used up."""

    code = "API_QUOTA_EXCEEDED"


class ApiError(CuratuneError):
    code = "API_ERROR"


class DuplicateName(CuratuneError):
    code = "DUPLICATE_NAME"


class PlanError(CuratuneError):
    code = "PLAN_INVALID"


class SnapshotMismatch(CuratuneError):
    code = "SNAPSHOT_MISMATCH"


class ApplyFailed(CuratuneError):
    code = "APPLY_FAILED"


class VerificationFailed(CuratuneError):
    code = "VERIFICATION_FAILED"


class LegacyDataNotMigrated(CuratuneError):
    code = "LEGACY_DATA_NOT_MIGRATED"


class MigrationError(CuratuneError):
    code = "MIGRATION_FAILED"
