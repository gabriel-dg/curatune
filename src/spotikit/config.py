"""Settings loaded from the environment (.env at the project root) and filesystem paths."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from .errors import ConfigError

REDIRECT_HOST = "127.0.0.1"
REDIRECT_PATH = "/callback"
DEFAULT_REDIRECT_PORT = 8888
SCOPES = ("playlist-read-private", "playlist-modify-public", "playlist-modify-private")


def _project_root() -> Path:
    override = os.environ.get("SPOTIKIT_PROJECT_DIR")
    if override:
        return Path(override).expanduser().resolve()
    # Editable install (src layout): src/spotikit/config.py -> project root is two levels up from src.
    candidate = Path(__file__).resolve().parents[2]
    if (candidate / "pyproject.toml").exists():
        return candidate
    return Path.cwd()


def _default_token_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "spotikit"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "spotikit"


@dataclass(frozen=True)
class Settings:
    project_root: Path
    client_id: str | None
    redirect_port: int
    market: str | None
    token_dir: Path

    @property
    def redirect_uri(self) -> str:
        return redirect_uri_for(self.redirect_port)

    @property
    def token_path(self) -> Path:
        return self.token_dir / "token.json"

    @property
    def plans_dir(self) -> Path:
        return self.project_root / "plans"

    @property
    def data_dir(self) -> Path:
        return self.project_root / "data"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def write_log_path(self) -> Path:
        return self.data_dir / "write_log.json"

    def require_client_id(self) -> str:
        if not self.client_id:
            raise ConfigError(
                "SPOTIFY_CLIENT_ID is not set. Add it to .env at the project root.",
                details={"env_file": str(self.project_root / ".env")},
            )
        return self.client_id


def redirect_uri_for(port: int) -> str:
    return f"http://{REDIRECT_HOST}:{port}{REDIRECT_PATH}"


def _parse_port(raw: str | None) -> int:
    if raw is None or raw.strip() == "":
        return DEFAULT_REDIRECT_PORT
    try:
        port = int(raw)
    except ValueError:
        raise ConfigError("SPOTIFY_REDIRECT_PORT must be an integer.", details={"value": raw}) from None
    if not 1 <= port <= 65535:
        raise ConfigError("SPOTIFY_REDIRECT_PORT is out of range.", details={"value": port})
    return port


def load_settings() -> Settings:
    root = _project_root()
    load_dotenv(root / ".env", override=False)
    token_dir_raw = os.environ.get("SPOTIKIT_TOKEN_DIR")
    token_dir = Path(token_dir_raw).expanduser().resolve() if token_dir_raw else _default_token_dir()
    if token_dir.resolve().is_relative_to(root):
        raise ConfigError(
            "The token directory must be outside the project repository.",
            details={"token_dir": str(token_dir), "project_root": str(root)},
        )
    market = (os.environ.get("SPOTIKIT_MARKET") or "").strip().upper() or None
    return Settings(
        project_root=root,
        client_id=(os.environ.get("SPOTIFY_CLIENT_ID") or "").strip() or None,
        redirect_port=_parse_port(os.environ.get("SPOTIFY_REDIRECT_PORT")),
        market=market,
        token_dir=token_dir,
    )
