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

from .camera import (
    CameraConfig,
    CameraUnavailable,
    FrameGrabber,
    SyntheticFrameSource,
    frame_brightness,
)
from .debounce import ABSENT, PRESENT, DebounceConfig, PresenceDebouncer
from .detector import DetectionConfig, PresenceDetector, create_face_detector
from .emitter import EventEmitter, frame_record
from .contracts import local_timestamp
from .scenes import empty_static, face_track, person_track, speckle_frame, still_track
from .semantic import SemanticAnalysisHook, describe_privacy_boundary

#: How long `open()` may spend waiting for the device before we give up and explain why (t89).
#: The budget covers the whole failure path (process start + VideoCapture + polling) and the
#: acceptance target is "exit within about 5 seconds". Measured on this machine: importing cv2 and
#: numpy costs ~0.27 s, the DSHOW constructor 0.1-1.4 s when the index does not exist (it varies),
#: and the rest is this budget. 3.0 s keeps the total inside the target with margin; callers that
#: also have their own startup work can shrink it further with `--camera-open-timeout`.
CAMERA_OPEN_TIMEOUT_SECONDS = 3.0


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
    #: Seconds spent skipping blank frames while hunting for a usable first frame (t99).
    camera_blank_timeout: float = 1.5
    #: Seconds to wait for the device before reporting a Chinese reason and exiting (t89).
    camera_open_timeout: float = CAMERA_OPEN_TIMEOUT_SECONDS


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
            CameraConfig(
                index=cfg.camera_index,
                width=cfg.width,
                height=cfg.height,
                warmup_frames=1,
                # t89: fail fast instead of retrying for as long as the default allows. The
                # device is either there or it is not; a long block only delays the explanation.
                # The caller may shrink this further (see `--camera-open-timeout`).
                open_timeout_s=cfg.camera_open_timeout,
                # t99: skip the blank frames this driver emits after the first good one.
                blank_frame_timeout_s=cfg.camera_blank_timeout,
            )
        )
        grabber.open()
        source = grabber.frames()
    else:
        scenario = cfg.scenario or "person-arrives-moves-leaves"
        source = SyntheticFrameSource(synthetic_scenario(scenario)).frames()

    # t109: every event this run writes carries where its frames came from, so a reader of the
    # ledger can tell "a real camera frame" from "a frame our synthetic scene drew" without
    # guessing. Before this, a `present_confirmed` row written by `--self-test` looked exactly like
    # one written by the real device, and a doc sentence had to claim which it was.
    frame_mode = "synthetic" if (frames is not None or cfg.source == "synthetic") else "camera"

    # Announce the starting state once, so the WorldState projection exists from the first
    # second instead of being absent (a reader then always sees a value + updated_at + TTL).
    #
    # t89: this happens **after** the camera has actually opened. Before that fix it ran first,
    # so a failure to open still wrote a `present=false` "we looked and nobody is there" event —
    # a reading we never took. Ordering it after the open means a camera that refuses to open
    # leaves the log untouched and only produces a Chinese explanation plus exit code 2.
    emitter.emit_presence(
        present=debouncer.state == PRESENT,
        confidence=0.85,
        source_detail=(
            f"mode={frame_mode} state={debouncer.state} startup frames=0 motion_ratio=0.0000 "
            f"faces=0 gate=motion+face reason=camera_started"
        ),
        timestamp=local_timestamp(),
    )
    events = 1

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
                    # t109: carry the frame source on the transition too, not only on the startup
                    # row — the transition is the row that looks identical for a real arrival and a
                    # synthetic one. Prepended, and measured at ~11 chars, so the contract's
                    # 200-character `source_detail` cap is nowhere near.
                    source_detail=f"mode={frame_mode} {decision.source_detail}",
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
        "--probe-frames",
        type=int,
        default=None,
        metavar="N",
        help="只做诊断：从摄像头连抓 N 帧，逐帧打印 mean/min/max/std 与「空帧」判定，再给一条中文结论。"
        "不检测、不写库、不做任何事件（t99 用来区分「摄像头真的黑」与「驱动回传空帧」）",
    )
    parser.add_argument(
        "--camera-open-timeout",
        type=float,
        default=CAMERA_OPEN_TIMEOUT_SECONDS,
        help=f"打不开摄像头时最多等多少秒再报中文原因并退出（默认 {CAMERA_OPEN_TIMEOUT_SECONDS:g} 秒；"
        "调用方如果要保证「数秒内返回」，可以调小它）",
    )
    parser.add_argument(
        "--camera-blank-timeout",
        type=float,
        default=1.5,
        help="找可用首帧时最多跳多少秒的空帧（默认 1.5 秒；全 0/单色帧会被跳过，见 --probe-frames）",
    )
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


