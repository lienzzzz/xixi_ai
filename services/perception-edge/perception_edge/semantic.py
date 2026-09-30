"""The seam for on-demand semantic analysis — interface and comments only, no call.

Continuous video never leaves this machine: the only thing that could ever go out is a
*single still frame*, and only when something explicitly asks for an interpretation ("what
is he doing?", "is he asleep?"). That path does not exist yet, and this file is where it
will be built — deliberately unimplemented for M6 so that no code path can upload an image
by accident.

Rules any future implementation must obey (铁律 6, §23, docs/design/security-and-privacy.md):

  1. it is **user-triggered or rule-triggered, never periodic** — no "send a frame every
     N seconds";
  2. it sends **one frame**, at reduced resolution and JPEG quality, never a video stream
     and never audio;
  3. the caller must be able to answer "what exactly left the machine, when, and why" —
     an audit record goes into the event log before the call, not after;
  4. the result is a *derived* fact with a timestamp and a TTL, never a stored recording;
  5. it must be switchable off in configuration, and off by default.

`SemanticAnalysisHook` therefore has no transport, and `capture_snapshot` raises instead of
quietly returning pixel data; the placeholder assertions in the tests pin that down.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


class SemanticAnalysisNotImplemented(NotImplementedError):
    """Raised by the stub: there is no multimodal call in this build (M6 scope)."""


@dataclass
class SemanticAnalysisHook:
    """Placeholder for §23's "on-demand semantic analysis". Does nothing, calls nothing."""

    enabled: bool = False
    calls_attempted: int = 0
    notes: list[str] = field(default_factory=list)

    def on_presence_changed(self, present: bool, frame: np.ndarray) -> None:
        """Called when presence flips. MUST stay a no-op: it is not an analysis trigger."""
        self.calls_attempted += 1
        if self.enabled:  # pragma: no cover - guarded, and never enabled in tests
            raise SemanticAnalysisNotImplemented(
                "按需语义分析未实现（M6 只做本地在场判定）；实现前不允许把帧交给任何模型。"
            )
        self.notes.append(f"presence_changed present={present} 未做任何语义分析（无上传）")

    def capture_snapshot(self, frame: np.ndarray) -> bytes:
        """Interface only. A future implementation returns one reduced JPEG (+ audit record)."""
        raise SemanticAnalysisNotImplemented(
            "截图外发通道未实现：本任务只留接口，不实现调用（连续视频与截图都不离开本机）。"
        )

    def status(self) -> dict[str, Any]:
        return {
            "implemented": False,
            "enabled": self.enabled,
            "saw_presence_changes": self.calls_attempted,
            "uploads": 0,
            "note": "接口已留（capture_snapshot / on_presence_changed），调用未实现，默认关闭",
        }


def describe_privacy_boundary() -> dict[str, Any]:
    """Machine-readable statement of what this process did with image data."""
    return {
        "video_uploaded": False,
        "stills_uploaded": 0,
        "frames_written_to_disk": 0,
        "network_clients": 0,
        "local_only": True,
        "note": "抓帧只在内存里用于本地检测；事件日志只保存 presence.changed 事实，不保存画面。",
    }
