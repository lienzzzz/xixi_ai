"""VAD segmentation CLI: WAV in → speech segments + endpoint timings out.

Used by the Node brain (`scripts/voice-turn.ts`) as the audio front end. Kept as
a one-shot process so a crash cannot leave a stuck listener, and so the same code
path is reproducible in tests (AGENTS.md §3: this machine bluescreens).

Usage:
    python -m voice_edge.segment <file.wav> [--json] [--stop-secs 0.6] [--min-volume 0.0]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import BASELINE, VadBaseline, quiet_logging


@dataclass
class Segment:
    start_ms: float
    end_ms: float
    endpoint_delay_ms: float | None


def load_mono_16k(path: Path, sample_rate: int) -> tuple[bytes, int]:
    """Read a WAV, convert to mono 16-bit PCM at `sample_rate`."""
    import numpy as np
    import soundfile as sf

    audio, source_rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if source_rate != sample_rate:
        import soxr

        mono = soxr.resample(mono, source_rate, sample_rate)
    clipped = np.clip(mono, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes(), sample_rate


def energy_bounds_ms(
    pcm: bytes, sample_rate: int, frame_bytes: int, threshold_dbfs: float = -40.0
) -> tuple[float | None, float | None]:
    """First and last frame above an energy threshold.

    An energy estimate, not a human annotation: it is the same definition the
    spike used, and its uncertainty is about one frame (32 ms). The start value is
    what barge-in latency is measured against — the moment the user's voice
    actually begins, independent of any VAD hold-off.
    """
    import numpy as np

    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    frame_size = frame_bytes // 2
    frames = len(samples) // frame_size
    if frames == 0:
        return None, None
    reshaped = samples[: frames * frame_size].reshape(frames, frame_size)
    rms = np.sqrt(np.mean(reshaped**2, axis=1))
    threshold = 10 ** (threshold_dbfs / 20)
    above = np.nonzero(rms > threshold)[0]
    if len(above) == 0:
        return None, None
    ms_per_frame = frame_size / sample_rate * 1000.0
    return float(above[0] * ms_per_frame), float((above[-1] + 1) * ms_per_frame)


async def segment(path: Path, baseline: VadBaseline, threshold_dbfs: float) -> dict:
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADState

    pcm, sample_rate = load_mono_16k(path, baseline.sample_rate)
    import time

    load_started = time.perf_counter()
    analyzer = SileroVADAnalyzer(params=baseline.to_pipecat_params())
    if hasattr(analyzer, "set_sample_rate"):
        analyzer.set_sample_rate(sample_rate)
    load_ms = (time.perf_counter() - load_started) * 1000.0

    # Feed whole frames: 512 samples of PCM16 = 1024 bytes. Slicing by 512 bytes
    # would hand Silero half a frame and it never reaches its stop condition.
    frame_bytes = baseline.frame_bytes
    bytes_per_ms = sample_rate * 2 / 1000.0  # PCM16 mono
    events: list[dict] = []
    segments: list[Segment] = []
    current_start: float | None = None
    previous: VADState | None = None

    process_started = time.perf_counter()
    for offset in range(0, len(pcm) - frame_bytes + 1, frame_bytes):
        frame = pcm[offset : offset + frame_bytes]
        state = await analyzer.analyze_audio(frame)
        at_ms = offset / bytes_per_ms
        if state != previous:
            events.append({"atMs": round(at_ms, 1), "state": state.name})
            if state == VADState.SPEAKING and current_start is None:
                current_start = at_ms
            elif state == VADState.QUIET and current_start is not None:
                segments.append(Segment(start_ms=current_start, end_ms=at_ms, endpoint_delay_ms=None))
                current_start = None
            previous = state

    if current_start is not None:
        segments.append(Segment(start_ms=current_start, end_ms=len(pcm) / bytes_per_ms, endpoint_delay_ms=None))

    true_start, true_end = energy_bounds_ms(pcm, sample_rate, frame_bytes, threshold_dbfs)
    if segments and true_end is not None:
        last = segments[-1]
        segments[-1] = Segment(last.start_ms, last.end_ms, round(last.end_ms - true_end, 1))

    # How long after the user's voice actually starts does the VAD commit to
    # "speech started"? That interval is the barge-in decision latency (§14.2).
    first_speaking = next((event["atMs"] for event in events if event["state"] in ("STARTING", "SPEAKING")), None)
    barge_in_latency = None if first_speaking is None or true_start is None else round(first_speaking - true_start, 1)

    return {
        "file": str(path),
        "sampleRate": sample_rate,
        "bytes": len(pcm),
        "durationMs": round(len(pcm) / (sample_rate * 2) * 1000.0, 1),
        "baseline": {
            "confidence": baseline.confidence,
            "start_secs": baseline.start_secs,
            "stop_secs": baseline.stop_secs,
            "min_volume": baseline.min_volume,
            "frameSize": baseline.frame_size,
            "frameBytes": frame_bytes,
        },
        "energyStartMs": None if true_start is None else round(true_start, 1),
        "energyEndMs": None if true_end is None else round(true_end, 1),
        "bargeInDecisionMs": barge_in_latency,
        # Split the two costs honestly: a live streaming pipeline pays `processMs`
        # per frame, while `loadMs` and the interpreter start are one-off cold-start
        # costs that a resident voice process would not pay per turn.
        "timings": {
            "loadMs": round(load_ms, 1),
            "processMs": round((time.perf_counter() - process_started) * 1000.0, 1),
            "audioMs": round(len(pcm) / (sample_rate * 2) * 1000.0, 1),
        },
        "segments": [
            {
                "startMs": round(segment.start_ms, 1),
                "endMs": round(segment.end_ms, 1),
                "durationMs": round(segment.end_ms - segment.start_ms, 1),
                "endpointDelayMs": segment.endpoint_delay_ms,
            }
            for segment in segments
        ],
        "events": events,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="VAD segmentation for the Xixi voice edge")
    parser.add_argument("wav", type=Path)
    parser.add_argument("--stop-secs", type=float, default=BASELINE.stop_secs)
    parser.add_argument("--min-volume", type=float, default=BASELINE.min_volume)
    parser.add_argument("--confidence", type=float, default=BASELINE.confidence)
    parser.add_argument("--energy-dbfs", type=float, default=-40.0)
    parser.add_argument("--json", action="store_true", help="accepted for symmetry; output is always JSON")
    args = parser.parse_args(argv)

    baseline = VadBaseline(
        confidence=args.confidence,
        stop_secs=args.stop_secs,
        min_volume=args.min_volume,
    )
    quiet_logging()
    result = asyncio.run(segment(args.wav, baseline, args.energy_dbfs))
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0 if result["segments"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
