"""Frame capture from the default camera, plus deterministic offline frame sources.

Field facts this file encodes (measured on this machine, see
`docs/recon/field-test-environment-2026-09-30.md` §3):
  * Only the DSHOW backend opens the Chicony USB2.0 Camera; MSMF fails instantly.
  * 640x480 read() costs ~33.4 ms (about 30 fps); 1920x1080 requests are capped to 1280x720.
  * The driver does not report CAP_PROP_FPS (-1.0), so frame rate is measured, never trusted.

Frames are never written to disk by this module: a frame lives only in memory for the
duration of the detection call. Recording video is out of scope for M6 and deliberately
not implemented.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Iterator, Protocol, Sequence

import cv2
import numpy as np

#: Backend for the real device. Anything else (MSMF / CAP_ANY) either fails or silently
#: falls back, so the choice is explicit rather than left to OpenCV.
DEFAULT_BACKEND = int(cv2.CAP_DSHOW)


@dataclass(frozen=True)
class CameraConfig:
    """How to open and read the default camera."""

    index: int = 0
    width: int = 640
    height: int = 480
    backend: int = DEFAULT_BACKEND
    warmup_frames: int = 1
    open_timeout_s: float = 5.0


@dataclass
class FrameStats:
    """Measured, not assumed: what the device actually gave us."""

    open_ms: float = 0.0
    first_frame_ms: float = 0.0
    read_ms: list[float] = field(default_factory=list)
    width: int = 0
    height: int = 0

    def summary(self) -> dict:
        reads = sorted(self.read_ms)
        count = len(reads)
        if count == 0:
            return {
                "open_ms": round(self.open_ms, 1),
                "first_frame_ms": round(self.first_frame_ms, 1),
                "frames": 0,
                "width": self.width,
                "height": self.height,
            }

        def percentile(fraction: float) -> float:
            index = min(count - 1, max(0, int(round(fraction * (count - 1)))))
            return reads[index]

        return {
            "open_ms": round(self.open_ms, 1),
            "first_frame_ms": round(self.first_frame_ms, 1),
            "frames": count,
            "width": self.width,
            "height": self.height,
            "read_ms_mean": round(sum(reads) / count, 1),
            "read_ms_p50": round(percentile(0.5), 1),
            "read_ms_p95": round(percentile(0.95), 1),
            "read_ms_max": round(reads[-1], 1),
            "fps_measured": round(1000.0 / (sum(reads) / count), 1) if sum(reads) > 0 else 0.0,
        }


class CameraUnavailable(RuntimeError):
    """Raised when no usable camera exists, or another process holds it.

    The message is written to be shown to a human: the caller is expected to print it
    verbatim instead of a stack trace.
    """


class FrameSource(Protocol):
    """Anything that can yield (frame_bgr, timestamp_ms) — camera or synthetic."""

    def frames(self) -> Iterator[tuple[np.ndarray, float]]: ...

    def close(self) -> None: ...


class FrameGrabber:
    """A real camera, opened with an explicit backend and measured on the way in."""

    def __init__(self, config: CameraConfig | None = None) -> None:
        self.config = config or CameraConfig()
        self.stats = FrameStats()
        self._capture: cv2.VideoCapture | None = None

    def open(self) -> None:
        started = time.perf_counter()
        capture = cv2.VideoCapture(self.config.index, self.config.backend)
        # Property setting is best-effort: the driver may cap the resolution, so the
        # authoritative size is read back below rather than assumed from the request.
        if self.config.width > 0:
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, float(self.config.width))
        if self.config.height > 0:
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, float(self.config.height))

        deadline = started + self.config.open_timeout_s
        while not capture.isOpened() and time.perf_counter() < deadline:
            time.sleep(0.05)

        if not capture.isOpened():
            capture.release()
            raise CameraUnavailable(
                f"打不开摄像头 index={self.config.index} backend=CAP_DSHOW："
                "设备不存在、被别的程序占用，或 Windows 隐私设置里禁止了摄像头（设置 → 隐私和安全性 → 相机）。"
            )

        frame = None
        first_started = time.perf_counter()
        for _ in range(max(1, self.config.warmup_frames)):
            ok, frame = capture.read()
            if not ok:
                frame = None
        if frame is None:
            capture.release()
            raise CameraUnavailable(
                "摄像头已打开，但读不到第一帧：设备被占用或驱动异常（先关掉其它使用摄像头的程序，再重试）。"
            )

        self.stats.open_ms = (first_started - started) * 1000.0
        self.stats.first_frame_ms = (time.perf_counter() - first_started) * 1000.0
        self.stats.height, self.stats.width = frame.shape[:2]
        self._capture = capture

    def frames(self) -> Iterator[tuple[np.ndarray, float]]:
        if self._capture is None:
            raise CameraUnavailable("FrameGrabber.open() 还没调用")
        while True:
            started = time.perf_counter()
            ok, frame = self._capture.read()
            elapsed = (time.perf_counter() - started) * 1000.0
            if not ok or frame is None:
                raise CameraUnavailable(
                    "摄像头读帧失败：设备被拔出或被其它进程抢占（连续视频不上云，本进程只重试一次就退出）。"
                )
            self.stats.read_ms.append(elapsed)
            self.stats.height, self.stats.width = frame.shape[:2]
            yield frame, time.time() * 1000.0

    def close(self) -> None:
        if self._capture is not None:
            self._capture.release()
            self._capture = None


class SyntheticFrameSource:
    """Deterministic frame source for offline tests and demos: no camera needed.

    Each script entry is (frame, timestamp_ms). The same script must always produce the
    same decisions, so nothing here depends on wall-clock time or randomness.
    """

    def __init__(self, frames: Sequence[tuple[np.ndarray, float]]) -> None:
        self._frames = list(frames)
        self.stats = FrameStats()

    def frames(self) -> Iterator[tuple[np.ndarray, float]]:
        for frame, timestamp_ms in self._frames:
            self.stats.read_ms.append(0.0)
            self.stats.height, self.stats.width = frame.shape[:2]
            yield frame, timestamp_ms

    def close(self) -> None:
        return None
