"""Where a presence event goes: stdout JSON Lines, and (optionally) the event log.

Two sinks, for two different callers:

  * **stdout, one JSON object per line** — always. The caller decides what to do with the
    events; `scripts/verify-camera-presence.ts` rebuilds each one through `buildEvent()` in
    `packages/contracts` (the authoritative TypeScript contract) and appends it with
    `XixiStore`, so schema ownership stays in one place.
  * **`--db <path> --append`** — the same process writes the event into the log *and* keeps
    the `world_state` projection current, in one SQLite transaction.

The module never creates tables and never migrates: if the database is not an initialized
Xixi store (no `events` table, or no `world_state` table because migration 002 has not run),
the append is skipped with an explicit reason instead of half-writing a schema — migrations
belong to `packages/domain`. A partial success (event in the log, projection not updated)
is exactly the state §5.3 exists to prevent, so the two writes share a transaction and any
SQLite error rolls both back.

Only `presence.changed` events are written. Per-frame evidence (motion, face counts,
timings) is printed as `frame` records for measurement, and is never persisted: the event
log holds facts, not sensor streams.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .contracts import ContractViolation, build_presence_event, validate_presence_event

#: WorldState key for "is somebody at home"; must match `PRESENCE_KEY` in packages/domain.
PRESENCE_KEY = "presence.home"

#: Kept in step with `DEFAULT_PRESENCE_TTL_SECONDS` in packages/domain/src/store.ts.
DEFAULT_TTL_SECONDS = 60

#: Column list must match `events` in packages/domain/src/migrations/001_initial.sql.
EVENTS_INSERT = (
    "INSERT INTO events (event_id, event_type, schema_version, timestamp, source, room, actor, "
    "confidence, correlation_id, session_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


@dataclass
class EmitStats:
    events_written: int = 0
    appended_to_db: int = 0
    db_skipped_reason: str | None = None
    contract_errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "events_written": self.events_written,
            "appended_to_db": self.appended_to_db,
            "db_skipped_reason": self.db_skipped_reason,
            "contract_errors": self.contract_errors,
        }


class EventEmitter:
    """Validate, print, and optionally append presence events."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        append: bool = False,
        stream=None,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
    ) -> None:
        self.stats = EmitStats()
        self._stream = stream or sys.stdout
        self._connection: sqlite3.Connection | None = None
        self.ttl_seconds = ttl_seconds
        if append:
            self._open_db(Path(db_path) if db_path else None)

    def _open_db(self, db_path: Path | None) -> None:
        if db_path is None:
            self.stats.db_skipped_reason = "--append 需要同时给 --db <path>"
            return
        if not db_path.is_file():
            self.stats.db_skipped_reason = f"{db_path} 不存在（先运行一次 XixiStore/verify 脚本建库）"
            return
        connection = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            row = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
            ).fetchone()
            if row is None:
                self.stats.db_skipped_reason = f"{db_path} 里没有 events 表：它不是已初始化的西西库（迁移由 packages/domain 负责）"
                connection.close()
                return
            columns = {info[1] for info in connection.execute("PRAGMA table_info(events)")}
            required = {
                "event_id",
                "event_type",
                "schema_version",
                "timestamp",
                "source",
                "room",
                "actor",
                "confidence",
                "correlation_id",
                "session_id",
                "payload_json",
            }
            missing = required - columns
            if missing:
                self.stats.db_skipped_reason = f"{db_path} 的 events 表缺少列 {sorted(missing)}：schema 版本不匹配"
                connection.close()
                return
            # The `events` table is not the only thing this module writes: it also keeps the
            # WorldState-lite projection current. If that table is missing the store is older
            # than the code, and a half-write (event in the log, projection never updated) is
            # worse than not writing at all — report it instead.
            projection = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='world_state'"
            ).fetchone()
            if projection is None:
                self.stats.db_skipped_reason = (
                    f"{db_path} 里没有 world_state 表（迁移 002 还没跑）："
                    "先用 XixiStore/verify 脚本打开一次该库，再加 --append"
                )
                connection.close()
                return
        except sqlite3.DatabaseError as cause:
            self.stats.db_skipped_reason = f"打开 {db_path} 失败：{cause}"
            connection.close()
            return
        self._connection = connection

    def emit(self, event: dict) -> None:
        """Validate against the released contract, then write to stdout and (if asked) the log."""
        try:
            validate_presence_event(event)
        except ContractViolation as cause:
            self.stats.contract_errors.append(str(cause))
            raise
        self._write_line({"record": "event", **event})
        self.stats.events_written += 1

        if self._connection is None:
            return
        payload = event["payload"]
        try:
            self._connection.execute(
                EVENTS_INSERT,
                (
                    event["event_id"],
                    event["event_type"],
                    event["schema_version"],
                    event["timestamp"],
                    event["source"],
                    event["room"],
                    event["actor"],
                    event["confidence"],
                    event["correlation_id"],
                    None,  # session_id: presence is not part of a conversation session
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            self._project_presence(event)
            self._connection.commit()
        except sqlite3.Error as cause:
            # Never leave a half-written store behind (event in the log, projection stale).
            self._connection.rollback()
            self.stats.db_skipped_reason = f"写库失败，已回滚：{cause}"
            return
        self.stats.appended_to_db += 1

    def _project_presence(self, event: dict) -> None:
        """Keep `world_state` in step with the event that was just appended.

        Same transaction as the event insert: the projection is derived data, and a reader
        must never see "an arrival event exists but the current state still says absent".
        `value` is stored as text ('present'/'absent') because world state values are not
        all booleans; the reader maps it back.
        """
        present = bool(event["payload"].get("present"))
        self._connection.execute(
            "INSERT INTO world_state (key, schema_version, value, source, updated_at, confidence, ttl_seconds) "
            "VALUES (?, 1, ?, ?, ?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, "
            "updated_at = excluded.updated_at, confidence = excluded.confidence, ttl_seconds = excluded.ttl_seconds",
            (
                PRESENCE_KEY,
                "present" if present else "absent",
                event["source"],
                event["timestamp"],
                event["confidence"],
                self.ttl_seconds,
            ),
        )

    def emit_presence(self, *, present: bool, confidence: float, source_detail: str, **kwargs: Any) -> dict:
        event = build_presence_event(
            _presence_input(present=present, confidence=confidence, source_detail=source_detail, **kwargs)
        )
        self.emit(event)
        return event

    def frame(self, payload: dict) -> None:
        """Per-frame evidence line. Measurement only — never written to the database."""
        self._write_line({"record": "frame", **payload})

    def summary(self, payload: dict) -> None:
        self._write_line({"record": "summary", **payload, "emit": self.stats.to_dict()})

    def _write_line(self, payload: dict) -> None:
        self._stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._stream.flush()

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None


def _presence_input(**kwargs: Any):
    from .contracts import PresenceEventInput

    return PresenceEventInput(**kwargs)


def frame_record(signals, decision) -> dict:
    """One frame's evidence plus the debounce verdict, as a flat JSON-friendly dict."""
    frame = asdict(signals) if hasattr(signals, "__dataclass_fields__") else dict(signals)
    return {
        **frame,
        "state": decision.state,
        "state_changed": decision.changed,
        "decision_reason": decision.reason,
        "confidence": round(decision.confidence, 3),
    }
