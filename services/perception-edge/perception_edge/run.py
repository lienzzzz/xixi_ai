"""The perception loop: capture → detect → debounce → emit. One process, no service, no cloud.

Run it against the real camera:

    python -m perception_edge.run --seconds 20

or offline, with scripted synthetic scenes (used by the regression tests):

    python -m perception_edge.run --source synthetic --scenario person-arrives-moves-leaves

The loop prints one JSON object per line: `frame` records (evidence, for measurement),
`event` records (the `presence.changed` events, contract-validated) and one final
`summary`. Nothing is uploaded and no image is written: frame data dies with the process.

`--live` (t78, used by the field-test console's 「启用」 button) keeps the same loop but streams
the picture to the caller: one `frame` line per sampled frame, each carrying a base64 JPEG
(`cv2.imencode`, memory only — `images_written` stays 0 and `image_sinks` is `stdout:base64-jpeg`).
Two consequences worth writing down:

* **The picture is not saved, the events are.** What gets persisted is exactly what always did:
  `presence.changed` events plus the `world_state` projection (that is the product). The frame is
  only how the local page gets to *see* the camera, over localhost.
* **The caller stops it.** The live loop has no `--seconds`: it ends when its stdin closes or it is
  terminated. On Windows a killed process reports exit code 1 with no signal marker, so a stop
  initiated by the caller looks like a failure to a naive check — treat "we killed it ourselves"
  as a normal stop (see `scripts/verify-camera-presence.ts --live` and docs/design/perception.md §7).

Privacy note, stated once and enforced by construction: this module has no HTTP client, no
socket, and no upload path. `semantic_hook` is the *only* place where a future "send one
screenshot to a multimodal model on demand" path could live, and it is deliberately
unimplemented — see `semantic.py`.
"""

from __future__ import annotations

import argparse
import base64
import json
import signal
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Sequence

import cv2
import numpy as np

from .camera import CameraConfig, CameraUnavailable, FrameGrabber, SyntheticFrameSource
from .debounce import ABSENT, PRESENT, DebounceConfig, PresenceDebouncer
from .detector import DetectionConfig, PresenceDetector, create_face_detector
from .emitter import EventEmitter, frame_record
from .contracts import local_timestamp
from .scenes import empty_static, face_track, person_track, speckle_frame, still_track
from .semantic import SemanticAnalysisHook, describe_privacy_boundary


@dataclass
class RunConfig:
    seconds: float = 20.0
    max_frames: int | None = None
    source: str = "camera"
    scenario: str | None = None
    detector: str = "auto"
    model: str | None = None
    width: int = 640
    height: int = 480
    camera_index: int = 0
    process_width: int = 320
    motion_pixel_threshold: int = 6
    motion_min_ratio: float = 0.005
    face_every_n_frames: int = 10
    present_confirm_frames: int = 15
    absent_confirm_frames: int = 45
    release_grace_ms: float = 3000.0
    initial_state: str = ABSENT
    db: str | None = None
    append: bool = False
    quiet_frames: bool = False
    ttl_seconds: float = 60.0


def _face_detector(cfg: RunConfig, size: tuple[int, int]):
    if cfg.detector == "none":
        from .detector import NullFaceDetector

        return NullFaceDetector()
    if cfg.detector == "haar":
        from .detector import HaarFaceDetector

        return HaarFaceDetector()
    if cfg.detector == "yunet":
        from .detector import YuNetFaceDetector, load_yunet_model_path

        return YuNetFaceDetector(load_yunet_model_path(cfg.model), size, 0.6)
    return create_face_detector(size, model_path=cfg.model)


# ----------------------------------------------------------------- synthetic scenes
#
# The scenes themselves live in `scenes.py` (drawn by code — no external assets, no licence
# questions). This mapping only decides *which* scene each named scenario plays, and every
# scenario exists to pin down one debounce requirement in tests/perception/.


