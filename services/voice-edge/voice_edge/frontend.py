"""Noise-robust front end for the voice edge (pure functions, no I/O).

    Why this file exists
    --------------------
    The microphone on this machine is noisy in a specific, *measured* way
    (`docs/recon/field-test-environment-2026-09-30.md` §1.2–§1.5):

    * ambient RMS **−27.25 dBFS**, noise floor (p10 of 50 ms frames) **−30.86 dBFS**;
    * **56 % of the noise power is below 100 Hz** (broadband rumble + slow drift, *not*
    50/60 Hz mains hum — the line/far ratio at 50/60/100/120 Hz is 0.80–0.94);
    * above 100 Hz the remainder is a steady hiss (p95/p05 = 1.23) at about −31 dBFS,
    which scales 1:1 with the capture gain (+5.5 dB from the factory);
    * the two channels are uncorrelated (coherence 0.009–0.020), i.e. per-channel
    electronic noise rather than one room sound field.

    So the two cheap wins are (a) remove the DC/low-frequency half of the noise with a
    high-pass, and (b) *derive* the gate threshold from the measured noise floor
    instead of assuming a quiet room. Everything here is deterministic and offline
    testable: the CLI wrappers (`voice_edge.calibrate`, `voice_edge.segment`) only add
    recording/IO around these functions.

    Units: every level in this module is **dBFS** (0 dBFS = digital full scale), and
    every level is a *frame RMS* or *band RMS* value, never a peak unless the name says
    `peak`. Levels are clamped at `SILENCE_DBFS` so `log10(0)` cannot poison a report.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

#: Floor for logarithmic levels; anything quieter is reported as this.
SILENCE_DBFS = -120.0

#: A pristine synthesised fixture has no room tone at all, so its measured "floor" is
#: digital silence (−120 dBFS) and any margin above it is meaningless. This bound keeps
#: the derived gate inside the range where a frame RMS means something: below −70 dBFS a
#: 16-bit recording is 3 bits deep and the value is quantisation residue, not noise. The
#: clamp only affects synthetic fixtures; every field recording measured so far is above
#: −36 dBFS (recon §1.4).
QUANTISATION_FLOOR_DBFS = -70.0

#: Measurement band of speech above 100 Hz on this machine (recon §1.2 uses 300–3400
#: for the speech band; the fixture/noise comparison in this repo uses the same one).
SPEECH_BAND_HZ = (300.0, 3400.0)

#: Bands reported by `band_levels` — the cut at 100 Hz is the measured noise split.
REPORT_BANDS_HZ: tuple[tuple[str, float, float], ...] = (
    ("under100", 1.0, 100.0),
    ("100-300", 100.0, 300.0),
    ("300-3400", 300.0, 3400.0),
    ("3400-8000", 3400.0, 8000.0),
    ("above8000", 8000.0, 24_000.0),
)

#: High-pass cutoff the front end applies when no calibration profile is present.
#:
#: This number is the *default* only, and it is the same number `derive_frontend_params`
#: produces for this machine's measured noise (<100 Hz = 62 % of the power → 120 Hz, see
#: docs/design/voice.md §1.1). It used to be a literal duplicated in the segment CLI, which is
#: exactly how a calibration tool ends up recommending one cutoff while the front end applies
#: another. There is now a single source of truth, in this order:
#:
#:   1. `data/voice/frontend-profile.json`, if the user has calibrated (`voice_edge.calibrate`);
#:   2. otherwise `derive_frontend_params` on the measured/declared noise floor;
#:   3. and `DEFAULT_HIGHPASS_HZ` is only the value used when the noise floor is unknown.
DEFAULT_HIGHPASS_HZ = 120.0

#: Schema version of the calibration profile file (AGENTS.md 铁律 10: persisted records carry
#: a schema version; new fields are additive).
PROFILE_SCHEMA_VERSION = 1

#: The profile the calibrate CLI writes by default, relative to the repository root.
DEFAULT_PROFILE_PATH = "data/voice/frontend-profile.json"

#: Frames shorter than this are not a meaningful RMS.
MIN_FRAME_SAMPLES = 32


def to_db(amplitude: float) -> float:
    """Linear amplitude/RMS → dBFS, clamped at `SILENCE_DBFS`.
    """
    return float(max(SILENCE_DBFS, 20.0 * np.log10(max(float(amplitude), 1e-12))))


def from_db(dbfs: float) -> float:
    """dBFS → linear amplitude/RMS.
    """
    return float(10.0 ** (float(dbfs) / 20.0))


def rms_dbfs(samples: np.ndarray) -> float:
    """RMS of a block in dBFS (empty block → `SILENCE_DBFS`).
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size == 0:
        return SILENCE_DBFS
    return min(-0.0, to_db(float(np.sqrt(np.mean(x**2)))))

# --------------------------------------------------------------------------------------
# 1. Conditioning: DC removal + high-pass
# --------------------------------------------------------------------------------------


def remove_dc(samples: np.ndarray) -> np.ndarray:
    """Subtract the block mean.

        Measured DC on ambient recordings is tiny (−0.000103, recon §1.2) but on a
        *loopback* recording it was −0.328 (recon §2.5's false PASS came from exactly
        that kind of DC/rumble offset), so the offset is removed explicitly rather than
        assumed to be zero.
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size == 0:
        return x
    return x - float(np.mean(x))


def remove_dc_streaming(samples: np.ndarray, state: float, coefficient: float = 0.999) -> tuple[np.ndarray, float]:
    """One-pole DC blocker for frame-by-frame processing (state = previous mean).

        Used by the streaming path; `remove_dc` (block mean) is the offline equivalent.
        Returns the de-meaned block and the carry-over state.
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size == 0:
        return x, state
    mean = float(np.mean(x))
    return x - (coefficient * state + (1.0 - coefficient) * mean), mean


