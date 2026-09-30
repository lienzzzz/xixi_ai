"""VAD baseline for Chinese speech (ADR-0007).

The parameters are not defaults: they are the outcome of the Pipecat spike
(docs/recon/pipecat-spike-2026-09-29.md).

* ``stop_secs=0.6`` — the 0.2 default ends a Chinese sentence at its first
  intra-sentence pause (measured: a 352 ms comma pause produced a false endpoint
  1440 ms before the true end), and the smart-turn model cannot recover it
  because it is only consulted at the VAD stop.
* ``min_volume=0.0`` — the 0.6 default gates speech behind a 400 ms BS.1770
  window and cost 320-480 ms of speech-start latency.
* ``confidence=0.7`` and ``start_secs=0.2`` stay at their defaults.

Note what this baseline does **not** buy us: "嗯。" is invisible to Silero VAD
(peak confidence 0.5274), so backchannel handling cannot be delegated here.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class VadBaseline:
    confidence: float = 0.7
    start_secs: float = 0.2
    stop_secs: float = 0.6
    min_volume: float = 0.0
    sample_rate: int = 16_000
    #: Silero needs 512 *samples* (32 ms) per frame at 16 kHz — 1024 bytes of PCM16.
    frame_size: int = 512

    @property
    def frame_bytes(self) -> int:
        return self.frame_size * 2

    def to_pipecat_params(self):  # noqa: ANN201 - pipecat type imported lazily
        from pipecat.audio.vad.vad_analyzer import VADParams

        return VADParams(
            confidence=self.confidence,
            start_secs=self.start_secs,
            stop_secs=self.stop_secs,
            min_volume=self.min_volume,
        )


BASELINE = VadBaseline()


def quiet_logging() -> None:
    """Silence pipecat/loguru chatter before it is imported.

    Diagnostics belong in the JSON result, not on stderr: this CLI is consumed by
    another process, and a noisy stderr is mistaken for failure by shells.
    """
    try:
        from loguru import logger

        logger.remove()
    except Exception:  # pragma: no cover - loguru always ships with pipecat
        pass
