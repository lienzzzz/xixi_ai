"""Event construction that matches the released `xixi.event.v1` contract.

The authoritative implementation is TypeScript (`packages/contracts`). This module builds
the same envelope in Python and validates it against the **same schema files on disk**, so
a producer written in Python cannot drift from the contract: if
`packages/contracts/schemas/envelope.v1.json` changes shape, the check in this file fails
loudly instead of emitting an event that the event log will reject later.

No new event type is introduced: presence uses the existing `presence.changed` v1 payload
(`{present, source_detail}`). Anything the detector wants to say beyond that goes into the
envelope fields the contract already defines (`source`, `confidence`) — not into new
payload keys, because the payload schema is sealed with `additionalProperties: false`.

Only raw events are written: no model reasoning, no images, no per-frame history.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

EVENT_SCHEMA = "xixi.event.v1"
SCHEMA_VERSION = 1

EVENT_ID_PATTERN = re.compile(r"^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CORRELATION_ID_PATTERN = re.compile(r"^corr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$")


class ContractViolation(RuntimeError):
    """The event we were about to emit does not satisfy the released contract."""


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def schema_path(relative: str) -> Path:
    return repo_root() / "packages" / "contracts" / "schemas" / relative


def _load_schema(relative: str) -> dict:
    path = schema_path(relative)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as cause:  # pragma: no cover - repository layout issue
        raise ContractViolation(f"找不到契约 schema：{path}") from cause


def validate_minimal(schema: dict, value: Any, where: str = "$") -> None:
    """Validate the JSON Schema subset the xixi contracts actually use.

    Deliberately tiny and strict: only the keywords present in the released envelope and
    payload schemas are implemented, and any unexpected keyword raises. That mirrors the
    TypeScript validator's `assertEnforceable` stance — a constraint that exists but is not
    executed is worse than no constraint at all.
    """
    supported = {
        "type",
        "properties",
        "required",
        "additionalProperties",
        "enum",
        "const",
        "items",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "pattern",
        "oneOf",
        "anyOf",
        "$schema",
        "$id",
        "title",
        "description",
        "default",
        "examples",
    }
    for keyword in schema:
        if keyword not in supported:
            raise ContractViolation(f"{where}: schema 用了未实现的 JSON Schema 关键字 '{keyword}'")

    if "const" in schema and value != schema["const"]:
        raise ContractViolation(f"{where}: 期望常量 {schema['const']!r}，实际 {value!r}")

    if "enum" in schema and value not in schema["enum"]:
        raise ContractViolation(f"{where}: {value!r} 不在枚举 {schema['enum']} 中")

    if "oneOf" in schema:
        errors = []
        for candidate in schema["oneOf"]:
            try:
                validate_minimal(candidate, value, where)
                return
            except ContractViolation as cause:
                errors.append(str(cause))
        raise ContractViolation(f"{where}: 不满足 oneOf 的任何一支：{errors}")

    if "anyOf" in schema:
        for candidate in schema["anyOf"]:
            try:
                validate_minimal(candidate, value, where)
                return
            except ContractViolation:
                continue
        raise ContractViolation(f"{where}: 不满足 anyOf 的任何一支")

    declared = schema.get("type")
    if declared is not None:
        types = [declared] if isinstance(declared, str) else list(declared)
        if not _matches_type(types, value):
            raise ContractViolation(f"{where}: 期望类型 {types}，实际 {type(value).__name__} ({value!r:.80})")

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise ContractViolation(f"{where}: 长度 {len(value)} < minLength {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise ContractViolation(f"{where}: 长度 {len(value)} > maxLength {schema['maxLength']}")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise ContractViolation(f"{where}: {value!r} 不匹配 pattern {schema['pattern']!r}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise ContractViolation(f"{where}: {value} < minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise ContractViolation(f"{where}: {value} > maximum {schema['maximum']}")

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                raise ContractViolation(f"{where}: 缺必填字段 '{key}'")
        properties = schema.get("properties", {})
        additional = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                validate_minimal(properties[key], item, f"{where}.{key}")
            elif additional is False:
                raise ContractViolation(f"{where}: 不允许的未知字段 '{key}'")
            elif isinstance(additional, dict):
                validate_minimal(additional, item, f"{where}.{key}")

    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            validate_minimal(schema["items"], item, f"{where}[{index}]")


def _matches_type(types: list[str], value: Any) -> bool:
    for name in types:
        if name == "object" and isinstance(value, dict):
            return True
        if name == "array" and isinstance(value, list):
            return True
        if name == "string" and isinstance(value, str):
            return True
        if name == "boolean" and isinstance(value, bool):
            return True
        if name == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return True
        if name == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
            return True
        if name == "null" and value is None:
            return True
    return False


def local_timestamp(moment: datetime | None = None, offset_minutes: int | None = None) -> str:
    """`YYYY-MM-DDTHH:MM:SS.mmm±HH:MM` with the machine's own offset.

    The contract rejects `Z`; Xixi is a single-machine, single-timezone companion and its
    "local wall clock" is a first-class fact (see docs/design/domain-model.md §2).
    """
    moment = moment or datetime.now(timezone.utc).astimezone()
    if offset_minutes is None:
        offset = moment.utcoffset() or timedelta(0)
    else:
        offset = timedelta(minutes=offset_minutes)
    shifted = moment.astimezone(timezone(offset))
    return shifted.strftime("%Y-%m-%dT%H:%M:%S.") + f"{shifted.microsecond // 1000:03d}" + shifted.strftime("%z")[:3] + ":" + shifted.strftime("%z")[3:]


def new_event_id() -> str:
    return f"evt_{uuid.uuid4()}"


def new_correlation_id() -> str:
    return f"corr_{uuid.uuid4()}"


@dataclass(frozen=True)
class PresenceEventInput:
    """Everything needed to describe one presence transition, and nothing else."""

    present: bool
    confidence: float
    source: str = "perception.laptop_camera"
    room: str | None = None
    actor: str = "father"
    source_detail: str = ""
    timestamp: str | None = None
    event_id: str | None = None
    correlation_id: str | None = None


def build_presence_event(payload: PresenceEventInput) -> dict:
    """Build and validate a `presence.changed` v1 envelope. Raises on any drift."""
    if len(payload.source_detail) > 200:
        raise ContractViolation("source_detail 超过 200 字符（契约上限）")
    event = {
        "schema": EVENT_SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "event_id": payload.event_id or new_event_id(),
        "event_type": "presence.changed",
        "timestamp": payload.timestamp or local_timestamp(),
        "source": payload.source,
        "room": payload.room,
        "actor": payload.actor,
        "confidence": payload.confidence,
        "correlation_id": payload.correlation_id or new_correlation_id(),
        "payload": {"present": payload.present, "source_detail": payload.source_detail or None},
    }
    validate_presence_event(event)
    return event


def validate_presence_event(event: dict) -> None:
    """Check a candidate event against the released envelope + payload schemas on disk."""
    validate_minimal(_load_schema("envelope.v1.json"), event, "$")
    validate_minimal(_load_schema("events/presence.changed.v1.json"), event.get("payload"), "$.payload")
    if event.get("event_type") != "presence.changed":
        raise ContractViolation("event_type 必须是 presence.changed（本模块不产出其它类型）")
    for name, pattern in (("event_id", EVENT_ID_PATTERN), ("correlation_id", CORRELATION_ID_PATTERN)):
        if pattern.match(str(event.get(name))) is None:
            raise ContractViolation(f"{name}={event.get(name)!r} 不符合契约 pattern")
    if TIMESTAMP_PATTERN.match(str(event.get("timestamp"))) is None:
        raise ContractViolation(f"timestamp={event.get('timestamp')!r} 不是本地墙上时间格式")
