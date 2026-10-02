"""Settings loaded from the environment (and `.env` files) and the filesystem paths curatune uses.

Where things live:
- the **config dir** (`%LOCALAPPDATA%\\curatune` or `~/.config/curatune`; `CURATUNE_TOKEN_DIR` overrides)
  holds the token and may hold a `.env`;
- the **data dir** (`%LOCALAPPDATA%\\curatune\\data` or `$XDG_DATA_HOME/curatune`, default
  `~/.local/share/curatune`; `CURATUNE_DATA_DIR` overrides) holds plans, backups, the write log, recording
  dates, and the MCP client records. The CLI and the MCP server share it;
- a **source checkout** (`CURATUNE_PROJECT_DIR`, or the repository this package is installed from in
  editable mode) is optional. When there is one, its `.env` is read too, and neither the token nor the data
  may live inside it: the repository is meant to be published.

Process environment wins over the checkout's `.env`, which wins over the config dir's.
"""

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


def _project_root() -> Path | None:
    """The source checkout, if curatune runs from one. Never the current directory."""
    override = os.environ.get("CURATUNE_PROJECT_DIR")
    if override:
        return Path(override).expanduser().resolve()
    # Editable install (src layout): src/curatune/config.py -> project root is two levels up from src.
    candidate = Path(__file__).resolve().parents[2]
    if (candidate / "pyproject.toml").exists() and (candidate / "src" / "curatune").is_dir():
        return candidate
    return None


def _default_token_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "curatune"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "curatune"


def _default_data_dir() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "curatune" / "data"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "curatune"


def _path_from_env(name: str) -> Path | None:
    raw = (os.environ.get(name) or "").strip()
    return Path(os.path.expandvars(raw)).expanduser().resolve() if raw else None


@dataclass(frozen=True)
class Settings:
    project_root: Path | None
    client_id: str | None
    redirect_port: int
    market: str | None
    token_dir: Path
    data_dir: Path
    # True when CURATUNE_DATA_DIR chose the data dir. Then data left in a checkout's data/ and plans/ only
    # warns; with the default dir it blocks until migrated (datadir.py).
    data_dir_explicit: bool = True

    @property
    def redirect_uri(self) -> str:
        return redirect_uri_for(self.redirect_port)

    @property
    def token_path(self) -> Path:
        return self.token_dir / "token.json"

    @property
    def plans_dir(self) -> Path:
        return self.data_dir / "plans"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def write_log_path(self) -> Path:
        return self.data_dir / "write_log.json"

    @property
    def recordings_path(self) -> Path:
        return self.data_dir / "recordings.json"

    @property
    def env_files(self) -> list[Path]:
        """Where `.env` is read from, in priority order."""
        return ([self.project_root / ".env"] if self.project_root else []) + [self.token_dir / ".env"]

    def require_client_id(self) -> str:
        if not self.client_id:
            raise ConfigError(
                "SPOTIFY_CLIENT_ID is not set. Add it to curatune's .env (in the repository, or in the config "
                "directory next to the token).",
                details={"env_files": [str(p) for p in self.env_files]},
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


def _outside_checkout(path: Path, root: Path | None, what: str, setting: str) -> None:
    if root is not None and path.resolve().is_relative_to(root):
        raise ConfigError(
            f"The {what} must be outside the project repository (it is meant to be published).",
            details={setting: str(path), "project_root": str(root)},
        )


def load_settings() -> Settings:
    root = _project_root()
    if root is not None:
        load_dotenv(root / ".env", override=False)
    token_dir = _path_from_env("CURATUNE_TOKEN_DIR") or _default_token_dir()
    load_dotenv(token_dir / ".env", override=False)  # the config dir's .env: for installs without a checkout
    explicit_data_dir = _path_from_env("CURATUNE_DATA_DIR")
    data_dir = explicit_data_dir or _default_data_dir()
    _outside_checkout(token_dir, root, "token directory", "token_dir")
    _outside_checkout(data_dir, root, "data directory", "data_dir")
    market = (os.environ.get("CURATUNE_MARKET") or "").strip().upper() or None
    return Settings(
        project_root=root,
        client_id=(os.environ.get("SPOTIFY_CLIENT_ID") or "").strip() or None,
        redirect_port=_parse_port(os.environ.get("SPOTIFY_REDIRECT_PORT")),
        market=market,
        token_dir=token_dir,
        data_dir=data_dir,
        data_dir_explicit=explicit_data_dir is not None,
    )