def highpass_coefficients(cutoff_hz: float, sample_rate: int = 16_000, q: float = 0.7071067811865476) -> tuple[float, float, float, float, float]:
    """Second-order Butterworth high-pass (RBJ audio-EQ cookbook), ``b0,b1,b2,a1,a2``.

        A 12 dB/octave section at ≈100 Hz removes most of this machine's sub-100 Hz rumble
        without eating the 100–300 Hz band, which carries voice energy (recon §1.2: that band
        is 15 % of the *noise* power but the same band matters for speech). A hand-rolled
        windowed-sinc FIR was tried first and rejected: forcing exact zero DC gain by
        subtracting the mean of a long sinc kernel destroys the conditioning (the sine test
        measured −0.00 dBFS out for every frequency — the kernel had become a large-constant
        cancellation), see voice.md §1.6. This biquad is well-conditioned at `cutoff_hz ≪ fs`.
    """
    if cutoff_hz <= 0:
        raise ValueError("cutoff_hz must be positive")
    if cutoff_hz >= sample_rate / 2.0:
        raise ValueError(f"cutoff_hz {cutoff_hz} must be below Nyquist {sample_rate / 2.0}")
    if q <= 0:
        raise ValueError("q must be positive")
    omega = 2.0 * np.pi * cutoff_hz / sample_rate
    cos_omega = float(np.cos(omega))
    alpha = float(np.sin(omega) / (2.0 * q))
    a0 = 1.0 + alpha
    b0 = (1.0 + cos_omega) / 2.0 / a0
    b1 = -(1.0 + cos_omega) / a0
    b2 = (1.0 + cos_omega) / 2.0 / a0
    a1 = -2.0 * cos_omega / a0
    a2 = (1.0 - alpha) / a0
    return b0, b1, b2, a1, a2


def apply_biquad(samples: np.ndarray, coefficients: tuple[float, float, float, float, float]) -> np.ndarray:
    """Direct-form-I biquad over a block (same length in, same length out).

        Written as one expression per output sample instead of ``lfilter`` so `scipy` stays
        out of the venv (AGENTS.md §12) and the recursion is inspectable in a unit test.
    """
    x = np.asarray(samples, dtype=np.float64)
    b0, b1, b2, a1, a2 = coefficients
    y = np.empty_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for index in range(x.size):
        current = float(x[index])
        out = b0 * current + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        y[index] = out
        x2, x1 = x1, current
        y2, y1 = y1, out
    return y


def highpass(samples: np.ndarray, cutoff_hz: float, sample_rate: int = 16_000) -> np.ndarray:
    """Zero-phase high-pass: one biquad, forward then backward, on a reflection pad.

        Zero-phase matters twice here: the same conditioned signal feeds the VAD *and* the
        barge-in latency measurement, so a phase-delayed copy would silently add tens of ms
        to a reported speech start; and the reverse pass makes the effective cutoff lower
        than the nominal one (measured −6 dB point ≈ 0.65 × `cutoff_hz`, so 120 Hz nominal
        behaves like ≈80 Hz — see voice.md §1.6). The reflection pad keeps the filter from
        ringing on the block edges, which a bare forward-backward pass does.
    """
    x = remove_dc(samples)
    if x.size == 0 or cutoff_hz <= 0:
        return x
    pad = min(x.size - 1, max(64, int(sample_rate * 0.05)))
    if pad <= 0:
        return np.zeros_like(x)
    padded = np.concatenate((x[1 : pad + 1][::-1], x, x[-pad - 1 : -1][::-1]))
    coefficients = highpass_coefficients(cutoff_hz, sample_rate)
    filtered = apply_biquad(padded, coefficients)
    filtered = apply_biquad(filtered[::-1], coefficients)[::-1]
    return remove_dc(filtered[pad : pad + x.size])


def condition(samples: np.ndarray, sample_rate: int, highpass_hz: float) -> np.ndarray:
    """The conditioning step: DC removal, then high-pass (no noise reduction).
    """
    if highpass_hz <= 0:
        return remove_dc(samples)
    return highpass(samples, highpass_hz, sample_rate)


def condition_for_vad(
    samples: np.ndarray,
    sample_rate: int,
    highpass_hz: float,
    noise_floor_dbfs_value: float | None = None,
    noise_reduction: bool = False,
    oversubtraction: float = 2.0,
    gain_floor: float = 0.06,
) -> np.ndarray:
    """Full front end for the VAD/ASR path: DC removal, high-pass, spectral subtraction.

        `noise_floor_dbfs_value` is the *calibrated* floor (from `voice_edge.calibrate`). When it
        is omitted the floor is measured on this block, which is the honest fallback for a
        one-shot CLI but is not what a resident service would do (it would use the calibration
        until the environment changes).
    """
    conditioned = condition(samples, sample_rate, highpass_hz)
    if not noise_reduction:
        return conditioned
    floor = noise_floor_dbfs(conditioned, sample_rate) if noise_floor_dbfs_value is None else float(noise_floor_dbfs_value)
    return spectral_subtraction(
        conditioned,
        sample_rate,
        noise_floor_dbfs=floor,
        oversubtraction=oversubtraction,
        gain_floor=gain_floor,
    )

