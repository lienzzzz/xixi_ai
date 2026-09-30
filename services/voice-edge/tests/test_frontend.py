"""Offline unit tests for the pure DSP in `voice_edge.frontend` + the fixture generator.

Run either directly (`python -m unittest discover -s tests`) or through the Node suite
(`tests/unit/voice/frontend.test.ts`), which is what `npm test` does. Nothing here touches a
microphone, the network, or a VAD model: these are the functions whose correctness must not
depend on either.

Usage:
    cd services/voice-edge && <venv-python> -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice_edge import frontend as fe  # noqa: E402
from voice_edge import make_noise_fixtures as mnf  # noqa: E402

RATE = 16_000


def sine(frequency: float, seconds: float = 1.0, amplitude: float = 0.5, rate: int = RATE) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return amplitude * np.sin(2 * np.pi * frequency * t)


def white_noise(rms: float = 0.05, seconds: float = 3.0, seed: int = 7) -> np.ndarray:
    generator = np.random.default_rng(seed)
    return generator.normal(0.0, rms, int(seconds * RATE))


def band_noise(low: float, high: float, rms: float = 0.1, seconds: float = 3.0, seed: int = 11) -> np.ndarray:
    """Noise whose energy sits between `low` and `high` Hz (brick-wall FFT mask)."""
    generator = np.random.default_rng(seed)
    signal = generator.normal(0.0, 1.0, int(seconds * RATE))
    spectrum = np.fft.rfft(signal)
    freqs = np.fft.rfftfreq(signal.size, 1.0 / RATE)
    spectrum[(freqs < low) | (freqs > high)] = 0.0
    filtered = np.fft.irfft(spectrum, n=signal.size)
    return filtered / max(float(np.sqrt(np.mean(filtered**2))), 1e-12) * rms


class LevelsTest(unittest.TestCase):
    def test_full_scale_sine_is_minus_3_dbfs(self) -> None:
        self.assertAlmostEqual(fe.rms_dbfs(sine(1000.0, amplitude=1.0)), -3.01, places=1)

    def test_to_db_clamps_silence(self) -> None:
        self.assertEqual(fe.to_db(0.0), fe.SILENCE_DBFS)
        self.assertEqual(fe.rms_dbfs(np.zeros(100)), fe.SILENCE_DBFS)

    def test_from_db_is_the_inverse_of_to_db(self) -> None:
        self.assertAlmostEqual(fe.to_db(fe.from_db(-30.0)), -30.0, places=6)

    def test_band_levels_match_the_time_domain_rms(self) -> None:
        noise = white_noise()
        levels = fe.band_levels(noise, RATE)
        # The bands cover 1 Hz…Nyquist; with one pass over the whole block the band powers
        # must add back up to the time-domain power (within the 0–1 Hz gap).
        self.assertAlmostEqual(levels["total"], fe.rms_dbfs(noise), places=1)

    def test_band_levels_put_a_tone_in_the_right_band(self) -> None:
        tone = sine(1000.0)
        levels = fe.band_levels(tone, RATE)
        self.assertGreater(levels["300-3400"], -10.0)
        self.assertLess(levels["under100"], -60.0)

    def test_band_power_share_sums_to_one(self) -> None:
        shares = fe.band_power_share(fe.band_levels(white_noise(), RATE))
        self.assertAlmostEqual(sum(shares.values()), 1.0, places=3)
        self.assertNotIn("total", shares)

    def test_band_snr_is_band_limited(self) -> None:
        # Speech-band tone + loud out-of-band rumble: the in-band SNR must ignore the rumble.
        speech = sine(1000.0, amplitude=0.1)
        rumble = sine(40.0, amplitude=0.9)
        noise = white_noise(rms=0.01)
        snr_clean = fe.band_snr_db(speech, noise, RATE)
        snr_with_rumble = fe.band_snr_db(speech + rumble, noise, RATE)
        self.assertAlmostEqual(snr_clean, snr_with_rumble, places=1)


class NoiseFloorTest(unittest.TestCase):
    def test_noise_floor_tracks_the_noise_level(self) -> None:
        quiet = fe.noise_floor_dbfs(white_noise(rms=0.01), RATE)
        loud = fe.noise_floor_dbfs(white_noise(rms=0.1), RATE)
        self.assertAlmostEqual(loud - quiet, 20.0, delta=1.5)

    def test_noise_floor_ignores_a_short_speech_like_burst(self) -> None:
        # 10 % speech, 90 % silence: the p10 floor must stay near the silence level.
        signal = np.concatenate((sine(500.0, 0.3, 0.3), np.zeros(int(2.7 * RATE))))
        floor = fe.noise_floor_dbfs(signal, RATE)
        self.assertLess(floor, -80.0)

    def test_crest_factor_of_a_sine_is_about_3_db(self) -> None:
        self.assertAlmostEqual(fe.crest_factor_db(sine(1000.0, amplitude=1.0)), 3.01, places=1)

    def test_spectral_flatness_white_noise_above_tone(self) -> None:
        self.assertGreater(fe.spectral_flatness(white_noise(), RATE), fe.spectral_flatness(sine(1000.0), RATE))

    def test_spectral_tilt_is_negative_for_low_frequency_dominated_noise(self) -> None:
        # Slope of 1/f^alpha noise is -10*alpha dB/octave, so a low-band signal is negative
        # and a high-band signal is positive; the measured values are checked, not the sign
        # of a fitted line through two tones.
        low_band = fe.spectral_tilt_db_per_octave(0.29 * band_noise(100.0, 200.0, 0.3), RATE)
        high_band = fe.spectral_tilt_db_per_octave(2.69 * band_noise(2000.0, 4000.0, 0.3), RATE)
        self.assertLess(low_band, -5.0)
        self.assertGreater(high_band, 5.0)

    def test_spectral_flatness_separates_noise_from_a_tone(self) -> None:
        self.assertGreater(fe.spectral_flatness(white_noise(), RATE), fe.spectral_flatness(sine(1000.0), RATE))


class HighpassTest(unittest.TestCase):
    def test_dc_removal_kills_the_offset(self) -> None:
        signal = np.ones(1000) * 0.33
        self.assertLess(abs(float(np.mean(fe.remove_dc(signal)))), 1e-12)
        self.assertAlmostEqual(fe.rms_dbfs(fe.remove_dc(signal)), fe.SILENCE_DBFS, places=6)

    def test_streaming_dc_removal_converges(self) -> None:
        signal = np.ones(2000) * 0.25
        state = 0.0
        for start in range(0, 2000, 100):
            block, state = fe.remove_dc_streaming(signal[start : start + 100], state)
        self.assertLess(abs(float(np.mean(block))), 0.01)

    def test_biquad_dc_gain_is_zero(self) -> None:
        b0, b1, b2, a1, a2 = fe.highpass_coefficients(120.0, RATE)
        dc_gain = (b0 + b1 + b2) / (1.0 + a1 + a2)
        self.assertAlmostEqual(dc_gain, 0.0, places=10)

    def test_highpass_attenuates_below_cutoff_and_passes_above(self) -> None:
        reference = fe.rms_dbfs(sine(1000.0, 2.0))
        for frequency, minimum_attenuation in ((20.0, 30.0), (60.0, 12.0), (120.0, 3.0)):
            filtered = fe.rms_dbfs(fe.highpass(sine(frequency, 2.0), 120.0, RATE)[RATE:])
            self.assertLess(filtered - reference, -minimum_attenuation, f"{frequency} Hz was not attenuated")
        for frequency in (500.0, 1000.0, 3000.0):
            filtered = fe.rms_dbfs(fe.highpass(sine(frequency, 2.0), 120.0, RATE)[RATE:])
            self.assertAlmostEqual(filtered, reference, delta=1.0)

    def test_minus_6_db_point_is_close_to_the_requested_cutoff(self) -> None:
        reference = fe.rms_dbfs(sine(1000.0, 2.0)[RATE:])
        attenuation = {
            frequency: fe.rms_dbfs(fe.highpass(sine(frequency, 2.0), 120.0, RATE)[RATE:]) - reference
            for frequency in (60.0, 80.0, 100.0, 120.0, 150.0, 200.0)
        }
        self.assertAlmostEqual(attenuation[120.0], -6.0, delta=1.5)
        self.assertLess(attenuation[60.0], -15.0)
        self.assertGreater(attenuation[200.0], -2.0)

    def test_highpass_keeps_the_block_length_and_is_low_latency(self) -> None:
        case = white_noise(seconds=1.0)
        out = fe.highpass(case, 120.0, RATE)
        self.assertEqual(out.size, case.size)
        # A zero-phase filter must not shift energy in time: correlate the band-passed
        # signal with the input and require the peak at lag 0.
        correlation = np.correlate(out, case, mode="full")
        self.assertEqual(int(np.argmax(np.abs(correlation))) - (case.size - 1), 0)

    def test_invalid_cutoffs_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            fe.highpass_coefficients(0.0, RATE)
        with self.assertRaises(ValueError):
            fe.highpass_coefficients(9000.0, RATE)


class SpectralSubtractionTest(unittest.TestCase):
    def test_reduces_stationary_noise_power(self) -> None:
        noise = white_noise(rms=0.05)
        out = fe.spectral_subtraction(noise, RATE, noise_floor_dbfs=fe.noise_floor_dbfs(noise, RATE))
        # The estimator sees only noise here, so every bin is subtracted down to the gain
        # floor: the output must not be quieter than the floor allows, and must not be louder
        # than the input (that was the OLA-weight bug: +17 dB of broadband gain).
        self.assertLessEqual(fe.rms_dbfs(out), fe.rms_dbfs(noise) + 1.0)
        self.assertGreater(fe.rms_dbfs(out), fe.rms_dbfs(noise) - 40.0)

    def test_keeps_a_tone_that_is_above_the_floor(self) -> None:
        noise = white_noise(rms=0.02, seconds=1.0)
        signal = sine(1000.0, amplitude=0.3) + noise
        out = fe.spectral_subtraction(signal, RATE, noise_floor_dbfs=fe.noise_floor_dbfs(noise, RATE))
        # The tone survives within a couple of dB: the OLA stage is level-corrected, so the
        # only loss is the residual subtraction of the noise that sits on the tone's band.
        self.assertAlmostEqual(fe.band_levels(out, RATE)["300-3400"], fe.band_levels(signal, RATE)["300-3400"], delta=2.0)

    def test_level_is_preserved_for_a_signal_above_the_floor(self) -> None:
        # Guards the OLA stage specifically: a naive sum-of-windows reconstruction lost
        # 2.5 dB here, which would silently attenuate everything the ASR sees.
        tone = sine(1000.0, amplitude=0.3)
        out = fe.spectral_subtraction(tone, RATE, noise_floor_dbfs=-60.0)
        self.assertAlmostEqual(fe.rms_dbfs(out), fe.rms_dbfs(tone), delta=0.5)

    def test_output_length_is_preserved(self) -> None:
        signal = white_noise(seconds=1.3)
        self.assertEqual(fe.spectral_subtraction(signal, RATE, noise_floor_dbfs=-30.0).size, signal.size)

    def test_gain_floor_bounds_the_attenuation(self) -> None:
        noise = white_noise(rms=0.05)
        aggressive = fe.spectral_subtraction(noise, RATE, noise_floor_dbfs=-30.0, oversubtraction=8.0, gain_floor=0.5)
        permissive = fe.spectral_subtraction(noise, RATE, noise_floor_dbfs=-30.0, oversubtraction=8.0, gain_floor=0.01)
        self.assertGreater(fe.rms_dbfs(aggressive), fe.rms_dbfs(permissive))

    def test_empty_input_is_returned_unchanged(self) -> None:
        self.assertEqual(fe.spectral_subtraction(np.zeros(0), RATE).size, 0)


class ParameterDerivationTest(unittest.TestCase):
    def test_loud_low_frequency_noise_gets_the_highest_cutoff(self) -> None:
        params = fe.derive_frontend_params(-30.0, low_frequency_share=0.62)
        self.assertEqual(params.highpass_hz, 120.0)
        self.assertEqual(params.suggested_capture_gain_db, 0.0)
        self.assertEqual(params.stop_secs, 0.6)  # ADR-0007 unchanged

    def test_moderate_and_quiet_cases_get_lower_cutoffs(self) -> None:
        self.assertEqual(fe.derive_frontend_params(-30.0, low_frequency_share=0.3).highpass_hz, 100.0)
        self.assertEqual(fe.derive_frontend_params(-60.0, low_frequency_share=0.05).highpass_hz, 80.0)

    def test_gate_threshold_is_above_the_noise_floor(self) -> None:
        params = fe.derive_frontend_params(-30.0, low_frequency_share=0.62)
        self.assertGreater(params.gate_threshold_dbfs, -30.0)
        self.assertAlmostEqual(params.gate_threshold_dbfs, -30.0 + params.gate_margin_db, places=1)

    def test_margin_grows_with_the_noise_floor_but_is_bounded(self) -> None:
        quiet = fe.derive_frontend_params(-60.0)
        loud = fe.derive_frontend_params(-20.0)
        extreme = fe.derive_frontend_params(0.0)
        self.assertLess(quiet.gate_margin_db, loud.gate_margin_db)
        self.assertLessEqual(extreme.gate_margin_db, 21.0)

    def test_digital_silence_is_clamped_to_the_quantisation_floor(self) -> None:
        params = fe.derive_frontend_params(fe.SILENCE_DBFS)
        self.assertGreater(params.gate_threshold_dbfs, -70.0)
        self.assertTrue(any("量化底" in line for line in params.rationale))

    def test_rationale_is_never_empty_and_params_serialise(self) -> None:
        params = fe.derive_frontend_params(-30.0, low_frequency_share=0.62, speech_band_snr_db=6.0)
        self.assertGreaterEqual(len(params.rationale), 4)
        data = params.to_dict()
        self.assertEqual(data["highpass_hz"], 120.0)
        self.assertIsInstance(data["rationale"], list)


class CalibrationTest(unittest.TestCase):
    def test_calibration_reports_both_floors_and_a_measurable_effect(self) -> None:
        # A loud rumble + a steady hiss, roughly this machine's noise shape.
        rumble = 0.25 * sine(45.0, 5.0)
        hiss = white_noise(rms=0.03, seconds=5.0)
        report = fe.calibrate_from_samples(rumble + hiss, RATE)
        self.assertEqual(report["unit"], "dBFS")
        self.assertGreater(report["lowFrequencyShare"], 0.5)
        self.assertEqual(report["params"] if "params" in report else report["parameters"].highpass_hz, 120.0)
        self.assertGreater(report["measuredEffect"]["highpassWidebandRmsReductionDb"], 3.0)

    def test_conditioned_floor_is_not_the_raw_floor(self) -> None:
        rumble = 0.3 * sine(45.0, 5.0)
        hiss = white_noise(rms=0.01, seconds=5.0)
        report = fe.calibrate_from_samples(rumble + hiss, RATE)
        self.assertLess(report["noiseFloorDbfs"], report["rawNoiseFloorDbfs"])

    def test_noise_reduction_floor_reduction_is_positive_for_real_noise(self) -> None:
        hiss = white_noise(rms=0.05, seconds=5.0)
        report = fe.calibrate_from_samples(hiss, RATE)
        # Stationary broadband noise is the easy case, and the setting is deliberately
        # conservative (measured 0.57 dB at oversubtraction 2.0), so this only pins the
        # direction: the processed noise must not come out louder than the input.
        effect = report["measuredEffect"]
        self.assertGreater(effect["noiseReductionFloorReductionDb"], 0.3)
        self.assertLess(effect["afterHighpassAndNoiseReductionFloorDbfs"], effect["afterHighpassNoiseFloorDbfs"])


class NoiseFixtureGeneratorTest(unittest.TestCase):
    def test_conditioned_mix_hits_the_requested_in_band_snr(self) -> None:
        clean = sine(600.0, 1.0, 0.3) + sine(1500.0, 1.0, 0.2)
        noise = white_noise(rms=0.2, seconds=1.0)
        for target in (18.0, 6.0, 0.0, -6.0):
            scaled, _, achieved, scale = mnf.scale_noise_to_snr(clean, noise, RATE, target, 120.0)
            self.assertAlmostEqual(achieved, target, delta=0.25, msg=f"target {target} dB")
            self.assertGreater(scale, 0.0)
            self.assertEqual(scaled.size, noise.size)

    def test_trim_silence_finds_the_speech(self) -> None:
        signal = np.concatenate((np.zeros(RATE // 2), sine(500.0, 0.5, 0.3), np.zeros(RATE // 2)))
        trimmed = mnf.trim_silence(signal, RATE)
        self.assertLess(trimmed.size, signal.size)
        self.assertGreater(trimmed.size, RATE // 3)

    def test_scale_noise_rejects_a_silent_clean_signal(self) -> None:
        with self.assertRaises(ValueError):
            mnf.scale_noise_to_snr(np.zeros(RATE), white_noise(), RATE, 6.0, 120.0)

    def test_fixture_meta_matches_the_repository_fixtures(self) -> None:
        fixture_dir = Path(__file__).resolve().parents[3] / "tests" / "audio-fixtures"
        for fixture_id in mnf.FIXTURE_META:
            self.assertTrue((fixture_dir / f"{fixture_id}.wav").exists(), f"{fixture_id}.wav missing")


if __name__ == "__main__":
    unittest.main()
