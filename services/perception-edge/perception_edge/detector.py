"""Local "is a person there?" detection: cheap frame differencing + a face detector.

Detector choice is a measured decision, not a preference — the numbers, the alternatives
and the reasons are in `docs/recon/camera-detector-choice-2026-09-30.md`. In short:

  * frame differencing (about 1.2 ms per pair at 320x240) is the cheap gate that fires on
    any movement, including a person who is not looking at the camera;
  * a face detector is the confirmation that survives an empty room, because a static
    scene produces no motion at all;
  * HOG person detection is *not* used: it reported 0-2 people in an empty room depending
    on parameters, and cost 107.6 ms per frame (measured by the T0 recon).

Nothing here downloads anything at run time: the YuNet model is read from a path that the
caller supplies, and every missing piece is reported as a typed error instead of a
guess. No network client exists in this package.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

#: Static scene noise floor measured on this machine: 0.8 grey levels mean absolute
#: difference, p99 = 5.0. A per-pixel threshold must sit above that or every sensor
#: flicker counts as movement.
NOISE_FLOOR_GREY_LEVELS = 0.8

#: YuNet's own detection threshold. Its published default is 0.9; 0.6 keeps recall on a
#: dim, low-resolution webcam frame while NMS + the debounce stage absorb the extra
#: candidates. Documented in the recon report.
DEFAULT_FACE_SCORE_THRESHOLD = 0.6


class FaceDetector(Protocol):
    """Minimal, uniform face-detector surface so the backend stays swappable."""

    name: str
    backend: str

    def detect(self, frame_bgr: np.ndarray) -> int: ...


@dataclass(frozen=True)
class DetectionConfig:
    """All tunables in one place. Each default is labelled *measured* or *design tradeoff*.

    Frame-difference gate (counted at processing resolution, see `process_width`):

      * MEASURED — a static scene produced mean absolute difference 0.8 grey levels, p99 5.0,
        with 0.66% of pixels above 5 grey levels (T0 recon,
        `docs/recon/field-test-environment-2026-09-30.md` section 4.3). The 6-grey-level
        per-pixel threshold is taken from that measurement: it must sit above the noise floor
        and above p99, or every sensor flicker reads as movement.
      * DESIGN TRADEOFF — the 0.5% "share of changed pixels" rule is *chosen*, not measured.
        It exists to reject a whole-frame slow drift (auto-exposure settling moves thousands of
        pixels by a couple of grey levels and never crosses 6, so the ratio stays near zero;
        a real person moves 0.9%-8.7% of pixels). 0.66% is a *different* quantity — it is the
        share of pixels above 5 grey levels in a static scene, not this threshold.

    What the service actually measured with these two defaults (offline scenes and the real
    camera): empty scene and Gaussian-noise scene `motion_ratio = 0.0`; a walking person
    0.0089-0.087. See `docs/design/perception.md` section 3.1.

    Face confirmation: face detection costs 29.3 ms at 640x480 (measured), so it runs every
    Nth frame rather than on every frame; at ~30 fps every 10th frame is ~0.3 s, which is well
    inside the debounce window (15 frames, ~0.5 s).
    """

    motion_pixel_threshold: int = 6
    motion_min_ratio: float = 0.005
    process_width: int = 320
    face_every_n_frames: int = 10
    face_confirm_if_any_face: bool = True

    # Backend selection.
    use_face_detector: bool = True
    use_haar_fallback: bool = True

    def __post_init__(self) -> None:
        if self.motion_pixel_threshold < 1:
            raise ValueError("motion_pixel_threshold 必须 >= 1")
        if not 0.0 <= self.motion_min_ratio <= 1.0:
            raise ValueError("motion_min_ratio 必须在 [0,1]")
        if self.face_every_n_frames < 1:
            raise ValueError("face_every_n_frames 必须 >= 1")


@dataclass
class FrameSignals:
    """Per-frame evidence, kept small enough to log one JSON line per frame."""

    frame_index: int = 0
    timestamp_ms: float = 0.0
    motion: bool = False
    motion_ratio: float = 0.0
    motion_mean_absdiff: float = 0.0
    faces: int = 0
    face_backend: str | None = None
    face_ran: bool = False
    signal: bool = False
    detect_ms: float = 0.0
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "frame": self.frame_index,
            "ts_ms": round(self.timestamp_ms, 1),
            "motion": self.motion,
            "motion_ratio": round(self.motion_ratio, 5),
            "motion_mean_absdiff": round(self.motion_mean_absdiff, 2),
            "faces": self.faces,
            "face_backend": self.face_backend,
            "face_ran": self.face_ran,
            "signal": self.signal,
            "detect_ms": round(self.detect_ms, 2),
            "reason": self.reason,
        }


class YuNetFaceDetector:
    """`cv2.FaceDetectorYN` — 227 KB ONNX model, CPU only, no torch, no download at run time.

    The model file is not vendored in the repository (binary, and the repo already keeps
    models out of git); `load_yunet_model_path` locates it and the copy command is
    documented in `docs/recon/camera-detector-choice-2026-09-30.md`.
    """

    name = "yunet"

    def __init__(self, model_path: str | Path, size: tuple[int, int], score_threshold: float) -> None:
        self.model_path = str(model_path)
        self.backend = f"cv2.FaceDetectorYN {cv2.__version__}"
        self._detector = cv2.FaceDetectorYN.create(
            self.model_path, "", size, score_threshold, 0.3, 5000
        )
        self._size = size

    def detect(self, frame_bgr: np.ndarray) -> int:
        height, width = frame_bgr.shape[:2]
        if (width, height) != self._size:
            self._detector.setInputSize((width, height))
            self._size = (width, height)
        _, faces = self._detector.detect(frame_bgr)
        return 0 if faces is None else int(len(faces))


class HaarFaceDetector:
    """OpenCV Haar cascade fallback (bundled with OpenCV, nothing to download).

    Only available with `opencv-python-headless<5`: OpenCV 5.0 removed
    `cv2.CascadeClassifier` (measured in the T0 recon). The import path is guarded so a
    5.x install degrades instead of crashing.
    """

    name = "haar_frontalface"

    def __init__(self, min_size: tuple[int, int] = (40, 40)) -> None:
        if not hasattr(cv2, "CascadeClassifier"):
            raise RuntimeError("当前 OpenCV 没有 cv2.CascadeClassifier（5.0 已移除）；需要 opencv-python-headless<5")
        cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(str(cascade_path))
        if cascade.empty():
            raise RuntimeError(f"读不出 Haar 级联文件：{cascade_path}")
        self._cascade = cascade
        self._min_size = min_size
        self.backend = f"cv2.CascadeClassifier {cv2.__version__}"

    def detect(self, frame_bgr: np.ndarray) -> int:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        faces = self._cascade.detectMultiScale(
            gray, scaleFactor=1.05, minNeighbors=5, minSize=self._min_size
        )
        return 0 if faces is None else int(len(faces))


class NullFaceDetector:
    """Explicit "no face detector" backend: motion alone decides. Never a silent fallback."""

    name = "none"
    backend = "disabled"

    def detect(self, frame_bgr: np.ndarray) -> int:
        return 0


def load_yunet_model_path(explicit: str | Path | None = None) -> Path:
    """Find the YuNet model, or explain exactly what is missing.

    Search order: the `--model` argument, `XIXI_YUNET_MODEL`, then the conventional
    local copy under `data/models/`. The repository does not track the binary.

    The model actually measured for this build (see the recon report):

        file    data/models/face_detection_yunet_2023mar.onnx
        size    232,589 B (227 KB)
        sha256  8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4
                (reproduce: Get-FileHash data/models/face_detection_yunet_2023mar.onnx -Algorithm SHA256)

    Every timing in `docs/recon/camera-detector-choice-2026-09-30.md` and in
    `docs/design/perception.md` belongs to *that* file. **If you replace the model, update the
    SHA-256 in both documents** (and re-run `python -m perception_edge.bench`), otherwise the
    numbers on paper describe a file that is no longer on disk.
    """
    import os

    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(Path(explicit))
    from_env = os.environ.get("XIXI_YUNET_MODEL")
    if from_env:
        candidates.append(Path(from_env))
    repo_root = Path(__file__).resolve().parents[3]
    candidates.append(repo_root / "data" / "models" / "face_detection_yunet_2023mar.onnx")

    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "找不到 YuNet 模型 face_detection_yunet_2023mar.onnx（227 KB）。"
        "下载地址：https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx "
        "并保存为 data/models/face_detection_yunet_2023mar.onnx，或用 --model / XIXI_YUNET_MODEL 指定路径。"
    )


def create_face_detector(
    frame_size: tuple[int, int],
    *,
    model_path: str | Path | None = None,
    score_threshold: float = DEFAULT_FACE_SCORE_THRESHOLD,
) -> FaceDetector:
    """YuNet when the model and OpenCV support it, Haar when possible, else Null.

    The caller is told which backend is in use (`detector.name`); a missing model never
    silently downgrades the decision, it only downgrades the confirmation step.
    """
    try:
        return YuNetFaceDetector(load_yunet_model_path(model_path), frame_size, score_threshold)
    except (FileNotFoundError, AttributeError, cv2.error):
        try:
            return HaarFaceDetector()
        except (RuntimeError, AttributeError):
            return NullFaceDetector()


class PresenceDetector:
    """Frame-differencing gate plus cadenced face confirmation. Pure, deterministic, no I/O.

    The detector answers "does this frame carry evidence of a person"; the *decision*
    with hysteresis lives in `debounce.PresenceDebouncer`. Splitting the two is what makes
    the offline regression tests possible without a camera.
    """

    def __init__(
        self,
        config: DetectionConfig | None = None,
        face_detector: FaceDetector | None = None,
    ) -> None:
        self.config = config or DetectionConfig()
        self.face_detector: FaceDetector = face_detector or NullFaceDetector()
        self._previous_small: np.ndarray | None = None
        self._frame_index = 0
        self._face_ran_count = 0

    @property
    def face_backend(self) -> str:
        return self.face_detector.name

    def reset(self) -> None:
        self._previous_small = None
        self._frame_index = 0
        self._face_ran_count = 0

    def _small(self, frame_bgr: np.ndarray) -> np.ndarray:
        width = self.config.process_width
        height, source_width = frame_bgr.shape[:2]
        if source_width == width:
            small = frame_bgr
        else:
            scale = width / float(source_width)
            small = cv2.resize(frame_bgr, (width, max(1, int(round(height * scale)))), interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: float = 0.0) -> FrameSignals:
        """Evaluate one frame. `signal=True` means "this frame says a person is there"."""
        started = cv2.getTickCount()
        signals = FrameSignals(frame_index=self._frame_index, timestamp_ms=timestamp_ms)

        gray_small = self._small(frame_bgr)
        if self._previous_small is not None and self._previous_small.shape == gray_small.shape:
            difference = cv2.absdiff(gray_small, self._previous_small)
            signals.motion_mean_absdiff = float(difference.mean())
            moved = int(np.count_nonzero(difference > self.config.motion_pixel_threshold))
            signals.motion_ratio = moved / float(difference.size)
            signals.motion = signals.motion_ratio >= self.config.motion_min_ratio
        self._previous_small = gray_small

        face_due = self.config.use_face_detector and (
            self._frame_index % self.config.face_every_n_frames == 0
        )
        if face_due:
            try:
                signals.faces = self.face_detector.detect(frame_bgr)
                signals.face_backend = self.face_detector.name
                signals.face_ran = True
                self._face_ran_count += 1
            except (cv2.error, RuntimeError):
                # A detector failure must not become a "there is a person" claim.
                signals.faces = 0
                signals.face_backend = f"{self.face_detector.name}:error"
                signals.face_ran = True

        face_says_person = signals.faces > 0 and self.config.face_confirm_if_any_face
        signals.signal = bool(signals.motion or face_says_person)

        reasons: list[str] = []
        if signals.motion:
            reasons.append(f"motion>={self.config.motion_min_ratio:.3f}")
        if face_says_person:
            reasons.append(f"face={signals.faces}")
        if not reasons:
            reasons.append("no_motion" if not signals.motion else "")
            if not signals.motion and signals.faces == 0 and signals.face_ran:
                reasons.append("no_face")
            elif not signals.motion:
                reasons.append("no_face_this_frame" if not signals.face_ran else "")
        signals.reason = ",".join(part for part in reasons if part)

        signals.detect_ms = (cv2.getTickCount() - started) / cv2.getTickFrequency() * 1000.0
        self._frame_index += 1
        return signals