def synthetic_scenario(name: str, shape=(480, 640), fps: float = 30.0) -> list[tuple[np.ndarray, float]]:
    """Named scenes, each one a documented debounce requirement."""
    if name == "empty-still":
        # A room with nothing happening: must never claim presence.
        return still_track(90, shape=shape)

    if name == "person-arrives-moves-leaves":
        # A person stands and moves: detected only after `present_confirm_frames`
        # consistent frames, and left only after the absence window plus the release grace.
        return person_track(120, start_x=40, step=14, shape=shape) + still_track(120, shape=shape)

    if name == "face-arrives":
        # The face path: confirmation must come from the face detector, not only motion.
        return face_track(60, shape=shape) + still_track(120, fill=70, shape=shape)

    if name == "brief-occlusion":
        # Person moves, the lens is covered for a moment (0.5 s), the person moves again.
        # Must produce at most one extra pair of events, never a stutter.
        return (
            person_track(90, start_x=40, step=14, shape=shape)
            + still_track(15, shape=shape)
            + person_track(90, start_x=40, step=14, shape=shape)
            + still_track(120, shape=shape)
        )

    if name == "long-occlusion":
        # A real occlusion (5 s of nothing) must report the absence exactly once: the
        # event means "nobody is visible", and it must not repeat while it stays true.
        return (
            person_track(90, start_x=40, step=14, shape=shape)
            + still_track(150, shape=shape)
            + person_track(90, start_x=40, step=14, shape=shape)
        )

    if name == "single-frame-glitch":
        # One corrupted frame in an empty room: the classic false positive, must be ignored.
        frames = still_track(60, shape=shape)
        frames[20] = (speckle_frame(shape=shape), frames[20][1])
        return frames

    if name == "glitch-burst":
        # A short burst that appears and vanishes inside the glitch window: ignored.
        return (
            still_track(20, shape=shape)
            + person_track(4, start_x=60, step=20, shape=shape)
            + still_track(60, shape=shape)
        )

    raise SystemExit(
        f"未知的合成场景 '{name}'；可用：empty-still, person-arrives-moves-leaves, face-arrives, "
        "brief-occlusion, long-occlusion, single-frame-glitch, glitch-burst"
    )


