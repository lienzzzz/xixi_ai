"""Noise-floor calibration: record N seconds of room noise, print the parameters to use.

Output is one JSON object on stdout (and optionally on disk) containing the per-band
energy of the recording and the **derived** front-end parameters, so the numbers that
`voice_edge.segment` and `scripts/serve-chat.ts` use come from a measurement of *this*
microphone in *this* room rather than from a constant baked into the code.

Two modes:

* live capture (default) — needs a recording backend (`sounddevice`). The pipecat venv
  does not ship it; `.venvs/field-probe` and `.venvs/voice-livekit` do:
  `E:\\worker2\\.venvs\\field-probe\\Scripts\\python.exe -m voice_edge.calibrate`
* `--wav <file.wav>` — analyse an existing recording (e.g. `data/recon/ambient-5s.wav`),
  which works in every venv and is what the offline regression uses.

Usage:
    python -m voice_edge.calibrate                      # 3 s from the default input
    python -m voice_edge.calibrate --seconds 5 --device 9
    python -m voice_edge.calibrate --wav data/recon/ambient-5s.wav
    python -m voice_edge.calibrate --json-out data/voice/noise-floor.json --profile-out data/voice/frontend-profile.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import frontend as fe
from .config import BASELINE, utf8_stdout

TARGET_RATE = 16_000

#: Host APIs in preference order. WASAPI is first because the recon measured a 43 ms
#: round trip against MME's 230 ms on this machine (recon §2.3) — the same reason the
#: live capture path should prefer it.
HOST_API_PREFERENCE = ("Windows WASAPI", "MME", "Windows DirectSound", "Windows WDM-KS")


def list_input_devices(sample_rate: int = TARGET_RATE) -> list[dict]:
    """Input devices, best candidate first (WASAPI > MME > others)."""
    import sounddevice as sd

    host_apis = {index: name for index, name in enumerate(sd.query_hostapis())}
    devices: list[dict] = []
    for index, device in enumerate(sd.query_devices()):
        if int(device["max_input_channels"]) < 1:
            continue
        api = host_apis.get(int(device["hostapi"]), "?")
        supported = True
        try:
            sd.check_input_settings(device=index, channels=1, samplerate=sample_rate, dtype="float32")
        except Exception:  # noqa: BLE001 - PortAudio raises a plain Exception subclass
            supported = False
        rank = HOST_API_PREFERENCE.index(api) if api in HOST_API_PREFERENCE else len(HOST_API_PREFERENCE)
        devices.append(
            {
                "index": index,
                "name": str(device["name"]),
                "hostApi": api,
                "maxInputChannels": int(device["max_input_channels"]),
                "defaultSampleRate": float(device["default_samplerate"]),
                "supportsTargetRate": supported,
                "rank": rank,
            }
        )
    devices.sort(key=lambda item: (not item["supportsTargetRate"], item["rank"], item["index"]))
    return devices


def name_of(host_api: str) -> str:
    """PortAudio host API names are compared verbatim; kept so callers can normalise later."""
    return host_api


def record(seconds: float, device: int | None, sample_rate: int, channels: int = 1) -> tuple[np.ndarray, dict]:
    """Capture `seconds` of 16 kHz mono float32 from the microphone."""
    import sounddevice as sd

    frames = int(round(seconds * sample_rate))
    # Prefer WASAPI when the caller did not pin a device: it is the low-latency path on
    # this machine and avoids MME's extra resampling.
    chosen = device
    chosen_info: dict | None = None
    if chosen is None:
        candidates = list_input_devices(sample_rate)
        if not candidates:
            raise RuntimeError("no input device found")
        chosen = int(candidates[0]["index"])
        chosen_info = candidates[0]
    recording = sd.rec(frames, samplerate=sample_rate, channels=channels, dtype="float32", device=chosen)
    sd.wait()
    data = np.asarray(recording, dtype=np.float64)
    mono = data.mean(axis=1) if data.ndim > 1 else data.reshape(-1)
    info = {
        "device": chosen,
        "resolvedDevice": chosen_info,
        "deviceName": str(sd.query_devices(chosen)["name"]),
        "hostApi": str(sd.query_hostapis(int(sd.query_devices(chosen)["hostapi"]))["name"]),
        "channels": channels,
        "sampleRate": sample_rate,
        "requestedSeconds": seconds,
        "recordedSeconds": round(mono.size / sample_rate, 3),
        "dropped": bool(np.all(mono == 0)),
    }
    return mono, info


def analyze(samples: np.ndarray, sample_rate: int) -> dict:
    """The published report: measurement + parameters + the measured effect of the parameters."""
    report = fe.calibrate_from_samples(samples, sample_rate, stop_secs=BASELINE.stop_secs)
    params = report["parameters"]
    report["params"] = params.to_dict()
    report.pop("parameters")
    # Field names the console/UI contract uses (app-engineer t4 reads these).
    report["params"]["highpassHz"] = params.highpass_hz
    report["params"]["gateThresholdDbfs"] = params.gate_threshold_dbfs
    report["params"]["gateMarginDb"] = params.gate_margin_db
    report["params"]["suggestedCaptureGainDb"] = params.suggested_capture_gain_db
    report["measuredEffect"]["highpassOnRumbleDb"] = report["measuredEffect"]["highpassWidebandRmsReductionDb"]
    report["measuredEffect"]["noiseReductionOnFloorDb"] = report["measuredEffect"]["noiseReductionFloorReductionDb"]
    return report


def calibrate(
    samples: np.ndarray,
    sample_rate: int,
    device_info: dict | None = None,
    source: str = "microphone",
) -> dict:
    """Full calibration record: measurement, parameters and warnings."""
    result = analyze(samples, sample_rate)
    result["source"] = source
    result["capturedAt"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    if device_info is not None:
        result["device"] = device_info
    if device_info is not None and device_info.get("dropped"):
        result["warnings"] = [
            "capture is all zeros — the microphone is muted, the wrong device is selected, or the "
            "Windows capture level is 0; do not trust these parameters"
        ]
    elif result["noiseFloorDbfs"] > -20.0:
        result["warnings"] = [
            "noise floor above −20 dBFS: if this was recorded while someone was talking, recalibrate "
            "in silence — the floor estimate is contaminated"
        ]
    return result


def profile(params: dict, calibration: dict) -> dict:
    """The compact object the Node side can read without parsing the whole report."""
    return {
        "generatedFrom": "voice_edge.calibrate",
        "capturedAt": calibration.get("capturedAt"),
        "source": calibration.get("source"),
        "noiseFloorDbfs": calibration["noiseFloorDbfs"],
        "lowFrequencyShare": calibration["lowFrequencyShare"],
        "params": params,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Xixi voice edge: noise-floor calibration")
    parser.add_argument("--seconds", type=float, default=3.0, help="capture length for live mode")
    parser.add_argument("--device", type=int, default=None, help="PortAudio index; default = best-ranked input")
    parser.add_argument("--sample-rate", type=int, default=TARGET_RATE)
    parser.add_argument("--wav", type=Path, default=None, help="analyse an existing recording instead of capturing")
    parser.add_argument("--json-out", type=Path, default=None, help="also write the report here")
    parser.add_argument("--profile-out", type=Path, default=None, help="write the compact params file here")
    parser.add_argument("--list-devices", action="store_true", help="print input devices and exit")
    args = parser.parse_args(argv)

    utf8_stdout()

    if args.list_devices:
        try:
            json.dump(list_input_devices(args.sample_rate), sys.stdout, ensure_ascii=False, indent=2)
        except Exception as error:  # noqa: BLE001 - report the backend problem, do not traceback
            print(f"cannot enumerate devices: {error}", file=sys.stderr)
            return 3
        sys.stdout.write("\n")
        return 0

    if args.wav is not None:
        from .segment import load_mono_16k

        pcm, rate = load_mono_16k(args.wav, args.sample_rate)
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float64) / 32768.0
        report = calibrate(samples, rate, None, source=f"wav:{args.wav}")
    else:
        try:
            samples, device_info = record(args.seconds, args.device, args.sample_rate)
        except ImportError:
            print(
                "the live capture backend is missing in this interpreter: use a venv with sounddevice "
                "(.venvs/field-probe) or pass --wav <recording.wav>",
                file=sys.stderr,
            )
            return 3
        except Exception as error:  # noqa: BLE001 - device errors must be actionable, not tracebacks
            print(f"capture failed: {error}", file=sys.stderr)
            return 3
        report = calibrate(samples, args.sample_rate, device_info, source="microphone")

    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    sys.stdout.write(text)
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text, encoding="utf-8")
    if args.profile_out is not None:
        args.profile_out.parent.mkdir(parents=True, exist_ok=True)
        args.profile_out.write_text(
            json.dumps(profile(report["params"], report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