def _force_utf8_output() -> None:
    """Make stdout/stderr UTF-8 regardless of the Windows locale codec.

    Why this exists (t89): on a Chinese Windows install, a Python child whose output is a pipe
    encodes text with the ANSI code page (cp936/GBK), not UTF-8. The field-test page decodes the
    child's stderr as UTF-8, so a GBK-encoded Chinese reason arrived as mojibake — the user saw
    «����ͷ�����ã�…» instead of the sentence we wrote. Forcing UTF-8 at the source fixes it for
    every consumer at once, without asking the caller to guess an encoding.

    The JSON stdout records were never affected (they are `ensure_ascii=False` but written, so
    they had the same latent problem for non-ASCII text inside them — this closes that too).
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # pragma: no cover - detached/invalid stream
                pass


def probe_camera_frames(count: int, cfg: RunConfig) -> int:
    """Diagnostic mode: grab N frames and report per-frame brightness, then a Chinese verdict.

    Written for t99 ("the camera hands out pure-black frames"). It answers the one question that
    decides what to do next — is the *picture* dark, or is the *delivery* broken? — without running
    the detector, without writing an event and without writing any image:

      * every frame a flat near-zero constant (`mean = max = 0`, `std = 0`) -> the driver is handing
        out blank buffers. On this machine that happens for every frame after the first one, in
        YUY2/NV12/I420; MJPG keeps streaming, but with a near-constant 1 -> the picture itself never
        arrives;
      * a dim but noisy picture (`std` clearly > 0) -> the frame is real. Blame the lens, a privacy
        shutter or the room;
      * a normal picture -> nothing to fix; use `--seconds` for the real run.

    `blank_frames_skipped` in the summary is how many blank frames `open()` discarded before it
    accepted one, i.e. the direct measure of the driver handing out empty buffers.
    """
    grabber = FrameGrabber(
        CameraConfig(
            index=cfg.camera_index,
            width=cfg.width,
            height=cfg.height,
            warmup_frames=1,
            open_timeout_s=cfg.camera_open_timeout,
            blank_frame_timeout_s=cfg.camera_blank_timeout,
            # t106: the whole point of this mode is to *observe* blank frames, so it must not refuse
            # to start when the stream is blank. The production path keeps the strict default, where
            # a first frame that is still blank means "no picture" and raises.
            require_usable_first_frame=False,
        )
    )
    grabber.open()
    try:
        readings: list[dict] = []
        for index in range(max(1, count)):
            started = time.perf_counter()
            try:
                frame, _ = next(grabber.frames())
            except StopIteration:  # pragma: no cover - the generator is infinite by construction
                break
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            reading = {"record": "probe_frame", "order": index, "read_ms": round(elapsed_ms, 1)}
            reading.update(frame_brightness(frame))
            readings.append(reading)
            print(json.dumps(reading, ensure_ascii=False), flush=True)
    finally:
        grabber.close()

    blanks = [reading for reading in readings if reading["blank"]]
    usable = [reading for reading in readings if not reading["blank"]]
    usable_ratio = (len(usable) / len(readings)) if readings else 0.0
    brightest = max((reading["max"] for reading in usable), default=0)
    if not readings:
        verdict = "驱动连一帧都没给出来"
        advice = "先关掉其它占用摄像头的程序，再跑一次；仍然如此就是驱动/设备状态问题。"
    elif not usable:
        verdict = "每一帧都是空帧（全 0 或单色）：驱动没有把画面交出来"
        advice = (
            "先关掉其它占用摄像头的程序（相机 App、会议软件、控制台「启用」）再跑一次；"
            "仍然全是空帧就拔插一次摄像头或重启一次。注意：这**不能**推出「镜头被挡住」——"
            "被挡住时画面偏暗但有噪声（std > 0），而这里是恒定值。"
        )
    elif usable_ratio <= 0.5:
        verdict = (
            f"取流不稳定：{len(readings)} 帧里只有 {len(usable)} 帧是真实画面，其余是空帧"
            "——先按「别的程序占着摄像头」排查"
        )
        advice = (
            "关掉其它占用摄像头的程序（相机 App、会议软件、控制台「启用」）后重跑；"
            "再看这几帧亮不亮，决定是否继续查遮挡/光照。"
        )
    elif brightest <= 20:
        verdict = f"画面很暗但确实是真实图像（最亮像素 {brightest}，有噪声），更像镜头被挡或环境没光"
        advice = (
            "检查镜头前的滑盖或隐私快门、笔记本是否合盖、房间灯是否关着；把灯打开再跑一次对比。"
            "这条命令本身不改任何设备设置，也不写任何文件。"
        )
    else:
        verdict = f"画面正常有内容（最亮像素 {brightest}），摄像头可用"
        advice = "不需要处理；要跑真正的在场检测用 --seconds。"
    summary = {
        "record": "probe_summary",
        "camera": grabber.stats.summary(),
        "frames": len(readings),
        "blank_frames": len(blanks),
        "usable_frames": len(usable),
        "usable_ratio": round(usable_ratio, 2),
        "mean_range": [
            min((reading["mean"] for reading in readings), default=None),
            max((reading["mean"] for reading in readings), default=None),
        ],
        "max_range": [
            min((reading["max"] for reading in readings), default=None),
            max((reading["max"] for reading in readings), default=None),
        ],
        "verdict": verdict,
        "advice": advice,
        "privacy": describe_privacy_boundary(),
    }
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    print(f"结论：{verdict}\n建议：{advice}", file=sys.stderr)
    # t106: a scripted self-check (the console, a reviewer, a Makefile) needs to tell "usable" from
    # "not usable" *without* parsing JSON, so the exit code carries it: 0 when at least one frame
    # carried a picture, 2 when the driver produced nothing usable (the same code the detection path
    # uses for "camera unavailable").
    return 0 if usable else 2


def _silence_opencv_logging() -> bool:
    """Turn OpenCV's own log messages off, so the operator only sees our Chinese reason.

    Why this exists (t89): with a camera index that does not exist, OpenCV prints a native
    English warning to stderr before we ever get to raise:

        [ WARN:0@0.121] global cap.cpp:477 cv::VideoCapture::open VIDEOIO(DSHOW): backend is
        generally available but can't be used to capture by index

    The field-test page shows the child's stderr verbatim, so without this the user reads an
    English OpenCV line and has to guess. The warning carries no information our own Chinese
    message does not carry (which index, and the three likely causes).

    Returns True when the level was applied, False when this OpenCV has no logging API — the
    caller keeps working either way, and `scripts/verify-camera-presence.ts` also strips any
    native line that still arrives, so this is belt *and* braces on purpose.
    """
    try:
        logging_api = getattr(getattr(cv2, "utils", None), "logging", None)
        level = getattr(logging_api, "LOG_LEVEL_SILENT", None)
        setter = getattr(logging_api, "setLogLevel", None)
        if level is None or not callable(setter):
            return False
        setter(level)
        return True
    except Exception:  # noqa: BLE001 - a diagnostic convenience must never break the run
        return False


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
    probe_frames = parsed.pop("probe_frames", None)
    parsed["camera_blank_timeout"] = float(parsed.pop("camera_blank_timeout", 1.5))
    _force_utf8_output()
    _silence_opencv_logging()
    _apply_thread_limit(threads)
    if live:
        # Unbounded loop, paced to `--live-fps`; the caller stops it (stop button / closed pipe).
        #
        # This block **must** run before `RunConfig(**parsed)` below. It used to sit after it, so
        # these two lines mutated a dict nobody read again: `cfg.seconds` kept its `--seconds`
        # default of 20, and `run()` broke out of the loop at
        #     if cfg.seconds > 0 and time.perf_counter() - started >= cfg.seconds: break
        # Measured 2026-10-08 on the trial page: the preview child exited with code 0 after exactly
        # 161 frames at 8 fps (≈20.1 s) while the page still said 「运行中」 and the picture froze.
        # The module docstring had promised the opposite the whole time ("The live loop has no
        # `--seconds`: it ends when its stdin closes or it is interrupted") — intent and code
        # disagreed, and nothing failed, because nothing asserted the config live mode runs with.
        parsed["seconds"] = 0.0
        parsed["quiet_frames"] = True
        # stderr stays for real problems (camera busy, bad --db): the caller already gets every
        # frame on stdout, so a per-frame note there would be noise.
        live_options["quiet_frames"] = True
    cfg = RunConfig(**parsed)
    if probe_frames is not None:
        # Diagnostic mode (t99): never touches the event log, never runs the detector.
        try:
            return probe_camera_frames(int(probe_frames), cfg)
        except CameraUnavailable as cause:
            print(f"摄像头不可用：{cause}", file=sys.stderr)
            return 2
    emitter = EventEmitter(db_path=cfg.db, append=cfg.append, ttl_seconds=cfg.ttl_seconds)
    on_frame = None
    should_stop = None
    report = None
    if live:
        on_frame, should_stop, report = build_live_emitter(live_options)
    started_at = time.perf_counter()
    try:
        result = run(cfg, emitter, on_frame=on_frame, should_stop=should_stop, pace_fps=live_fps if live else None)
        if report is not None:
            report()
        return 0 if result is not None else 0
    except CameraUnavailable as cause:
        # t89: this is the whole failure path a user sees. One Chinese paragraph, measured
        # elapsed time included, and **no OpenCV English warning** (silenced above; the caller
        # also strips native lines as a second line of defence).
        elapsed = time.perf_counter() - started_at
        print(
            f"摄像头不可用（已等待 {elapsed:.1f} 秒后放弃，不会一直重试）：{cause}",
            file=sys.stderr,
        )
        print(
            "提示：先关掉占用摄像头的程序（相机 App / 会议软件 / 其它预览窗口），再重试；"
            "本机通常只有 1 个摄像头（索引 0），用别的索引一定打不开——"
            "要专门验证「打不开时会不会快速失败」，可以用 --camera-index -1。",
            file=sys.stderr,
        )
        return 2
    except FileNotFoundError as cause:
        print(f"缺少模型文件：{cause}", file=sys.stderr)
        return 3
    finally:
        emitter.close()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
