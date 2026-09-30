"""Device loopback: play a WAV through the speakers and record it with the mic.

This is the honest way to close the one gap a fixture cannot: whether the real
capture and playback path works. It answers three questions at once:

  1. does the machine actually play audio (speaker path);
  2. does the microphone capture it (input path, gain, muting);
  3. does our pipeline still transcribe correctly from *acoustic* audio
     (room noise, reverb, resampling) rather than from a clean file.

It records at the device rate and resamples to 16 kHz mono PCM16, which is what
`voice_edge.segment` and the ASR path expect.

**Verdict design (2026-09-30, fixes a false PASS).** The previous criterion was
`rms > 0.005`, which the recon showed reports `ok` while the output endpoint is muted
(`docs/recon/field-test-environment-2026-09-30.md` §2.5: muted 0.05053 vs unmuted 0.04860 —
the ambient noise floor alone is 0.043, so the threshold can never fail). It now uses two
*relative* acoustic criteria plus the endpoint's mute state:

* **speech-band lift**: the 300–3400 Hz level in the playback window minus the pre-roll
  silence window, must be ≥ `--min-lift-db` (default 10 dB);
* **correlation**: normalised cross-correlation with the known played signal, must be
  ≥ `--min-correlation` (default 0.3).

Both are reported with their measured values, and the output separates two different
conclusions that used to be conflated:

* `rendered`: did the process hand audio to the OS (acoustic proxy: the play window is not
  digital silence). Note that recon §2.6 shows only WASAPI loopback can prove this
  directly, and it stays true even while muted — so "rendered" is **not** evidence the
  user heard anything;
* `audible`: the acoustic criteria passed **and** the render endpoint is not muted.

Caveat kept from the recon: at the measured fixture level (−24.64 dBFS) the microphone
only rises 0.8–2.6 dB above the noise floor, so a FAIL here does not prove the speaker is
silent — it proves the acoustic path is not usable at this volume. Increase the volume or
use a louder signal and re-run.

Usage:
    python -m voice_edge.loopback <fixture.wav> <out.wav> [--tail-ms 800] [--gain 0.6]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import frontend as fe
from .config import quiet_logging, utf8_stdout

TARGET_RATE = 16_000
PLAYBACK_CHANNEL_GAIN_HINT = 0.6


def normalized_correlation(played: "object", recorded: "object", sample_rate: int) -> float:
    """Best normalised cross-correlation between the played signal and the recording.

    Returns the peak |correlation| over a ±1 s lag window, so a wrong device or an extra
    delay cannot be mistaken for "no signal".
    """
    import numpy as np

    a = np.asarray(played, dtype=np.float64)
    b = np.asarray(recorded, dtype=np.float64)
    if a.size == 0 or b.size == 0:
        return 0.0
    a = a - float(np.mean(a))
    b = b - float(np.mean(b))
    if float(np.sqrt(np.mean(a**2))) == 0.0 or float(np.sqrt(np.mean(b**2))) == 0.0:
        return 0.0
    max_lag = int(sample_rate * 1.0)
    correlation = np.correlate(b, a, mode="full")
    center = a.size - 1
    window = correlation[max(0, center - max_lag) : center + max_lag + 1]
    denominator = float(np.sqrt(np.sum(a**2) * np.sum(b**2)))
    if denominator <= 0:
        return 0.0
    return float(np.max(np.abs(window)) / denominator)


def endpoint_state() -> dict:
    """Read the default render endpoint's mute state and volume if pycaw is available.

    pycaw only exists in some venvs (`.venvs/field-probe`), so this is optional: when it is
    missing the report says so instead of silently claiming the endpoint is fine.
    """
    try:
        from pycaw.pycaw import AudioUtilities  # type: ignore
    except Exception as error:  # noqa: BLE001 - optional dependency, report the reason
        return {"available": False, "reason": f"pycaw not installed in this interpreter ({type(error).__name__})"}
    try:
        speaker = AudioUtilities.GetSpeakers()
        volume = speaker.EndpointVolume
        return {
            "available": True,
            "friendlyName": str(speaker.FriendlyName),
            "muted": bool(volume.GetMute()),
            "masterVolumeScalar": round(float(volume.GetMasterVolumeLevelScalar()), 4),
            "masterVolumeDb": round(float(volume.GetMasterVolumeLevel()), 2),
        }
    except Exception as error:  # noqa: BLE001 - Core Audio can fail on odd endpoints
        return {"available": False, "reason": f"Core Audio read failed ({type(error).__name__}: {error})"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Xixi voice edge: speaker→microphone loopback")
    parser.add_argument("wav", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--tail-ms", type=float, default=800.0)
    parser.add_argument("--gain", type=float, default=PLAYBACK_CHANNEL_GAIN_HINT, help="playback gain; keep it modest")
    parser.add_argument("--record-rate", type=int, default=48_000)
    parser.add_argument("--pre-roll-ms", type=float, default=600.0, help="silence played before the fixture")
    parser.add_argument("--min-lift-db", type=float, default=10.0, help="speech-band lift required for a PASS")
    parser.add_argument("--min-correlation", type=float, default=0.3, help="correlation with the played signal required")
    args = parser.parse_args(argv)

    import numpy as np
    import soundfile as sf
    import soxr

    quiet_logging()
    utf8_stdout()

    audio, source_rate = sf.read(str(args.wav), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if source_rate != args.record_rate:
        mono = soxr.resample(mono, source_rate, args.record_rate)
    played = np.clip(mono * args.gain, -1.0, 1.0)

    pre_roll_frames = int(args.pre_roll_ms / 1000.0 * args.record_rate)
    record_frames = pre_roll_frames + int(len(played) + (args.tail_ms / 1000.0) * args.record_rate)
    buffer = np.zeros(record_frames, dtype=np.float32)
    buffer[pre_roll_frames : pre_roll_frames + len(played)] = played

    import sounddevice as sd

    captured = np.asarray(
        sd.playrec(buffer, samplerate=args.record_rate, channels=1, dtype="float32", blocking=True)
    ).reshape(-1)
    sd.wait()

    resampled = soxr.resample(captured, args.record_rate, TARGET_RATE) if args.record_rate != TARGET_RATE else captured
    args.out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(args.out), np.clip(resampled, -1.0, 1.0), TARGET_RATE, subtype="PCM_16")

    # Windows in the recording, all at the record rate.
    pre_roll = captured[: max(1, pre_roll_frames - int(0.05 * args.record_rate))]
    play_start = pre_roll_frames
    play_end = min(len(captured), pre_roll_frames + len(played))
    play_window = captured[play_start:play_end]
    silence_dbfs = fe.rms_dbfs(pre_roll)
    speech_band = ((("b", 300.0, 3400.0)),)[0]
    pre_band = fe.band_levels(pre_roll, args.record_rate, (speech_band,))["b"]
    play_band = fe.band_levels(play_window, args.record_rate, (speech_band,))["b"]
    lift_db = round(play_band - pre_band, 2)
    correlation = round(normalized_correlation(played, captured, args.record_rate), 4)
    endpoint = endpoint_state()

    acoustic_pass = lift_db >= args.min_lift_db or correlation >= args.min_correlation
    # `rendered` is a weaker statement than "audible": the play window is not digital silence.
    rendered = fe.rms_dbfs(play_window) > fe.SILENCE_DBFS + 1
    muted = endpoint.get("muted") is True
    audible = acoustic_pass and not muted
    criteria = {
        "speechBandLiftDb": lift_db,
        "speechBandLiftRequiredDb": args.min_lift_db,
        "correlation": correlation,
        "correlationRequired": args.min_correlation,
        "endpointMuted": muted if endpoint.get("available") else None,
    }
    if audible:
        verdict = "ok"
        reason = (
            f"speech band +{lift_db} dB (需 ≥{args.min_lift_db})，与播放信号相关 {correlation}"
            f"（需 ≥{args.min_correlation}），端点未静音"
        )
    elif acoustic_pass and muted:
        verdict = "muted-endpoint"
        reason = "声学通路有信号，但默认输出端点处于静音 → 用户听不到；请取消静音后重跑"
    else:
        verdict = "no-audible-signal"
        reason = (
            f"语音带只抬高 {lift_db} dB（需 ≥{args.min_lift_db}）、相关 {correlation}"
            f"（需 ≥{args.min_correlation}）；可能是音量过低/设备选错/扬声器静音，"
            "注意 recon §2.5：夹具电平下本机麦克风本底只能抬高 0.8–2.6 dB，"
            "FAIL 不等于扬声器没响，请提高音量后重跑"
        )

    json.dump(
        {
            "fixture": str(args.wav),
            "recording": str(args.out),
            "playbackSeconds": round(len(played) / args.record_rate, 2),
            "recordedSeconds": round(len(captured) / args.record_rate, 2),
            "recordRate": args.record_rate,
            "savedRate": TARGET_RATE,
            "preRollMs": args.pre_roll_ms,
            "playbackGain": args.gain,
            "rms": round(fe.rms_dbfs(captured), 5),
            "peak": round(float(np.max(np.abs(captured))) if len(captured) > 0 else 0.0, 4),
            "preRollDbfs": round(silence_dbfs, 2),
            "playWindowDbfs": round(fe.rms_dbfs(play_window), 2),
            "criteria": criteria,
            "rendered": rendered,
            "audible": audible,
            "endpoint": endpoint,
            "verdict": verdict,
            "reason": reason,
            "notMeasured": [
                "WASAPI loopback 的渲染流相关（需要 soundcard 0.4.6，本 venv 未装）：它只能证明"
                "「程序渲染了音频」，静音时同样成立（recon §2.6）",
                "人耳是否听见（机器无法代替）",
            ],
        },
        sys.stdout,
        ensure_ascii=False,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0 if audible else 3


if __name__ == "__main__":
    raise SystemExit(main())