def run(
    cfg: RunConfig,
    emitter: EventEmitter,
    semantic: SemanticAnalysisHook | None = None,
    frames: Sequence[tuple[np.ndarray, float]] | None = None,
    on_frame: Callable[[np.ndarray, object, object], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
    pace_fps: float | None = None,
) -> dict:
    """Run the loop once. Returns the summary dict (also printed as a `summary` record).

    `frames` lets a caller (a test, a replay tool) inject its own frame script instead of
    using the camera or one of the named synthetic scenarios.

    `on_frame` is the t78 live-preview seam: it is called with `(frame, signals, decision)`
    after every processed frame, so a caller (the field-test console) can show the picture
    **in memory** without any file ever being written. `should_stop` lets that caller end the
    loop from outside (a stop button, a closed pipe).
    """
    detection = DetectionConfig(
        motion_pixel_threshold=cfg.motion_pixel_threshold,
        motion_min_ratio=cfg.motion_min_ratio,
        process_width=cfg.process_width,
        face_every_n_frames=cfg.face_every_n_frames,
        use_face_detector=cfg.detector != "none",
    )
    debounce = DebounceConfig(
        present_confirm_frames=cfg.present_confirm_frames,
        absent_confirm_frames=cfg.absent_confirm_frames,
        release_grace_ms=cfg.release_grace_ms,
        initial_state=cfg.initial_state,
    )
    detector = PresenceDetector(detection, _face_detector(cfg, (cfg.width, cfg.height)))
    debouncer = PresenceDebouncer(debounce)
    semantic = semantic or SemanticAnalysisHook()

    # Announce the starting state once, so the WorldState projection exists from the first
    # second instead of being absent (a reader then always sees a value + updated_at + TTL).
    emitter.emit_presence(
        present=debouncer.state == PRESENT,
        confidence=0.85,
        source_detail=(
            f"state={debouncer.state} startup frames=0 motion_ratio=0.0000 faces=0 "
            f"gate=motion+face reason=camera_started"
        ),
        timestamp=local_timestamp(),
    )
    events = 1

    frames_seen = 0
    started = time.perf_counter()
    loop_ms: list[float] = []
    detect_ms: list[float] = []
    next_frame_at = started
    grabber = None
    source = None

    if frames is not None:
        source = SyntheticFrameSource(frames).frames()
    elif cfg.source != "synthetic":
        grabber = FrameGrabber(
            CameraConfig(index=cfg.camera_index, width=cfg.width, height=cfg.height, warmup_frames=1)
        )
        grabber.open()
        source = grabber.frames()
    else:
        scenario = cfg.scenario or "person-arrives-moves-leaves"
        source = SyntheticFrameSource(synthetic_scenario(scenario)).frames()

    try:
        for frame, timestamp_ms in source:
            frame_started = time.perf_counter()
            signals = detector.detect(frame, timestamp_ms)
            decision = debouncer.update(
                signal=signals.signal,
                motion_ratio=signals.motion_ratio,
                faces=signals.faces,
                timestamp_ms=timestamp_ms,
                frame_index=signals.frame_index,
            )
            detect_ms.append(signals.detect_ms)
            frames_seen += 1
            if not cfg.quiet_frames:
                emitter.frame(frame_record(signals, decision))
            if decision.changed:
                # Only the transition is persisted; the frames behind it are not.
                emitter.emit_presence(
                    present=decision.state == PRESENT,
                    confidence=decision.confidence,
                    source_detail=decision.source_detail,
                )
                events += 1
                # Semantic analysis stays a stub: it must never be called automatically.
                semantic.on_presence_changed(decision.state == PRESENT, frame)
            loop_ms.append((time.perf_counter() - frame_started) * 1000.0)
            if on_frame is not None:
                on_frame(frame, signals, decision)

            if should_stop is not None and should_stop():
                break
            if cfg.max_frames is not None and frames_seen >= cfg.max_frames:
                break
            if cfg.seconds > 0 and time.perf_counter() - started >= cfg.seconds:
                break
            if pace_fps is not None and pace_fps > 0:
                # Live preview: hold the processing rate down so the camera and the CPU stay
                # available for the audio path (the console runs both at once).
                next_frame_at += 1.0 / pace_fps
                delay = next_frame_at - time.perf_counter()
                if delay > 0:
                    time.sleep(min(delay, 0.5))
    finally:
        if grabber is not None:
            grabber.close()

    elapsed = time.perf_counter() - started
    summary = {
        "source": cfg.source,
        "scenario": cfg.scenario,
        "face_backend": detector.face_backend,
        "process_width": cfg.process_width,
        "face_every_n_frames": cfg.face_every_n_frames,
        "present_confirm_frames": cfg.present_confirm_frames,
        "absent_confirm_frames": cfg.absent_confirm_frames,
        "release_grace_ms": cfg.release_grace_ms,
        "ttl_seconds": cfg.ttl_seconds,
        "frames": frames_seen,
        "elapsed_s": round(elapsed, 2),
        "fps_processed": round(frames_seen / elapsed, 1) if elapsed > 0 else 0.0,
        "detect_ms_mean": round(sum(detect_ms) / len(detect_ms), 2) if detect_ms else 0.0,
        "detect_ms_p95": round(sorted(detect_ms)[min(len(detect_ms) - 1, int(0.95 * (len(detect_ms) - 1)))], 2)
        if detect_ms
        else 0.0,
        "loop_ms_mean": round(sum(loop_ms) / len(loop_ms), 2) if loop_ms else 0.0,
        "events": events,
        "final_state": debouncer.state,
        "counters": debouncer.counters.to_dict(),
        "camera": grabber.stats.summary() if grabber is not None else None,
        "privacy": describe_privacy_boundary(),
        "semantic_analysis": semantic.status(),
    }
    emitter.summary(summary)
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="perception_edge.run",
        description="本地摄像头在场检测（连续视频不出本机；只产出 presence.changed 事件）",
    )
    parser.add_argument("--seconds", type=float, default=20.0, help="最多抓多少秒（默认 20）")
    parser.add_argument("--frames", type=int, default=None, help="最多处理多少帧（优先于 --seconds）")
    parser.add_argument("--source", choices=["camera", "synthetic"], default="camera")
    parser.add_argument("--scenario", default=None, help="--source synthetic 时的场景名")
    parser.add_argument("--detector", choices=["auto", "yunet", "haar", "none"], default="auto")
    parser.add_argument("--model", default=None, help="YuNet onnx 路径（默认 data/models/ 下那份）")
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--process-width", type=int, default=320, help="帧差动的处理宽度（默认 320）")
    parser.add_argument("--motion-pixel-threshold", type=int, default=6)
    parser.add_argument("--motion-min-ratio", type=float, default=0.005)
    parser.add_argument("--face-every-n-frames", type=int, default=10)
    parser.add_argument("--present-confirm-frames", type=int, default=15)
    parser.add_argument("--absent-confirm-frames", type=int, default=45)
    parser.add_argument("--release-grace-ms", type=float, default=3000.0)
    parser.add_argument("--initial-state", choices=[PRESENT, ABSENT], default=ABSENT)
    parser.add_argument("--db", default=None, help="已初始化的西西 SQLite 库（配合 --append）")
    parser.add_argument("--append", action="store_true", help="把事件追加进 --db（不建表、不迁移）")
    parser.add_argument(
        "--ttl-seconds",
        type=float,
        default=60.0,
        help="world_state 投影的 TTL（默认 60 s；必须与 packages/domain 的 DEFAULT_PRESENCE_TTL_SECONDS 一致）",
    )
    parser.add_argument("--quiet-frames", action="store_true", help="不打印逐帧记录，只打印事件与汇总")
    parser.add_argument(
        "--threads",
        type=int,
        default=None,
        help="限制 OpenCV 线程数（默认交给 OpenCV；实时对话链路上建议 1-2，给音频留余量）",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="t78 实时预览模式：一直跑（由 stdin 关闭或 Ctrl+C 结束），每处理 n 帧在 stdout 打一行 frame 记录，"
        "其中 jpeg 字段是**内存里**编码的画面（base64），不写任何文件、不上传",
    )
    parser.add_argument("--live-fps", type=float, default=8.0, help="--live 时的目标处理帧率（默认 8，够了、省 CPU）")
    parser.add_argument("--jpeg-quality", type=int, default=60, help="--live 的 JPEG 质量（默认 60）")
    parser.add_argument("--frame-max-width", type=int, default=480, help="--live 输出画面的最大宽度（默认 480，缩小后才编码）")
    return parser


