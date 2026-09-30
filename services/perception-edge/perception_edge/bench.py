"""Detector benchmark: the numbers that justify the detector choice.

    python -m perception_edge.bench

Measures, on this machine, with no network access:

  * per-frame detect time (median / p95, over N repeats after warmup) for each candidate
    at 640x480 and 320x240;
  * CPU occupancy during the timing run (`process_time` delta / wall time), which is the
    number that matters on a laptop that is also running ASR and TTS;
  * positive controls (images that do contain a face, if present under data/models/) and
    negative controls (a generated empty scene with and without noise).

Results are printed as JSON so the recon report quotes machine output rather than memory.
Candidate list and the reasons HOG is not among them: `docs/recon/camera-detector-choice-2026-09-30.md`.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import time
from pathlib import Path
from typing import Any, Callable, Sequence

import cv2
import numpy as np

from .scenes import empty_static, person_moving, speckle_frame
from .contracts import repo_root
from .detector import (
    DetectionConfig,
    HaarFaceDetector,
    NullFaceDetector,
    PresenceDetector,
    YuNetFaceDetector,
    load_yunet_model_path,
)

REPEATS = 15
WARMUP = 3


def _time_call(call: Callable[[], Any]) -> dict:
    for _ in range(WARMUP):
        call()
    cpu_before = time.process_time()
    wall_before = time.perf_counter()
    samples: list[float] = []
    for _ in range(REPEATS):
        started = time.perf_counter()
        call()
        samples.append((time.perf_counter() - started) * 1000.0)
    wall = time.perf_counter() - wall_before
    cpu = time.process_time() - cpu_before
    ordered = sorted(samples)
    total_cores = os.cpu_count() or 1
    return {
        "median_ms": round(ordered[len(ordered) // 2], 2),
        "min_ms": round(ordered[0], 2),
        "p95_ms": round(ordered[min(len(ordered) - 1, int(0.95 * (len(ordered) - 1)))], 2),
        "max_ms": round(ordered[-1], 2),
        "repeats": REPEATS,
        # OpenCV parallelises internally, so process CPU time can exceed wall time.
        # Both numbers are reported: core-percent (how much of one core) and
        # whole-machine percent (what `top` would show on this 8-core laptop).
        "cpu_core_percent": round(100.0 * cpu / wall, 1) if wall > 0 else None,
        "cpu_machine_percent": round(100.0 * cpu / wall / total_cores, 1) if wall > 0 and total_cores else None,
        "cpu_cores": total_cores,
    }


def _thread_info() -> dict:
    """OpenCV's own thread pool size: it explains CPU numbers above 100%."""
    try:
        return {
            "cv2_num_threads": int(cv2.getNumThreads()),
            "cv2_build_parallel": bool(cv2.getBuildInformation().count("Parallel framework") and "TBB" in cv2.getBuildInformation() or True),
        }
    except Exception as cause:  # noqa: BLE001 - diagnostic only
        return {"cv2_num_threads": None, "error": str(cause)}


def _model_size(path: Path | str | None) -> int | None:
    if path is None:
        return None
    candidate = Path(path)
    return candidate.stat().st_size if candidate.is_file() else None


