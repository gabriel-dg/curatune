"""Typed shapes of the MCP tools: nested inputs, and every tool's structured output.

Outputs are strict (`extra="forbid"`): a key a view forgot to convert, such as a 0-based `position`,
fails validation instead of reaching the model. Warnings keep their extra fields (codes vary), and the
numbering tests check those.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Inputs ---------------------------------------------------------------------------------------


class SearchSpec(_In):
    """One search of a `search_many` batch."""

    id: str | None = Field(None, description="Your label for this search, echoed in its result.")
    query: str | None = Field(None, description="Free text.")
    track: str | None = Field(None, description="Track title filter.")
    artist: str | None = Field(None, description="Artist filter.")
    album: str | None = Field(None, description="Album filter.")
    year: str | None = Field(None, description="YYYY or YYYY-YYYY: the edition's release year, not the recording year.")
    limit: int = Field(5, ge=1, le=10, description="Results for this search (1-10).")
    offset: int = Field(0, ge=0, description="Results to skip, for the next page.")


class RecordingEntry(_In):
    """A researched recording date for one track."""

    uri: str = Field(description="Track URI (spotify:track:…), ID, or open.spotify.com URL.")
    recorded: str = Field(description="Recording date: YYYY, YYYY-MM, or YYYY-MM-DD.")
    confidence: Literal["high", "medium", "low"] = Field(description="How sure the date is.")
    source: str = Field(min_length=1, description="Where the date comes from (a discography, liner notes, …).")
    note: str | None = Field(None, description="Optional note, e.g. 'master take'.")
    name: str | None = Field(None, description="Optional track title, for reference.")
    artists: list[str] | None = Field(None, description="Optional artist names, for reference.")
    isrc: str | None = Field(None, description="Optional ISRC: also matches the same recording on another edition.")


# --- Shared output pieces -------------------------------------------------------------------------


class ResultWarning(_Out):
    model_config = ConfigDict(extra="allow")

    code: str
    message: str


class ErrorInfo(_Out):
    code: str
    message: str
    details: dict


class BriefTrack(_Out):
    number: int | None = None  # playlist items only
    uri: str | None
    name: str | None
    artists: list[str | None]
    album: str | None
    released: str | None
    duration: str | None
    isrc: str | None
    playable: bool | None


class Artist(_Out):
    name: str | None
    uri: str | None


class Album(_Out):
    name: str | None
    uri: str | None
    album_type: str | None
    release_date: str | None
    release_date_precision: str | None
    artists: list[Artist]


class Track(_Out):
    number: int | None = None  # playlist items only
    uri: str | None
    id: str | None
    type: str | None
    name: str | None
    artists: list[Artist]
    album: Album | None
    duration_ms: int | None
    duration: str | None
    disc_number: int | None
    track_number: int | None
    isrc: str | None
    explicit: bool | None
    is_local: bool
    is_playable: bool | None
    url: str | None
    added_at: str | None = None  # playlist items only


class PlaylistSummary(_Out):
    id: str
    name: str | None
    owner_name: str | None
    owned: bool
    collaborative: bool | None
    public: bool | None
    item_count: int | None
    url: str | None


class PlaylistInfo(PlaylistSummary):
    description: str | None


# --- Tool outputs ---------------------------------------------------------------------------------


class AuthStatus(_Out):
    authorized: bool
    reason: Literal["CONFIG_ERROR", "AUTH_REQUIRED", "AUTH_EXPIRED", "MISSING_SCOPES"] | None = None
    next_step: str | None = None


class PlaylistsList(_Out):
    count: int
    playlists: list[PlaylistSummary]
    warnings: list[ResultWarning]


class PlaylistShow(_Out):
    playlist: PlaylistInfo
    items: list[BriefTrack | Track]
    total: int = Field(description="Items in the playlist.")
    start: int = Field(description="Number of the first item returned.")
    next_start: int | None = Field(description="Pass as `start` for the next page; null when done.")
    warnings: list[ResultWarning]


class SearchResult(_Out):
    query: str
    total: int | None
    offset: int
    limit: int
    next_offset: int | None
    results: list[BriefTrack]
    warnings: list[ResultWarning]


class SearchOutcome(_Out):
    id: str
    ok: bool
    query: str | None = None
    total: int | None = None
    next_offset: int | None = None
    results: list[BriefTrack] | None = None
    warnings: list[ResultWarning] | None = None
    error: ErrorInfo | None = None


class SearchMany(_Out):
    count: int
    failed: int
    searches: list[SearchOutcome]


class TrackShow(_Out):
    track: Track


class AlbumInfo(_Out):
    id: str | None
    uri: str | None
    name: str | None
    album_type: str | None
    release_date: str | None
    artists: list[str | None]
    total_tracks: int | None
    url: str | None


class AlbumTracks(_Out):
    album: AlbumInfo
    tracks: list[BriefTrack | Track]


class PlaylistRef(_Out):
    id: str
    name: str | None


class RecordingItem(_Out):
    number: int
    uri: str | None
    name: str | None
    artists: list[str | None]
    recorded: str | None
    confidence: str | None
    source: str | None


class MissingRecording(_Out):
    number: int
    uri: str | None
    name: str | None


class RecordingsShow(_Out):
    playlist: PlaylistRef
    items: list[RecordingItem]
    missing: list[MissingRecording]
    chronological: bool
    warnings: list[ResultWarning]


class RecordingsSet(_Out):
    created: int
    skipped: list[str] = Field(description="Tracks that already had a stored date, left unchanged.")
    total: int


class RecordingsUpdate(_Out):
    created: int
    updated: int
    total: int


class CreatedPlaylist(_Out):
    id: str
    name: str | None
    url: str | None
    public: bool | None


class PlaylistCreate(_Out):
    playlist: CreatedPlaylist
    warnings: list[ResultWarning]


class AddedTrack(_Out):
    number: int
    uri: str
    name: str | None
    artists: list[str | None]


class SkippedTrack(_Out):
    uri: str
    reason: str


class PlaylistAdd(_Out):
    playlist_id: str
    added: list[AddedTrack]
    skipped: list[SkippedTrack]
    item_count: int
    verified: bool
    warnings: list[ResultWarning]