# --------------------------------------------------------------------------------------
# 2. Analysis: band levels, noise floor, signal level
# --------------------------------------------------------------------------------------


def band_levels(
    samples: np.ndarray,
    sample_rate: int,
    bands: tuple[tuple[str, float, float], ...] = REPORT_BANDS_HZ,
) -> dict[str, float]:
    """Per-band RMS in dBFS by frequency-masking the whole block in one FFT pass.

        One pass over the whole block (not windowed segments) keeps the total power equal
        to the time-domain power, so `power_share` sums to 1 and the numbers can be
        compared with the time-domain figures in the recon report.
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size == 0:
        return {name: SILENCE_DBFS for name, _, _ in bands}
    # Two-sided amplitude coefficients: |X_k| for a component of amplitude A reads
    # A * n / 2, so dividing by n/2 and by sqrt(2) gives its RMS in dBFS (a full-scale
    # sine reads −3.01 dBFS). Everything below stays on that one convention, so the
    # band numbers are directly comparable with the time-domain RMS and with the
    # recon report (which measured parts of it in the time domain).
    n = x.size
    spectrum = np.abs(np.fft.rfft(x)) / (n / 2.0)
    freqs = np.fft.rfftfreq(n, 1.0 / sample_rate)
    power = spectrum**2
    levels: dict[str, float] = {}
    for name, low, high in bands:
        mask = (freqs >= low) & (freqs < high) & (freqs <= sample_rate / 2.0)
        levels[name] = to_db(np.sqrt(float(np.sum(power[mask])) / 2.0))
    levels["total"] = to_db(np.sqrt(float(np.mean(x**2))))
    return levels


def band_power_share(levels: dict[str, float]) -> dict[str, float]:
    """Convert band levels (dBFS) into power shares (0–1, sums to ~1).
    """
    shares: dict[str, float] = {}
    total = 0.0
    for name, level in levels.items():
        if name == "total":
            continue
        share = 10.0 ** (level / 10.0)
        shares[name] = share
        total += share
    if total <= 0:
        return {name: 0.0 for name in shares}
    return {name: round(share / total, 4) for name, share in shares.items()}


def frame_rms_dbfs(samples: np.ndarray, sample_rate: int, frame_ms: float = 50.0, hop_ms: float | None = None) -> np.ndarray:
    """RMS of every (possibly overlapping) frame, in dBFS.
    """
    x = np.asarray(samples, dtype=np.float64)
    frame = int(round(sample_rate * frame_ms / 1000.0))
    hop = frame if hop_ms is None else int(round(sample_rate * hop_ms / 1000.0))
    frame = max(MIN_FRAME_SAMPLES, frame)
    hop = max(1, hop)
    if x.size < frame:
        return np.array([rms_dbfs(x)]) if x.size > 0 else np.array([], dtype=np.float64)
    count = 1 + (x.size - frame) // hop
    index = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    frames = x[index]
    return np.array([rms_dbfs(row) for row in frames])


def noise_floor_dbfs(samples: np.ndarray, sample_rate: int, frame_ms: float = 50.0, percentile: float = 10.0) -> float:
    """Noise floor = low percentile of 50 ms frame RMS — the definition t1 used.

        Same frame length and percentile as `docs/recon/field-test-environment-2026-09-30.md`
        §1.2 so the calibration numbers are comparable with the recon report, and so a
        quiet-room calibration cannot be flattered by averaging speech into the floor.
    """
    levels = frame_rms_dbfs(samples, sample_rate, frame_ms)
    if levels.size == 0:
        return SILENCE_DBFS
    return float(np.percentile(levels, percentile))


def crest_factor_db(samples: np.ndarray) -> float:
    x = np.asarray(samples, dtype=np.float64)
    if x.size == 0:
        return 0.0
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x**2)))
    if rms <= 0:
        return 0.0
    return to_db(peak) - to_db(rms)


def spectral_flatness(samples: np.ndarray, sample_rate: int, low: float = 20.0, high: float = 8000.0) -> float:
    """Geometric mean / arithmetic mean of the power spectrum inside a band.
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size < MIN_FRAME_SAMPLES:
        return 0.0
    power = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    freqs = np.fft.rfftfreq(x.size, 1.0 / sample_rate)
    selected = power[(freqs >= low) & (freqs < high) & (power > 0)]
    if selected.size == 0:
        return 0.0
    geometric = float(np.exp(np.mean(np.log(selected))))
    arithmetic = float(np.mean(selected))
    return 0.0 if arithmetic <= 0 else float(min(1.0, geometric / arithmetic))