def benchmark_detectors() -> dict:
    repo = repo_root()
    empty_scene = empty_static()
    empty_small = cv2.resize(empty_scene, (320, 240))
    selfie_path = repo / "data" / "models" / "largest_selfie.jpg"
    lena_path = repo / "data" / "models" / "lena.jpg"

    results: dict[str, Any] = {
        "environment": {
            "python": platform.python_version(),
            "opencv": cv2.__version__,
            "numpy": np.__version__,
            "platform": platform.platform(),
            "cpu_count": __import__("os").cpu_count(),
            "has_cascade_classifier": hasattr(cv2, "CascadeClassifier"),
            "has_hog": hasattr(cv2, "HOGDescriptor"),
            "has_face_detector_yn": hasattr(cv2, "FaceDetectorYN"),
            "torch_installed": _module_present("torch"),
            "cv2_num_threads": _thread_info()["cv2_num_threads"],
        },
        "detectors": {},
        "controls": {},
    }

    # --- candidate: YuNet via cv2.FaceDetectorYN -------------------------------------
    yunet_path: str | None = None
    try:
        yunet_path = str(load_yunet_model_path())
        for label, frame in (("640x480", empty_scene), ("320x240", empty_small)):
            detector = YuNetFaceDetector(yunet_path, (frame.shape[1], frame.shape[0]), 0.6)
            results["detectors"][f"yunet_{label}"] = {
                **_time_call(lambda d=detector, f=frame: d.detect(f)),
                "model_bytes": _model_size(yunet_path),
                "backend": detector.backend,
                "needs_download": True,
            }
    except (FileNotFoundError, AttributeError, cv2.error) as cause:
        results["detectors"]["yunet"] = {"unavailable": str(cause)}

    # --- candidate: Haar frontal face (OpenCV 4.x only) -----------------------------
    try:
        for label, frame in (("640x480", empty_scene), ("320x240", empty_small)):
            detector = HaarFaceDetector()
            results["detectors"][f"haar_{label}"] = {
                **_time_call(lambda d=detector, f=frame: d.detect(f)),
                "model_bytes": _model_size(
                    Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
                ),
                "backend": detector.backend,
                "needs_download": False,
            }
    except (RuntimeError, AttributeError) as cause:
        results["detectors"]["haar"] = {"unavailable": str(cause)}

    # --- candidate: no face detector (motion gate only) -----------------------------
    for label, frame in (("640x480", empty_scene), ("320x240", empty_small)):
        detector = NullFaceDetector()
        results["detectors"][f"none_{label}"] = {
            **_time_call(lambda d=detector, f=frame: d.detect(f)),
            "backend": detector.backend,
            "needs_download": False,
            "note": "只用来标定「没有确认步骤时」的基线",
        }

    # --- the composed gate (what the service actually runs) -------------------------
    # Two measurements, because they answer different questions:
    #   * `composed_every_frame` is the steady-state per-frame cost of the loop;
    #   * `composed_amortised` divides the total time by the frame count, which is the
    #     number that decides whether 30 fps is reachable.
    composed = PresenceDetector(
        DetectionConfig(),
        YuNetFaceDetector(yunet_path, (640, 480), 0.6) if yunet_path else HaarFaceDetector(),
    )
    frames = [person_moving(40 + index * 9, 80) for index in range(REPEATS + WARMUP + 1)]
    index = 0

    def composed_step() -> None:
        nonlocal index
        composed.detect(frames[index % len(frames)], float(index))
        index += 1

    composed_result = _time_call(composed_step)
    results["detectors"]["composed_motion_plus_yunet_every10"] = {
        **composed_result,
        "note": "逐帧帧差动 + 每 10 帧一次人脸确认（服务实际跑的路径）",
    }

    # Amortised cost over 60 frames of a realistic person scene.
    detector_for_amortised = PresenceDetector(
        DetectionConfig(),
        YuNetFaceDetector(yunet_path, (640, 480), 0.6) if yunet_path else HaarFaceDetector(),
    )
    script = [person_moving(40 + index * 9, 80) for index in range(60)]
    cpu_before = time.process_time()
    started = time.perf_counter()
    for order, frame in enumerate(script):
        detector_for_amortised.detect(frame, order * 33.3)
    wall = time.perf_counter() - started
    cpu = time.process_time() - cpu_before
    results["detectors"]["composed_amortised_60_frames"] = {
        "frames": 60,
        "total_ms": round(wall * 1000.0, 1),
        "ms_per_frame": round(wall * 1000.0 / 60, 2),
        "headroom_at_30fps_percent": round(100.0 * (wall / 60.0) / (1.0 / 30.0), 1),
        "cpu_core_percent": round(100.0 * cpu / wall, 1),
        "cpu_machine_percent": round(100.0 * cpu / wall / (os.cpu_count() or 1), 1),
        "note": "60 帧合计；ms_per_frame 是能否跑满 30 fps 的判据",
    }

    # --- positive controls (external images, only when the local copies exist) ------
    for name, path in (("selfie", selfie_path), ("lena", lena_path)):
        if not path.is_file():
            results["controls"][name] = {
                "present": False,
                "note": f"{path.relative_to(repo).as_posix()} 不在本机；这是可选的正对照，不是运行依赖",
            }
            continue
        image = cv2.imread(str(path))
        resized = cv2.resize(image, (640, 480))
        entry: dict[str, Any] = {"present": True, "bytes": path.stat().st_size}
        if yunet_path:
            detector = YuNetFaceDetector(yunet_path, (640, 480), 0.6)
            entry["yunet_faces_at_640x480"] = detector.detect(resized)
            entry["yunet_faces_native"] = detector.detect(image)
        if hasattr(cv2, "CascadeClassifier"):
            haar = HaarFaceDetector()
            entry["haar_faces_at_640x480"] = haar.detect(resized)
        results["controls"][name] = entry

    # --- negative controls (generated, no licence questions) ------------------------
    noise = speckle_frame(ratio=0.25, amplitude=90)
    negatives = {"empty_scene": empty_scene, "empty_with_speckle": noise}
    results["negative_controls"] = {}
    for label, frame in negatives.items():
        entry: dict[str, Any] = {}
        if yunet_path:
            entry["yunet_faces"] = YuNetFaceDetector(yunet_path, (640, 480), 0.6).detect(frame)
        if hasattr(cv2, "CascadeClassifier"):
            entry["haar_faces"] = HaarFaceDetector().detect(frame)
        detector = PresenceDetector(DetectionConfig(), YuNetFaceDetector(yunet_path, (640, 480), 0.6) if yunet_path else HaarFaceDetector())
        detector.detect(empty_scene, 0.0)
        signals = detector.detect(frame, 1.0)
        entry["composed_signal"] = signals.signal
        entry["composed_reason"] = signals.reason
        entry["motion_ratio"] = round(signals.motion_ratio, 5)
        results["negative_controls"][label] = entry

    return results


def _module_present(name: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(name) is not None


def main(argv: Sequence[str] | None = None) -> int:
    """Print the benchmark; `--out PATH` also writes it as UTF-8 (so shells cannot mangle it)."""
    parser = argparse.ArgumentParser(prog="perception_edge.bench", description="在场检测器耗时与 CPU 实测")
    parser.add_argument("--out", default=None, help="把结果写成 UTF-8 JSON 文件（方便直接引用）")
    args = parser.parse_args(argv)
    payload = benchmark_detectors()
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
