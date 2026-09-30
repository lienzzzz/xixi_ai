"""Test support: play a frame script through the real loop and collect its records.

Kept inside the package (not in `tests/`) so that both `tests/perception/test_*.py` and the
TypeScript wrapper added to `npm test` can import it without manipulating `sys.path`.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np

from .debounce import DebounceConfig
from .detector import DetectionConfig, NullFaceDetector, PresenceDetector
from .emitter import EventEmitter
from .run import RunConfig, run
from .semantic import SemanticAnalysisHook


@dataclass
class CapturedRun:
    """What a scripted run produced: events, per-frame records, and the summary."""

    events: list[dict] = field(default_factory=list)
    frames: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)
    text: str = ""

    @property
    def states(self) -> list[str]:
        return ["present" if event["payload"]["present"] else "absent" for event in self.events]

    @property
    def present_flags(self) -> list[bool]:
        return [bool(event["payload"]["present"]) for event in self.events]


def run_script(
    frames: Sequence[tuple[np.ndarray, float]],
    *,
    detector: str = "haar",
    present_confirm_frames: int = 15,
    absent_confirm_frames: int = 45,
    release_grace_ms: float = 3000.0,
    face_every_n_frames: int = 10,
    motion_min_ratio: float = 0.005,
    motion_pixel_threshold: int = 6,
    process_width: int = 320,
    model: str | None = None,
    semantic: SemanticAnalysisHook | None = None,
) -> CapturedRun:
    """Run one script through the real capture→detect→debounce→emit path, in-process."""
    buffer = io.StringIO()
    emitter = EventEmitter(stream=buffer)
    cfg = RunConfig(
        source="synthetic",
        detector=detector,
        model=model,
        present_confirm_frames=present_confirm_frames,
        absent_confirm_frames=absent_confirm_frames,
        release_grace_ms=release_grace_ms,
        face_every_n_frames=face_every_n_frames,
        motion_min_ratio=motion_min_ratio,
        motion_pixel_threshold=motion_pixel_threshold,
        process_width=process_width,
    )
    summary = run(cfg, emitter, semantic=semantic, frames=list(frames))
    captured = CapturedRun(summary=summary, text=buffer.getvalue())
    for line in captured.text.splitlines():
        record = json.loads(line)
        if record.get("record") == "event":
            captured.events.append({key: value for key, value in record.items() if key != "record"})
        elif record.get("record") == "frame":
            captured.frames.append(record)
    return captured


def detect_script(
    frames: Sequence[tuple[np.ndarray, float]],
    *,
    detector: str = "haar",
    motion_min_ratio: float = 0.005,
    motion_pixel_threshold: int = 6,
    process_width: int = 320,
    face_every_n_frames: int = 10,
) -> list:
    """Per-frame detector output only (no debounce): for gating/motion assertions."""
    if detector == "none":
        backend = NullFaceDetector()
    elif detector == "haar":
        from .detector import HaarFaceDetector

        backend = HaarFaceDetector()
    else:
        from .detector import YuNetFaceDetector, load_yunet_model_path

        backend = YuNetFaceDetector(load_yunet_model_path(), (640, 480), 0.6)
    engine = PresenceDetector(
        DetectionConfig(
            motion_pixel_threshold=motion_pixel_threshold,
            motion_min_ratio=motion_min_ratio,
            process_width=process_width,
            face_every_n_frames=face_every_n_frames,
            use_face_detector=detector != "none",
        ),
        backend,
    )
    return [engine.detect(frame, timestamp) for frame, timestamp in frames]


def face_backend_available(kind: str) -> bool:
    """Is a face backend usable in this interpreter? (Tests skip, they never silently pass.)"""
    if kind == "haar":
        try:
            from .detector import HaarFaceDetector

            HaarFaceDetector()
            return True
        except Exception:  # noqa: BLE001 - any failure means "not usable here"
            return False
    if kind == "yunet":
        try:
            from .detector import YuNetFaceDetector, load_yunet_model_path

            YuNetFaceDetector(load_yunet_model_path(), (640, 480), 0.6)
            return True
        except Exception:  # noqa: BLE001
            return False
    return False


__all__ = ["CapturedRun", "run_script", "detect_script", "face_backend_available", "DebounceConfig"]
