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
    #: How long `open()` may keep skipping blank frames while hunting for a usable first frame
    #: (t99). Must stay small: it is spent on top of `open_timeout_s` in the failure path.
    blank_frame_timeout_s: float = 1.5
    #: t106: when True (the default), a first frame that is still *blank* after the skip window is a
    #: failure — the camera never actually produced a picture, and accepting it would let the
    #: detector report "nobody is present" from frames that carry no information at all.
    #: The diagnostic (`--probe-frames`) sets this False because observing blank frames is exactly
    #: what it is for.
    require_usable_first_frame: bool = True


#: A frame is treated as *blank* (the driver handed us a constant buffer) only when both hold: the
#: brightest pixel is at or below `BLANK_MAX_LUMA` **and** the spread is below `BLANK_MAX_STD`.
#:
#: Where the numbers come from (measured: `data/recon/t99-formats.json`, `t99-first-frame.json`):
#:   * a real picture delivered first in a session: max 84, mean 14-31, std 13.4, 77 grey levels;
#:   * the blank frames this driver emits afterwards: max 0-1, std exactly 0.00;
#:   * MJPG keeps "streaming" but flat at mean 1.0 / max 1, so `max <= 4` covers the observed cases
#:     with margin, while a dark-but-real frame (covered lens, dark room) has noise and stays far
#:     above the bound.
#:
#: The upper bound is a **chosen** cutoff, and its failure mode is a false negative: a driver that
#: returns a constant *above* 4 (say a flat 5) would be taken for a picture, the detector would run
#: on it and report `present=false`. Two things keep that acceptable:
#:   * the second condition means only *exactly constant* frames are blank (real sensor noise is
#:     never constant), so raising the bound does not admit noise — it only reclassifies flat
#:     buffers;
#:   * a false negative is observable rather than silent: `--probe-frames` prints max/std per frame,
#:     and the acceptance output carries `movement_evidence` (all-zero motion), so a stream flat at 5
#:     can still be caught by a human. If it ever happens, raise `BLANK_MAX_LUMA` — it is a tunable,
#:     not a law of nature.
BLANK_MAX_LUMA = 4
BLANK_MAX_STD = 0.05


def is_blank_frame(frame: np.ndarray) -> bool:
    """True when the frame looks like a constant buffer rather than a dim picture.

    Used to *diagnose and skip*, never to judge "is anyone there": a genuinely dark room produces a
    usable, noisy frame that this predicate deliberately accepts.
    """
    if frame is None or frame.size == 0:
        return True
    grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    return bool(int(grey.max()) <= BLANK_MAX_LUMA and float(grey.std()) < BLANK_MAX_STD)


def frame_brightness(frame: np.ndarray) -> dict:
    """Per-frame brightness evidence: the numbers a human needs to judge a black picture."""
    grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    return {
        "mean": round(float(grey.mean()), 2),
        "min": int(grey.min()),
        "max": int(grey.max()),
        "std": round(float(grey.std()), 2),
        "blank": is_blank_frame(frame),
    }


@dataclass
class FrameStats:
    """Measured, not assumed: what the device actually gave us."""

    open_ms: float = 0.0
    first_frame_ms: float = 0.0
    read_ms: list[float] = field(default_factory=list)
    width: int = 0
    height: int = 0
    #: Blank frames skipped while looking for the first usable frame (t99 diagnosis).
    blank_frames_skipped: int = 0

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
                "blank_frames_skipped": self.blank_frames_skipped,
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
            "blank_frames_skipped": self.blank_frames_skipped,
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
        # t99/t106: a *blank* frame is one the driver filled with a constant value. Measured on this
        # machine: the first frame of a session is a normal picture and every frame after it arrives
        # as an exact zero (YUY2) or a flat 1.0 (MJPG); a covered lens or a truly dark room instead
        # yields noise (std > 1, max > 5). So "constant and almost black" is a delivery fault, not a
        # dark room.
        #
        # The skip window is a *time budget for finding a usable frame*, not a deadline after which a
        # blank frame becomes acceptable: once it expires the next readable frame is the result, and
        # if that one is still blank we raise (see below). Accepting it would mean the detector runs
        # on frames with no picture and reports `present=false`, which is indistinguishable from a
        # genuinely empty room — the exact confusion t99 was about.
        blank_frames = 0
        warmup_deadline = first_started + max(0.0, self.config.blank_frame_timeout_s)
        attempts = 0
        while True:
            attempts += 1
            ok, candidate = capture.read()
            if not ok:
                candidate = None
            if candidate is None:
                if attempts >= max(1, self.config.warmup_frames) or time.perf_counter() >= warmup_deadline:
                    break
                continue
            if self.config.require_usable_first_frame and is_blank_frame(candidate):
                blank_frames += 1
                if time.perf_counter() >= warmup_deadline:
                    break  # no usable frame within the budget; `frame` stays None -> raise
                continue
            frame = candidate
            break
        if frame is None or (self.config.require_usable_first_frame and is_blank_frame(frame)):
            capture.release()
            raise CameraUnavailable(
                "摄像头已打开，但拿不到可用的画面：驱动连续回传空帧（全 0 或单色）。"
                "先用 python -m perception_edge.run --probe-frames 10 看逐帧亮度；"
                "如果确认全是空帧，就按「别的程序占用 / 拔插或重启 / 镜头遮挡」依次排查。"
            )

        self.stats.open_ms = (first_started - started) * 1000.0
        self.stats.first_frame_ms = (time.perf_counter() - first_started) * 1000.0
        self.stats.height, self.stats.width = frame.shape[:2]
        self.stats.blank_frames_skipped = blank_frames
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
