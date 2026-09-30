"""Device loopback: play a WAV through the speakers and record it with the mic.

This is the honest way to close the one gap a fixture cannot: whether the real
capture and playback path works. It answers three questions at once:

  1. does the machine actually play audio (speaker path);
  2. does the microphone capture it (input path, gain, muting);
  3. does our pipeline still transcribe correctly from *acoustic* audio
     (room noise, reverb, resampling) rather than from a clean file.

It records at the device rate and resamples to 16 kHz mono PCM16, which is what
`voice_edge.segment` and the ASR path expect.

Usage:
    python -m voice_edge.loopback <fixture.wav> <out.wav> [--tail-ms 800] [--gain 0.6]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import quiet_logging

TARGET_RATE = 16_000


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Xixi voice edge: speaker→microphone loopback")
    parser.add_argument("wav", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--tail-ms", type=float, default=800.0)
    parser.add_argument("--gain", type=float, default=0.6, help="playback gain; keep it modest")
    parser.add_argument("--record-rate", type=int, default=48_000)
    args = parser.parse_args(argv)

    import numpy as np
    import sounddevice as sd
    import soundfile as sf
    import soxr

    quiet_logging()

    audio, source_rate = sf.read(str(args.wav), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if source_rate != args.record_rate:
        mono = soxr.resample(mono, source_rate, args.record_rate)
    played = np.clip(mono * args.gain, -1.0, 1.0)

    record_frames = int(len(played) + (args.tail_ms / 1000.0) * args.record_rate)
    padded = np.zeros(record_frames, dtype=np.float32)
    padded[: len(played)] = played

    # blocking=True: playrec returns once the whole buffer has been played and recorded.
    recorded = sd.playrec(padded, samplerate=args.record_rate, channels=1, dtype="float32", blocking=True)
    sd.wait()
    captured = np.asarray(recorded).reshape(-1)

    resampled = soxr.resample(captured, args.record_rate, TARGET_RATE) if args.record_rate != TARGET_RATE else captured
    args.out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(args.out), np.clip(resampled, -1.0, 1.0), TARGET_RATE, subtype="PCM_16")

    rms = float(np.sqrt(np.mean(captured**2))) if len(captured) > 0 else 0.0
    peak = float(np.max(np.abs(captured))) if len(captured) > 0 else 0.0
    # A muted or absent microphone shows up as a near-silent capture; say so loudly
    # rather than pretending the loopback succeeded.
    verdict = "ok" if rms > 0.005 else "silent-capture (microphone muted, wrong device, or playback inaudible)"

    json.dump(
        {
            "fixture": str(args.wav),
            "recording": str(args.out),
            "playbackSeconds": round(len(played) / args.record_rate, 2),
            "recordedSeconds": round(len(captured) / args.record_rate, 2),
            "recordRate": args.record_rate,
            "savedRate": TARGET_RATE,
            "rms": round(rms, 5),
            "peak": round(peak, 4),
            "verdict": verdict,
        },
        sys.stdout,
        ensure_ascii=False,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0 if verdict == "ok" else 3


if __name__ == "__main__":
    raise SystemExit(main())
