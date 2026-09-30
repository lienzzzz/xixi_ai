"""Noise fixture generator: Chinese fixtures + measured machine noise at known in-band SNR.

The noise is **not synthetic white noise**: it is the real 5 s ambient recording from
this machine (`data/recon/ambient-5s.wav`, t1 recon §1.2), shaped exactly like the front
end shapes audio. That makes the fixtures an honest stand-in for "the user talks into
this microphone in this room" instead of a textbook SNR sweep.

Mix definition (the number written into `tests/audio-fixtures/noisy/manifest.json`):

    SNR_inband = 10*log10(P_clean(300-3400 Hz) / P_noise(300-3400 Hz))

measured *after* the front-end conditioning (DC removal + high-pass), because that is
the signal the VAD actually sees. Each clip is

    [ speech + noise (full length) ][ noise-only reference (same scale) ]

so the noise runs *under* the speech — the VAD sees the floor during speech, which is what
"noisy microphone" means — while the trailing noise-only segment gives a reference window
that is real room noise rather than attenuated speech, and lets the verifier measure the
floor of a noisy clip without knowing the clean signal. The scale factor is solved to
convergence (3 iterations) instead of assumed, since the high-pass has a passband ripple.

Usage:
    python -m voice_edge.make_noise_fixtures [--snr 18,6,0,-6] [--highpass 120] [--force]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from . import frontend as fe

#: The Chinese fixtures and what a real user/TV says — kept in sync with
#: `scripts/make-audio-fixtures.ts` (the ids are the file stems).
FIXTURE_META: dict[str, dict[str, str]] = {
    "direct-question": {"text": "西西，明天天气怎么样？", "speaker": "father, direct address"},
    "followup-turn": {"text": "对了，还有个事想问你。", "speaker": "father, continuation"},
    "backchannel": {"text": "嗯。", "speaker": "father, backchannel"},
    "longer-turn": {"text": "我明天下午去镇上办点事，可能要到晚上才回来。", "speaker": "father, long utterance"},
    "tv-dialogue": {"text": "明天天气怎么样？", "speaker": "television audio"},
}

#: Fixtures measured by `scripts/verify-voice-noise.ts` by default. `backchannel.wav` is
#: in the directory but out of that set: Silero cannot see 「嗯。」 at all (voice.md §2), so
#: scoring it would measure a known, documented limitation instead of the noise response.
DEFAULT_MEASURED = ("direct-question", "followup-turn", "longer-turn", "tv-dialogue")

#: SNR tiers generated. The 3 dB step matters: the measured success boundary sits inside
#: 0–6 dB, so a grid without it would only bracket the boundary, not locate it.
DEFAULT_SNR_STEPS = (18.0, 9.0, 6.0, 3.0, 0.0, -6.0)
LEAD_PAD_MS = 150.0
TAIL_PAD_MS = 500.0
TRIM_THRESHOLD_DBFS = -60.0
TARGET_RATE = 16_000


def load_mono_16k(path: Path, sample_rate: int = TARGET_RATE) -> np.ndarray:
    import soundfile as sf

    audio, source_rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1).astype(np.float64)
    if source_rate != sample_rate:
        import soxr  # noqa: PLC0415 - optional resampler, only needed off-rate

        mono = soxr.resample(mono, source_rate, sample_rate)
    return mono


def trim_silence(samples: np.ndarray, sample_rate: int, threshold_dbfs: float = TRIM_THRESHOLD_DBFS) -> np.ndarray:
    """Strip leading/trailing near-silence so the speech starts at t=0.

    The generated fixtures carry a TTS padding tail (`make-audio-fixtures.ts` pads 600 ms)
    and sometimes leading room tone; leaving it in would make every entry run through a
    long, quiet prefix and dilute the SNR measurement.
    """
    frame = max(fe.MIN_FRAME_SAMPLES, int(sample_rate * 0.01))
    count = samples.size // frame
    if count == 0:
        return samples
    frames = samples[: count * frame].reshape(count, frame)
    levels = 20.0 * np.log10(np.maximum(np.sqrt(np.mean(frames**2, axis=1)), 1e-12))
    active = np.nonzero(levels > threshold_dbfs)[0]
    if active.size == 0:
        return samples
    start = int(active[0]) * frame
    end = min(samples.size, (int(active[-1]) + 1) * frame)
    return samples[start:end]


def scale_noise_to_snr(
    clean: np.ndarray,
    noise_segment: np.ndarray,
    sample_rate: int,
    target_snr_db: float,
    highpass_hz: float,
    band: tuple[float, float] = fe.SPEECH_BAND_HZ,
    iterations: int = 3,
) -> tuple[np.ndarray, float, float, float]:
    """Solve the noise gain so the conditioned mix hits `target_snr_db` in-band.

    Returns `(scaled_noise, clean_band_level_dbfs, achieved_snr_db, scale)`. The iteration
    exists because the high-pass has a passband ripple: scaling the noise does not move the
    measured in-band level by exactly the same dB, so a fixed-point correction (3 rounds,
    converges to <0.01 dB here) is used instead of a one-shot ratio.
    """
    conditioned_clean = fe.condition(clean, sample_rate, highpass_hz)
    band_only = ((f"band", band[0], band[1]),)
    clean_band_level = fe.band_levels(conditioned_clean, sample_rate, band_only)["band"]
    if clean_band_level <= fe.SILENCE_DBFS + 1:
        raise ValueError("clean signal has no measurable speech-band energy; cannot define an SNR")

    scale = 1.0
    achieved = -np.inf
    for _ in range(max(1, iterations)):
        noise_band_level = fe.band_levels(fe.condition(noise_segment * scale, sample_rate, highpass_hz), sample_rate, band_only)["band"]
        achieved = float(clean_band_level - noise_band_level)
        scale *= 10.0 ** ((achieved - target_snr_db) / 20.0)
    scaled_noise = noise_segment * scale
    noise_band_level = fe.band_levels(fe.condition(scaled_noise, sample_rate, highpass_hz), sample_rate, band_only)["band"]
    return scaled_noise, float(clean_band_level), float(clean_band_level - noise_band_level), float(scale)


def build_clip(clean: np.ndarray, noise: np.ndarray, sample_rate: int, target_snr_db: float, highpass_hz: float) -> tuple[np.ndarray, dict]:
    """One noisy take: speech with noise under it, then a noise-only reference segment.

    Layout: ``[speech + noise][noise-only]``. The first part is what the VAD/ASR see; the
    second lets the measurement read the *same* noise floor without needing the clean
    signal, and is where `noise_floor_dbfs` of a noisy clip gets measured.
    """
    clip_samples = clean.size
    if noise.size < clip_samples:
        # Loop the ambient recording so the noise is present for the whole clip; the
        # reference segment is a trailing copy at the identical scale.
        repeats = int(np.ceil(clip_samples / noise.size))
        noise = np.tile(noise, repeats)
    noise_segment = noise[:clip_samples]

    scaled_noise, clean_band_level, achieved, scale = scale_noise_to_snr(
        clean, noise_segment, sample_rate, target_snr_db, highpass_hz
    )
    mixed = clean + scaled_noise
    conditioned = fe.condition(np.concatenate((mixed, scaled_noise)), sample_rate, highpass_hz)
    conditioned = np.clip(conditioned, -1.0, 1.0)
    detail = {
        "targetSnrDb": target_snr_db,
        "measuredSnrDb": round(achieved, 2),
        "snrBandHz": [fe.SPEECH_BAND_HZ[0], fe.SPEECH_BAND_HZ[1]],
        "cleanSpeechBandDbfs": round(clean_band_level, 2),
        "noiseScale": round(scale, 5),
        "noiseReferenceSamples": int(scaled_noise.size),
        "noiseReferenceMs": round(scaled_noise.size / sample_rate * 1000.0, 1),
        "conditionedNoiseFloorDbfs": round(fe.noise_floor_dbfs(conditioned[scaled_noise.size :], sample_rate), 2),
    }
    return conditioned, detail


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate noisy Chinese speech fixtures (Xixi voice edge)")
    parser.add_argument("--fixtures", type=Path, default=None, help="clean fixture directory")
    parser.add_argument("--noise", type=Path, default=None, help="ambient noise recording")
    parser.add_argument("--out", type=Path, default=None, help="output directory")
    parser.add_argument("--snr", default=",".join(str(value) for value in DEFAULT_SNR_STEPS))
    parser.add_argument("--highpass", type=float, default=120.0, help="front-end high-pass used for the SNR definition")
    parser.add_argument("--force", action="store_true", help="overwrite existing clips")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parents[3]
    fixtures_dir = args.fixtures or repo_root / "tests" / "audio-fixtures"
    noise_path = args.noise or repo_root / "data" / "recon" / "ambient-5s.wav"
    out_dir = args.out or fixtures_dir / "noisy"
    snr_steps = [float(part) for part in str(args.snr).split(",") if part.strip()]

    if not noise_path.exists():
        print(f"ambient noise recording not found: {noise_path}", file=sys.stderr)
        return 2
    noise = trim_silence(load_mono_16k(noise_path), TARGET_RATE)
    if noise.size < TARGET_RATE:
        print("ambient noise is shorter than 1 s after trimming; cannot build a stationary reference", file=sys.stderr)
        return 2
    import soundfile as sf

    out_dir.mkdir(parents=True, exist_ok=True)
    noise_floor = fe.noise_floor_dbfs(noise, TARGET_RATE)
    clips: list[dict] = []
    failures: list[str] = []

    for fixture_id, meta in FIXTURE_META.items():
        source = fixtures_dir / f"{fixture_id}.wav"
        if not source.exists():
            failures.append(f"{fixture_id}: clean fixture missing ({source})")
            continue
        raw = load_mono_16k(source)
        clean = trim_silence(raw, TARGET_RATE)
        clean = np.concatenate(
            (
                np.zeros(int(TARGET_RATE * LEAD_PAD_MS / 1000.0)),
                clean,
                np.zeros(int(TARGET_RATE * TAIL_PAD_MS / 1000.0)),
            )
        )
        for target in snr_steps:
            target_path = out_dir / f"{fixture_id}-snr{int(round(target))}db.wav"
            if target_path.exists() and not args.force:
                clips.append({"id": f"{fixture_id}-snr{int(round(target))}db", "skipped": True, "path": str(target_path)})
                continue
            mixed, detail = build_clip(clean, noise, TARGET_RATE, target, args.highpass)
            sf.write(str(target_path), mixed.astype(np.float32), TARGET_RATE, subtype="PCM_16")
            clips.append(
                {
                    "id": f"{fixture_id}-snr{int(round(target))}db",
                    "fixture": fixture_id,
                    "text": meta["text"],
                    "speaker": meta["speaker"],
                    "path": f"tests/audio-fixtures/noisy/{target_path.name}",
                    "bytes": target_path.stat().st_size,
                    "durationMs": round(mixed.size / TARGET_RATE * 1000.0, 1),
                    "sourceDurationMs": round(raw.size / TARGET_RATE * 1000.0, 1),
                    **detail,
                }
            )

    manifest = {
        "generator": "services/voice-edge/voice_edge/make_noise_fixtures.py",
        "regenerate": "E:\\worker2\\.venvs\\voice-pipecat\\Scripts\\python.exe -m voice_edge.make_noise_fixtures --force",
        "snrDefinition": (
            "SNR_inband = 10*log10(P_speech(300-3400 Hz) / P_noise(300-3400 Hz)), measured after "
            "front-end conditioning (DC removal + high-pass), speech and noise measured as separate segments"
        ),
        "noiseSource": {
            "path": "data/recon/ambient-5s.wav",
            "what": "5 s real ambient recording on this machine (t1 recon §1.2)",
            "rmsDbfs": round(fe.rms_dbfs(noise), 2),
            "noiseFloorDbfs": round(noise_floor, 2),
            "bandPowerShare": fe.band_power_share(fe.band_levels(noise, TARGET_RATE)),
        },
        "frontendHighpassHzForDefinitions": args.highpass,
        "leadPadMs": LEAD_PAD_MS,
        "tailPadMs": TAIL_PAD_MS,
        "trimThresholdDbfs": TRIM_THRESHOLD_DBFS,
        "snrStepsDb": snr_steps,
        "measuredByDefault": list(DEFAULT_MEASURED),
        "clips": clips,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {
        "outputDir": str(out_dir),
        "clips": len([clip for clip in clips if not clip.get("skipped")]),
        "skipped": len([clip for clip in clips if clip.get("skipped")]),
        "snrStepsDb": snr_steps,
        "measuredSnrDb": sorted({clip.get("measuredSnrDb") for clip in clips if "measuredSnrDb" in clip}),
        "failures": failures,
    }
    json.dump(summary, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