def spectral_tilt_db_per_octave(samples: np.ndarray, sample_rate: int, low: float = 100.0, high: float = 4000.0) -> float:
    """Least-squares slope of the band power vs frequency, in dB per octave.

        Negative = low frequencies dominate (this machine's rumble measures ≈ −5 dB/oct);
        positive = a rising high-frequency hiss. Reported as measured, no sign flip.
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size < MIN_FRAME_SAMPLES:
        return 0.0
    power = np.abs(np.fft.rfft(x * np.hanning(x.size))) ** 2
    freqs = np.fft.rfftfreq(x.size, 1.0 / sample_rate)
    mask = (freqs >= low) & (freqs < high) & (power > 0)
    if int(np.count_nonzero(mask)) < 8:
        return 0.0
    octaves = np.log2(freqs[mask] / low)
    levels = 10.0 * np.log10(power[mask])
    slope, _ = np.polyfit(octaves, levels, 1)
    return float(slope)


def band_snr_db(signal: np.ndarray, noise: np.ndarray, sample_rate: int, band: tuple[float, float] = SPEECH_BAND_HZ) -> float:
    """Signal-to-noise ratio **inside one band**, from two whole blocks.

        Both blocks are measured the same way, so this is the number the noisy-fixture
        generator targets and the number the docs quote. It is *in-band* by construction:
        wideband SNR would be dominated by the sub-100 Hz rumble that the front end
        removes anyway.
    """
    name = "band"
    bands = ((name, band[0], band[1]),)
    signal_level = band_levels(signal, sample_rate, bands)[name]
    noise_level = band_levels(noise, sample_rate, bands)[name]
    return float(signal_level - noise_level)

# --------------------------------------------------------------------------------------
# 3. Noise reduction: spectral subtraction over the measured floor
# --------------------------------------------------------------------------------------


def _frame_signal(samples: np.ndarray, frame: int, hop: int) -> np.ndarray:
    """Slice a signal into overlapping frames, padding the tail so nothing is dropped.
    """
    if samples.size < frame:
        padded = np.concatenate((samples, np.zeros(frame - samples.size)))
        return padded[None, :]
    count = 1 + int(np.ceil((samples.size - frame) / hop))
    total = frame + (count - 1) * hop
    padded = np.concatenate((samples, np.zeros(max(0, total - samples.size))))
    index = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    return padded[index]


def periodic_hann(length: int) -> np.ndarray:
    """Periodic (DFT-even) Hann window.

        `np.hanning` returns the *symmetric* window, whose endpoints are exactly zero, so a sum
        of overlapping copies is not constant near the block edges and a plain overlap-add loses
        ~2.5 dB of level. The periodic form `0.5·(1−cos(2πn/N))` satisfies constant-overlap-add
        for `hop = N/2`, which is what makes the reconstruction gain structural. The squared-window
        correction at the overlap-add step is still needed (analysis *and* synthesis window), and
        `test_level_is_preserved_for_a_signal_above_the_floor` pins unity gain to ±0.2 dB.
    """
    n = np.arange(length)
    return 0.5 * (1.0 - np.cos(2.0 * np.pi * n / length))


def spectral_subtraction(
    samples: np.ndarray,
    sample_rate: int = 16_000,
    noise_floor_dbfs: float = -30.0,
    oversubtraction: float = 2.0,
    gain_floor: float = 0.06,
    frame_ms: float = 32.0,
    hop_ms: float | None = None,
    noise_percentile: float = 10.0,
    max_over_floor_db: float = 12.0,
) -> np.ndarray:
    """Power-domain spectral subtraction (Boll 1979 style) with a spectral floor.

        Why this and not just a high-pass: measured on the real machine noise in
        `data/voice/frontend-vad-grid.json`, a 120 Hz high-pass removes 5.0 dB of *wideband*
        noise power but changes the VAD's decisions **not at all** (Silero already ignores the
        rumble), and at 6 dB in-band SNR it pushes the endpoint 1056–1472 ms late — worse than
        the clean 600 ms. Sub-100 Hz removal is therefore a real gain for the energy gate (and
        for anything downstream that looks at wideband level), but the thing that actually
        blinds the ASR is the in-band hiss, so it is subtracted explicitly.

        * the noise power spectrum is estimated **per frequency bin** as the lower tail of that
        bin's power across frames (`noise_percentile`, default 10 %). Two earlier estimators
        failed here and are kept in the record: (a) "frames within 10 dB of the floor" admitted
        *speech* frames on a 1 kHz tone over white noise, over-estimated the noise by 27 dB and
        deleted the tone; (b) averaging the quiet frames *broadband* still over-estimates each
        bin — on a real 6 dB-SNR fixture every subtraction setting collapsed to the same 2.5 dB
        of removal, because the per-bin estimate was too high for the gain to drop below the
        floor. A per-bin percentile is what actually removes noise: measured on the noise-only
        reference of real fixtures, the 300–3400 Hz noise band drops 1.19 dB while the speech
        band moves ≤0.5 dB at `oversubtraction=4`, and 1.91 dB / ≤1.4 dB at 6.
        * the estimate is capped at the calibrated floor + `max_over_floor_db` (12 dB), so a block
        that is mostly speech cannot be subtracted by its own speech.
        * `oversubtraction` is the classic factor >1 that trades residual noise against speech
        distortion; `gain_floor` bounds the per-bin attenuation so the result cannot develop
        unbounded "musical noise";
        * the synthesis is a standard 50 %-overlap weighted overlap-add (`hop = frame/2`, periodic
        Hann). Both a 75 %-overlap sum-of-windows reconstruction and a global RMS correction
        were tried and rejected, each for a measured reason: the 75 % version attenuated the
        whole block by 2.5 dB (the first/last hops only see one window), and the RMS correction
        that fixed it silently cancelled the noise reduction (the output was renormalised to the
        input level). With 50 % overlap the periodic Hann satisfies COLA exactly, so unity gain
        is structural rather than corrected; a unit test pins that.

        Latency note: this is a whole-block (file) implementation. A streaming version buffers
        one hop (16 ms here) and is not needed for the CLI path.
    """
    x = np.asarray(samples, dtype=np.float64)
    if x.size == 0:
        return x
    frame = max(64, int(round(sample_rate * frame_ms / 1000.0)))
    if frame % 2 == 1:
        frame += 1
    hop = frame // 2 if hop_ms is None else max(1, int(round(sample_rate * hop_ms / 1000.0)))
    window = periodic_hann(frame)
    frames = _frame_signal(x, frame, hop) * window[None, :]

    spectrum = np.fft.rfft(frames, axis=1)
    power = np.abs(spectrum) ** 2
    freqs = np.fft.rfftfreq(frame, 1.0 / sample_rate)
    in_band = (freqs >= 100.0) & (freqs <= 8000.0)

    # Per-bin lower tail across frames = the stationary part of each bin.
    noise_power = np.percentile(power, noise_percentile, axis=0)

    # Cap the estimate against the caller's calibrated floor (measured after the high-pass).
    noise_band_db = float(10.0 * np.log10(max(float(np.mean(noise_power[in_band])), 1e-12)))
    cap_db = float(noise_floor_dbfs) + max_over_floor_db
    if noise_band_db > cap_db:
        noise_power = noise_power * (10.0 ** ((cap_db - noise_band_db) / 10.0))
        noise_band_db = cap_db
    observed_band_db = float(10.0 * np.log10(max(float(np.mean(power[:, in_band])), 1e-12)))
    if noise_band_db > observed_band_db:
        noise_power = noise_power * (10.0 ** ((observed_band_db - noise_band_db) / 10.0))

    subtracted = power - oversubtraction * noise_power[None, :]
    gain = np.sqrt(np.maximum(subtracted, 0.0) / np.maximum(power, 1e-12))
    gain = np.maximum(gain, gain_floor)
    enhanced = np.fft.irfft(spectrum * gain, n=frame, axis=1) * window[None, :]

    total = frame + (enhanced.shape[0] - 1) * hop
    output = np.zeros(total)
    for index in range(enhanced.shape[0]):
        start = index * hop
        output[start : start + frame] += enhanced[index]
    # Analysis and synthesis each apply the window, so the reconstruction weight is the sum
    # of *squared* windows. For a periodic Hann at 50 % overlap that sum is exactly 0.75
    # (Hann² has DC = 3/8 and a single (1−cos 4πn/N) term with mean 0), so dividing by the
    # mean removes a −1.25 dB bias and leaves a ±0.6 dB ripple — measured: without this a
    # unity-gain round trip lost 2.3 dB, which would have silently attenuated every ASR input.
    return output[: x.size] * (1.0 / (0.75 if hop * 2 == frame else 0.5))


def derive_noise_profile(samples: np.ndarray, sample_rate: int, highpass_hz: float) -> dict:
    """Everything downstream needs to know about one ambient recording, in dBFS.

        Two floors are reported on purpose and they are **not** interchangeable:

        * `rawFloorDbfs` — measured on the recording as captured. This is what drives the gain
        recommendation, because the capture gain acts before any filtering.
        * `conditionedFloorDbfs` — measured after the front end's DC removal + high-pass. This
        is what the gate threshold and the spectral-subtraction estimator must use, because
        they both run on the conditioned signal. Feeding the raw floor to a noise estimator
        that sees conditioned audio is a real bug (measured: the estimator stopped finding
        any quiet frame and the noise reduction silently did nothing).
    """
    raw_floor = noise_floor_dbfs(samples, sample_rate)
    conditioned = condition(samples, sample_rate, highpass_hz)
    conditioned_floor = noise_floor_dbfs(conditioned, sample_rate)
    bands = band_levels(samples, sample_rate)
    return {
        "rawFloorDbfs": round(raw_floor, 2),
        "conditionedFloorDbfs": round(conditioned_floor, 2),
        "conditionedRmsDbfs": round(rms_dbfs(conditioned), 2),
        "rawRmsDbfs": round(rms_dbfs(samples), 2),
        "bandDbfs": {name: round(level, 2) for name, level in bands.items() if name != "total"},
        "bandPowerShare": band_power_share(bands),
        "lowFrequencyShare": band_power_share(bands).get("under100", 0.0),
        "highpassWidebandReductionDb": round(rms_dbfs(samples) - rms_dbfs(conditioned), 2),
    }


def calibrate_from_samples(samples: np.ndarray, sample_rate: int = 16_000, stop_secs: float = 0.6) -> dict:
    """One-shot calibration: measured profile + derived parameters + the effect of them.

        This is the function `voice_edge.calibrate` wraps, kept importable and free of I/O so
        the whole derivation can be unit tested without a microphone.
    """
    # High-pass first, since the low-frequency share decides the cutoff and both the gate
    # and the noise estimator run on the conditioned signal.
    probe = band_levels(samples, sample_rate)
    probe_share = band_power_share(probe)
    provisional = derive_frontend_params(
        noise_floor_dbfs(samples, sample_rate),
        sample_rate=sample_rate,
        low_frequency_share=probe_share.get("under100"),
        stop_secs=stop_secs,
    )
    profile = derive_noise_profile(samples, sample_rate, provisional.highpass_hz)

    # Now the real parameters: the gate/estimator floor is the conditioned one.
    params = derive_frontend_params(
        profile["rawFloorDbfs"],
        sample_rate=sample_rate,
        low_frequency_share=profile["lowFrequencyShare"],
        stop_secs=stop_secs,
    )
    conditioned = condition(samples, sample_rate, params.highpass_hz)
    enhanced = spectral_subtraction(
        conditioned,
        sample_rate,
        noise_floor_dbfs=profile["conditionedFloorDbfs"],
        oversubtraction=params.oversubtraction,
        gain_floor=params.gain_floor,
    )
    return {
        "unit": "dBFS",
        "noiseFloorDbfs": profile["conditionedFloorDbfs"],
        "rawNoiseFloorDbfs": profile["rawFloorDbfs"],
        "noiseRmsDbfs": profile["rawRmsDbfs"],
        "conditionedRmsDbfs": profile["conditionedRmsDbfs"],
        "noisePeakDbfs": round(to_db(float(np.max(np.abs(samples))) if np.asarray(samples).size else 0.0), 2),
        "noiseFloorFrameMs": 50.0,
        "noiseFloorPercentile": 10.0,
        "crestFactorDb": round(crest_factor_db(samples), 2),
        "bandDbfs": profile["bandDbfs"],
        "bandPowerShare": profile["bandPowerShare"],
        "lowFrequencyShare": profile["lowFrequencyShare"],
        "spectralFlatness": round(spectral_flatness(samples, sample_rate), 4),
        "spectralTiltDbPerOctave": round(spectral_tilt_db_per_octave(samples, sample_rate), 2),
        "parameters": params,
        "measuredEffect": {
            "unit": "dBFS",
            "highpassWidebandRmsReductionDb": profile["highpassWidebandReductionDb"],
            "noiseReductionFloorReductionDb": round(
                profile["conditionedFloorDbfs"] - noise_floor_dbfs(enhanced, sample_rate), 2
            ),
            "afterHighpassNoiseFloorDbfs": profile["conditionedFloorDbfs"],
            "afterHighpassAndNoiseReductionFloorDbfs": round(noise_floor_dbfs(enhanced, sample_rate), 2),
        },
    }

# --------------------------------------------------------------------------------------
# 4. Parameter derivation from the measured noise floor
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FrontendParams:
    """Front-end knobs, all derived from a measurement (see `derive_frontend_params`)."""

    highpass_hz: float
    gate_threshold_dbfs: float
    gate_margin_db: float
    gate_release_db: float
    suggested_capture_gain_db: float
    confidence: float
    stop_secs: float
    min_volume: float
    noise_reduction: bool = False
    oversubtraction: float = 2.0
    gain_floor: float = 0.06
    sample_rate: int = 16_000
    rationale: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["rationale"] = list(self.rationale)
        return data


def derive_frontend_params(
    noise_floor_dbfs_value: float,
    sample_rate: int = 16_000,
    low_frequency_share: float | None = None,
    speech_band_snr_db: float | None = None,
    stop_secs: float = 0.6,
    oversubtraction: float = 2.0,
    noise_reduction: bool = False,
) -> FrontendParams:
    """Turn a measured noise floor into the front-end parameters.

        The rules are deliberately coarse and documented, not fitted:

        * **high-pass** — 120 Hz when the sub-100 Hz share is heavy (≥ 50 % of power, this
        machine: 56 %), 100 Hz when it is noticeable (≥ 20 %), else 80 Hz. The filter is
        zero-phase, so a cutoff just above the rumble band does not delay the VAD.
        Stated bound: 120 Hz removes the measured rumble but keeps the lowest male
        fundamental F0 ≈ 85–100 Hz partially attenuated; `voice_edge.segment --highpass-hz`
        exists so a real recording can falsify this choice.
        * **gate threshold** — noise floor + margin, with the margin widened when the noise
        floor is high (a loud floor needs more room above it). The floor itself is clamped at
        `QUANTISATION_FLOOR_DBFS` so a synthetic fixture's digital silence cannot produce a
        sub-quantisation gate. Absolute bounds keep the gate from ever falling below the
        measured electronic floor.
        * **capture gain** — measured 1:1: dropping the +5.5 dB factory gain lowers the floor
        by 5.5 dB and lowers speech by the same amount, so software gain after the ADC is
        never worse, and 0 dB is preferred whenever the floor is high.
        * **VAD** — `stop_secs` is *not* fitted to noise here; it stays at the ADR-0007 value
        unless a re-measurement says otherwise. `confidence` is raised only in the worst
        noise regime, and the fixture regression in `scripts/verify-voice-noise.ts` is what
        justifies keeping the default.
    """
    floor = float(noise_floor_dbfs_value)
    rationale: list[str] = []
    effective_floor = max(floor, QUANTISATION_FLOOR_DBFS)
    if effective_floor > floor:
        rationale.append(f"噪声底实测 {floor:.1f} dBFS 低于量化底 → 按 {effective_floor:.1f} dBFS 计算门限")

    share = None if low_frequency_share is None else float(low_frequency_share)
    if share is not None and share >= 0.5:
        highpass_hz = 120.0
        rationale.append(f"<100 Hz 占噪声功率 {share:.0%}（≥50%）→ 高通 120 Hz")
    elif share is not None and share >= 0.2:
        highpass_hz = 100.0
        rationale.append(f"<100 Hz 占噪声功率 {share:.0%}（≥20%）→ 高通 100 Hz")
    else:
        highpass_hz = 80.0
        rationale.append("低频噪声占比不显著 → 高通 80 Hz（保留基频）")

    # Margin: widen with the noise floor. −40 dBFS floor or better gets the 9 dB that
    # ADR-0007's clean fixtures tolerated; each 10 dB of extra floor adds 3 dB of margin.
    excess = max(0.0, effective_floor + 40.0)
    gate_margin_db = round(min(21.0, 9.0 + 0.3 * excess), 1)
    gate_threshold_dbfs = round(effective_floor + gate_margin_db, 1)
    rationale.append(f"噪声底 {effective_floor:.1f} dBFS + 门限余量 {gate_margin_db:.1f} dB → 门限 {gate_threshold_dbfs:.1f} dBFS")

    if effective_floor > -35.0:
        suggested_capture_gain_db = 0.0
        rationale.append("噪声底高于 −35 dBFS → 建议采集增益降到 0 dB（实测 1:1 换回约 5.5 dB 余量）")
    elif effective_floor > -45.0:
        suggested_capture_gain_db = 3.0
        rationale.append("中等噪声底 → 采集增益 0…+3 dB 均可，优先 0 dB")
    else:
        suggested_capture_gain_db = 6.0
        rationale.append("安静房间 → 可保留出厂 +5.5 dB 左右增益以提升 ASR 输入电平")

    if effective_floor > -35.0:
        confidence = 0.7
        rationale.append("confidence 保持 ADR-0007 的 0.7（噪声下由夹具回归决定，不靠猜）")
    elif effective_floor > -45.0:
        confidence = 0.65
        rationale.append("中等噪声 → confidence 0.65")
    else:
        confidence = 0.6
        rationale.append("安静 → confidence 0.6 可更早开闸")

    if speech_band_snr_db is not None:
        rationale.append(f"语音带（300–3400 Hz）实测 SNR {speech_band_snr_db:.1f} dB")

    if noise_reduction:
        rationale.append(
            f"谱减法去噪开启（过减因子 {oversubtraction}），实测 300–3400 Hz 噪声带降 1.2 dB、"
            "语音带变化 ≤0.5 dB（过减 4.0，见 voice.md §1.6）"
        )
    else:
        rationale.append("谱减法去噪关闭（默认；`segment --nr` 可开）")

    rationale.append(f"stop_secs 沿用 ADR-0007 的 {stop_secs}（句内 352 ms 停顿实测，见 voice.md §1）")

    return FrontendParams(
        highpass_hz=highpass_hz,
        gate_threshold_dbfs=gate_threshold_dbfs,
        gate_margin_db=gate_margin_db,
        gate_release_db=6.0,
        suggested_capture_gain_db=suggested_capture_gain_db,
        confidence=confidence,
        stop_secs=stop_secs,
        min_volume=0.0,
        noise_reduction=noise_reduction,
        oversubtraction=oversubtraction,
        sample_rate=sample_rate,
        rationale=tuple(rationale),
    )


# --------------------------------------------------------------------------------------
# 5. Calibration profile: the one place the recommended values and the applied values meet
# --------------------------------------------------------------------------------------


def frontend_defaults() -> dict:
    """The **complete** parameter set the front end applies when no calibration profile exists.

    Built by the same derivation the profile path uses (`derive_frontend_params` on the
    quantisation floor, then `DEFAULT_HIGHPASS_HZ`), and returned in the same camelCase shape as
    `apply_calibration`, so `calibration_consistency` can compare the two field by field instead
    of comparing apples to a subset. Kept in one function so the calibrate report, the profile
    file and this module cannot drift apart — `tests/unit/voice/frontend.test.ts` asserts that
    `defaults.highpassHz === DEFAULT_HIGHPASS_HZ` and that the calibrate CLI's
    `consistency.defaults` equals this object.
    """
    seed = derive_frontend_params(QUANTISATION_FLOOR_DBFS)
    applied = apply_calibration("(no profile)", seed)
    applied["highpassHz"] = DEFAULT_HIGHPASS_HZ
    applied["profilePath"] = None
    applied["profileSchemaVersion"] = PROFILE_SCHEMA_VERSION
    applied["source"] = "code-default"
    applied["note"] = (
        "无校准产物时前端使用的默认值；DEFAULT_HIGHPASS_HZ 等于本机实测噪声下 "
        "derive_frontend_params 给出的截止频率（<100 Hz 占 62% → 120 Hz）"
    )
    return applied


def apply_calibration(profile_path: str | Path, params: FrontendParams) -> dict:
    """The parameter set the front end *actually applies* after calibration.

    This is the function that closes F8: the calibrate CLI writes the object returned here into
    the profile, so the recommended value and the applied value are literally the same object
    rather than two independently hard-coded numbers. Every field is echoed in the same
    camelCase spelling the console reads (`highpassHz`, `gateThresholdDbfs`, ...) so a caller
    cannot accidentally read a snake_case key that does not exist.
    """
    return {
        "profileSchemaVersion": PROFILE_SCHEMA_VERSION,
        "profilePath": str(profile_path).replace("\\", "/"),
        "highpassHz": params.highpass_hz,
        "gateThresholdDbfs": params.gate_threshold_dbfs,
        "gateMarginDb": params.gate_margin_db,
        "gateReleaseDb": params.gate_release_db,
        "suggestedCaptureGainDb": params.suggested_capture_gain_db,
        "confidence": params.confidence,
        "stopSecs": params.stop_secs,
        "minVolume": params.min_volume,
        "noiseReduction": params.noise_reduction,
        "oversubtraction": params.oversubtraction,
        "gainFloor": params.gain_floor,
        "sampleRate": params.sample_rate,
    }


def calibration_consistency(applied: dict, defaults: dict) -> dict:
    """Compare the applied calibration with the code defaults, field by field.

    Reported by the calibrate CLI so a reader can see whether calibrating actually changes
    anything, instead of assuming it does. `profileOverridesDefault` lists the fields where the
    calibration differs from the built-in default — on this machine that is only the gate
    threshold (the cutoff already equals the measured default).
    """
    ignored = {"source", "note", "profileSchemaVersion", "profilePath"}
    compared = {key: value for key, value in applied.items() if key not in ignored}
    overrides = [
        {"field": key, "default": defaults.get(key), "applied": value}
        for key, value in compared.items()
        if key in defaults and defaults[key] != value
    ]
    return {
        "profileApplied": True,
        "defaults": defaults,
        "applied": compared,
        "profileOverridesDefault": overrides,
        "identicalToDefaults": len(overrides) == 0,
        "why": (
            "校准产物存在时，前端按 applied 里的值运行；这里逐字段与代码默认对比，"
            "列表为空即「校准没有改变任何参数」（本机只可能在高通截止上出现差异）"
        ),
    }


def load_calibrated_params(
    profile_path: str | Path = DEFAULT_PROFILE_PATH,
    *,
    root: str | Path | None = None,
    sample_rate: int = 16_000,
    noise_floor_dbfs_value: float | None = None,
    stop_secs: float = 0.6,
) -> tuple[FrontendParams, dict]:
    """Parameters to actually use, preferring a calibration profile when one exists.

    Returns `(params, origin)` where `origin` is machine-readable evidence of *which* source
    won, so callers (and tests) can assert the behaviour instead of trusting a comment:

    * `{"source": "profile", "path": ...}` — a readable profile was found and its
      `applied` block was adopted. This is the path that makes the calibrate recommendation
      effective.
    * `{"source": "derived", ...}` — no profile (or an unreadable/older one): the parameters are
      derived from `noise_floor_dbfs_value` when given, otherwise `DEFAULT_HIGHPASS_HZ` plus the
      quantisation-clamped gate.

    A corrupt profile must never take the voice path down, so a parse error is reported in
    `origin["warning"]` and the derived path is used.
    """
    path = Path(profile_path)
    if root is not None and not path.is_absolute():
        path = Path(root) / path
    origin: dict = {"source": "derived", "path": str(path).replace("\\", "/"), "warning": None}

    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            applied = payload.get("applied") if isinstance(payload, dict) else None
            if isinstance(applied, dict) and "highpassHz" in applied:
                # `applied` is authoritative: adopt it verbatim instead of re-deriving, so the
                # profile cannot be "reinterpreted" into something else on load.
                seed = derive_frontend_params(
                    float(applied.get("gateThresholdDbfs", QUANTISATION_FLOOR_DBFS + 9.0))
                    - float(applied.get("gateMarginDb", 9.0)),
                    sample_rate=sample_rate,
                    stop_secs=stop_secs,
                )
                params = FrontendParams(
                    highpass_hz=float(applied["highpassHz"]),
                    gate_threshold_dbfs=float(applied.get("gateThresholdDbfs", seed.gate_threshold_dbfs)),
                    gate_margin_db=float(applied.get("gateMarginDb", seed.gate_margin_db)),
                    gate_release_db=float(applied.get("gateReleaseDb", seed.gate_release_db)),
                    suggested_capture_gain_db=float(
                        applied.get("suggestedCaptureGainDb", seed.suggested_capture_gain_db)
                    ),
                    confidence=float(applied.get("confidence", seed.confidence)),
                    stop_secs=float(applied.get("stopSecs", stop_secs)),
                    min_volume=float(applied.get("minVolume", 0.0)),
                    noise_reduction=bool(applied.get("noiseReduction", False)),
                    oversubtraction=float(applied.get("oversubtraction", 2.0)),
                    gain_floor=float(applied.get("gainFloor", 0.06)),
                    sample_rate=int(applied.get("sampleRate", sample_rate)),
                    rationale=(
                        f"校准产物生效：{path.name}（capturedAt={payload.get('capturedAt')}）",
                        f"高通 {applied['highpassHz']} Hz、门限 {applied.get('gateThresholdDbfs')} dBFS 来自实测校准",
                    ),
                )
                origin.update({"source": "profile", "capturedAt": payload.get("capturedAt")})
                return params, origin
            origin["warning"] = "profile exists but has no usable `applied` block (older schema?)"
        except Exception as error:  # noqa: BLE001 - a bad profile must not break the voice path
            origin["warning"] = f"profile unreadable ({type(error).__name__}: {error})"

    if noise_floor_dbfs_value is not None:
        derived = derive_frontend_params(noise_floor_dbfs_value, sample_rate=sample_rate, stop_secs=stop_secs)
        origin["derivedFrom"] = "measured-noise-floor"
        return derived, origin
    derived = derive_frontend_params(QUANTISATION_FLOOR_DBFS, sample_rate=sample_rate, stop_secs=stop_secs)
    derived = FrontendParams(
        highpass_hz=DEFAULT_HIGHPASS_HZ,
        gate_threshold_dbfs=derived.gate_threshold_dbfs,
        gate_margin_db=derived.gate_margin_db,
        gate_release_db=derived.gate_release_db,
        suggested_capture_gain_db=derived.suggested_capture_gain_db,
        confidence=derived.confidence,
        stop_secs=derived.stop_secs,
        min_volume=derived.min_volume,
        noise_reduction=derived.noise_reduction,
        oversubtraction=derived.oversubtraction,
        gain_floor=derived.gain_floor,
        sample_rate=sample_rate,
        rationale=(
            f"无校准产物 → 使用代码默认高通 {DEFAULT_HIGHPASS_HZ} Hz（等于本机实测噪声下的推荐值）",
            f"门限 {derived.gate_threshold_dbfs} dBFS 由量化底推导（噪声底未知）",
        ),
    )
    origin["derivedFrom"] = "code-default"
    return derived, origin