def _apply_thread_limit(threads: int | None) -> None:
    if threads is None:
        return
    setup = getattr(cv2, "setNumThreads", None)
    if callable(setup):
        setup(max(1, int(threads)))


def build_live_emitter(options: dict[str, Any], source: Callable[[], None] | None = None):
    """The t78 live-preview frame callback: JSON lines on stdout, **picture in memory only**.

    Always returns `(on_frame, should_stop, close)`. The stop condition is not a timer: it is
    "stdin closed or Ctrl+C", which is exactly what the console's 停用 button produces (it closes
    the pipe and then terminates the process). `close()` flushes and reports the final summary.
    """
    import numpy as np  # noqa: F401  (kept local: this module must import without numpy for --help)

    quality = int(options.get("jpeg_quality", 60))
    max_width = int(options.get("frame_max_width", 480))
    every = max(1, int(options.get("frame_every_n_frames", 1)))
    quiet = bool(options.get("quiet_frames", False))
    stopped = threading.Event()
    counter = {"emitted": 0, "skipped": 0}

    def on_frame(frame, signals, decision) -> None:
        counter["emitted_attempt"] = counter.get("emitted_attempt", 0) + 1
        if counter["emitted_attempt"] % every != 0:
            counter["skipped"] += 1
            return
        height, width = frame.shape[:2]
        scale = max_width / float(width) if width > max_width else 1.0
        picture = frame if scale >= 1.0 else cv2.resize(frame, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
        ok, buffer = cv2.imencode(".jpg", picture, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        record = {
            "type": "frame",
            "at": local_timestamp(),
            "frame_index": int(getattr(signals, "frame_index", 0)),
            "present": bool(decision.state == PRESENT),
            "state": str(decision.state),
            "confidence": float(decision.confidence),
            "changed": bool(decision.changed),
            "motion_ratio": float(getattr(signals, "motion_ratio", 0.0)),
            "faces": int(getattr(signals, "faces", 0)),
            "detect_ms": float(getattr(signals, "detect_ms", 0.0)),
            "jpeg_bytes": int(buffer.size) if ok else 0,
            "width": int(picture.shape[1]),
            "height": int(picture.shape[0]),
            # The picture is base64 **in the JSON line**: it is never written to a file.
            "jpeg": base64.b64encode(buffer.tobytes()).decode("ascii") if ok else None,
        }
        counter["emitted"] += 1
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if not quiet:
            print(f"# frame {record['frame_index']} state={record['state']} conf={record['confidence']:.2f}", file=sys.stderr, flush=True)

    def should_stop() -> bool:
        return stopped.is_set()

    def close() -> None:
        stopped.set()

    def _watch_stdin() -> None:
        # When the parent dies (or closes our stdin), read() returns "" and we stop by ourselves:
        # no orphan process keeps the camera busy.
        try:
            while True:
                chunk = sys.stdin.readline()
                if chunk == "":
                    break
        except Exception:  # pragma: no cover - stdin may already be gone
            pass
        stopped.set()

    def _on_signal(signum, frame) -> None:  # pragma: no cover - signal path
        stopped.set()

    try:
        signal.signal(signal.SIGINT, _on_signal)
        signal.signal(signal.SIGTERM, _on_signal)
    except ValueError:  # pragma: no cover - not in the main thread
        pass
    watcher = threading.Thread(target=_watch_stdin, daemon=True)
    watcher.start()

    def report() -> None:
        # `images_written` is 0 **by construction**, and that is checkable rather than a promise:
        # this module's only image call is `cv2.imencode` (memory), and the package contains no
        # `imwrite` / `VideoWriter` / binary file write —
        #   git grep -n "imwrite\|VideoWriter" -- services/perception-edge/perception_edge
        # prints nothing. The field exists so a caller (the console, a verification script) does
        # not have to trust a directory scan of its own.
        print(
            json.dumps(
                {
                    "type": "live_summary",
                    "frames_emitted": counter["emitted"],
                    "frames_skipped": counter["skipped"],
                    "images_written": 0,
                    "image_sinks": ["stdout:base64-jpeg"],
                    "note": "画面不保存：每帧只在内存里编码成 base64 JPEG 写 stdout，交给本机页面显示；在场事件照常写库。",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )

    return on_frame, should_stop, report


def main(argv: Sequence[str] | None = None) -> int:
    parsed = vars(build_parser().parse_args(argv))
    parsed["max_frames"] = parsed.pop("frames")
    threads = parsed.pop("threads")
    live = bool(parsed.pop("live", False))
    live_options = {
        "jpeg_quality": parsed.pop("jpeg_quality", 60),
        "frame_max_width": parsed.pop("frame_max_width", 480),
    }
    live_fps = float(parsed.pop("live_fps", 8.0))
    _apply_thread_limit(threads)
    if live:
        # Unbounded loop, paced to `--live-fps`; the caller stops it (stop button / closed pipe).
        parsed["seconds"] = 0.0
        parsed["quiet_frames"] = True
        # stderr stays for real problems (camera busy, bad --db): the caller already gets every
        # frame on stdout, so a per-frame note there would be noise.
        live_options["quiet_frames"] = True
    cfg = RunConfig(**parsed)
    emitter = EventEmitter(db_path=cfg.db, append=cfg.append, ttl_seconds=cfg.ttl_seconds)
    on_frame = None
    should_stop = None
    report = None
    if live:
        on_frame, should_stop, report = build_live_emitter(live_options)
    try:
        result = run(cfg, emitter, on_frame=on_frame, should_stop=should_stop, pace_fps=live_fps if live else None)
        if report is not None:
            report()
        return 0 if result is not None else 0
    except CameraUnavailable as cause:
        print(f"摄像头不可用：{cause}", file=sys.stderr)
        print("提示：先关掉占用摄像头的程序（相机 App / 会议软件 / 其它预览窗口），或换 --camera-index。", file=sys.stderr)
        return 2
    except FileNotFoundError as cause:
        print(f"缺少模型文件：{cause}", file=sys.stderr)
        return 3
    finally:
        emitter.close()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
