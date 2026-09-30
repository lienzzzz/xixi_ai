"""Debounce: one noisy frame must not flip the state, and a short occlusion must not either.

The parameters are not arbitrary. The measured facts they are built on (T0 recon,
`docs/recon/field-test-environment-2026-09-30.md` section 4.3):

  * a static room produces frame-difference mean 0.8 grey levels - with a per-pixel
    threshold of 6, an empty room yields ``motion_ratio = 0`` - so motion false positives
    need a *changing* scene (lights, a curtain, an auto-exposure jump);
  * the camera runs at about 30 fps and face detection runs only every 10th frame, so a
    "N consecutive frames" rule is expressed in frames, not seconds, and N must be read
    against 30 fps: 15 frames is about 0.5 s;
  * a person walking past the lens for one frame, or a hand covering the camera for a
    moment, must not produce two events (present then absent).

Defaults: 15 frames (about 0.5 s) of consistent evidence to enter "present", 45 frames
(about 1.5 s) of no evidence to leave it, a release grace of 3000 ms so a one-off frame run
is ignored, and a minimum evidence duration of 1500 ms so a *short* run can never confirm
presence. Leaving takes longer than entering on purpose: the cost of a missed "someone
arrived" is a missed greeting, while the cost of a spurious "nobody is home" is Xixi talking
to an empty room.

Allowances are documented and finite: a real occlusion longer than the release grace *will*
produce an absence event, and that is correct behaviour (a camera covered for 5 seconds is
genuinely "no person visible"). The point is that it is one event pair, not a stutter of
events.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PRESENT = "present"
ABSENT = "absent"


@dataclass(frozen=True)
class DebounceConfig:
    """Hysteresis parameters for `PresenceDebouncer`."""

    #: Consecutive frames with evidence before claiming presence. 15 @ ~30 fps is about 0.5 s.
    present_confirm_frames: int = 15
    #: Consecutive frames without evidence before claiming absence. 45 @ ~30 fps is about 1.5 s.
    absent_confirm_frames: int = 45
    #: After the last evidence, wait at least this long before an absence may be declared.
    release_grace_ms: float = 3000.0
    #: What to report before any evidence has been seen. "absent" avoids a greeting at
    #: startup that was never triggered by a real arrival.
    initial_state: str = ABSENT
    #: A *contiguous* run of evidence shorter than this is noise, not a person. Measured
    #: against the field numbers: someone who is genuinely there keeps moving for seconds,
    #: while a corrupted frame or a hand across the lens lasts a few hundred milliseconds.
    minimum_evidence_ms: float = 1500.0

    def __post_init__(self) -> None:
        if self.present_confirm_frames < 1 or self.absent_confirm_frames < 1:
            raise ValueError("present_confirm_frames and absent_confirm_frames must be >= 1")
        if self.initial_state not in (PRESENT, ABSENT):
            raise ValueError("initial_state must be 'present' or 'absent'")
        if self.release_grace_ms < 0:
            raise ValueError("release_grace_ms must not be negative")
        if self.minimum_evidence_ms < 0:
            raise ValueError("minimum_evidence_ms must not be negative")


@dataclass
class Counters:
    """Observability for the debounce stage: why the state did or did not change."""

    signals_since_change: int = 0
    blanks_since_change: int = 0
    frames_seen: int = 0
    frames_with_evidence: int = 0
    frames_with_face: int = 0
    signals_total: int = 0
    runs_rejected_as_too_short: int = 0
    last_run_ms: float | None = None
    last_run_frames: int = 0
    entered_at_ms: float | None = None
    last_evidence_ms: float | None = None
    windows_required: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "frames_seen": self.frames_seen,
            "frames_with_evidence": self.frames_with_evidence,
            "frames_with_face": self.frames_with_face,
            "signals_since_change": self.signals_since_change,
            "blanks_since_change": self.blanks_since_change,
            "runs_rejected_as_too_short": self.runs_rejected_as_too_short,
            "last_run_ms": None if self.last_run_ms is None else round(self.last_run_ms, 1),
            "last_run_frames": self.last_run_frames,
            "entered_at_ms": None if self.entered_at_ms is None else round(self.entered_at_ms, 1),
            "last_evidence_ms": None if self.last_evidence_ms is None else round(self.last_evidence_ms, 1),
        }


@dataclass
class PresenceDecision:
    """What the debouncer believes after one frame, including *why*."""

    state: str
    previous_state: str
    changed: bool
    confidence: float
    reason: str
    frame_index: int = 0
    timestamp_ms: float = 0.0
    source_detail: str = ""

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "previous_state": self.previous_state,
            "changed": self.changed,
            "confidence": round(self.confidence, 3),
            "reason": self.reason,
            "frame": self.frame_index,
            "ts_ms": round(self.timestamp_ms, 1),
            "source_detail": self.source_detail,
        }


class PresenceDebouncer:
    """Hysteresis between per-frame evidence and the `presence.changed` event.

    Two thresholds, not one: entering and leaving need different amounts of consistent
    evidence. Every knob is a constructor argument so the field settings can be re-tuned
    without touching the code path the tests exercise.
    """

    def __init__(self, config: DebounceConfig | None = None) -> None:
        self.config = config or DebounceConfig()
        self.state = self.config.initial_state
        self.counters = Counters()
        self._run_started_ms: float | None = None
        self._run_frames = 0
        self._run_peak_frames = 0
        self._last_confidence = 0.6 if self.state == ABSENT else 0.9

    # ------------------------------------------------------------------ internals

    def _confidence_for(self, state: str, *, faces: int, motion: bool) -> float:
        if state == PRESENT:
            if faces > 0:
                return 0.9
            return 0.75 if motion else 0.7
        return 0.85

    def _detail(self, state: str, *, motion_ratio: float, faces: int, frames: int, reason: str) -> str:
        return (
            f"state={state} frames={frames} motion_ratio={motion_ratio:.4f} "
            f"faces={faces} gate=motion+face reason={reason}"
        )

    # --------------------------------------------------------------------- public

    def update(
        self,
        *,
        signal: bool,
        motion_ratio: float,
        faces: int,
        timestamp_ms: float,
        frame_index: int,
    ) -> PresenceDecision:
        """Fold one frame's evidence into the state; report only real transitions."""
        config = self.config
        previous = self.state
        self.counters.frames_seen += 1

        if signal:
            self.counters.signals_total += 1
            self.counters.frames_with_evidence += 1
            # Only a *contiguous* run of evidence counts; a blank frame ends it.
            if self._run_started_ms is None:
                self._run_started_ms = timestamp_ms
                self._run_frames = 0
            self._run_frames += 1
            if self._run_frames > self._run_peak_frames:
                self._run_peak_frames = self._run_frames
            self.counters.signals_since_change += 1
            self.counters.blanks_since_change = 0
            self.counters.last_evidence_ms = timestamp_ms
            if faces > 0:
                self.counters.frames_with_face += 1
        else:
            self.counters.blanks_since_change += 1
            self.counters.signals_since_change = 0
            if self._run_started_ms is not None:
                self.counters.last_run_ms = timestamp_ms - self._run_started_ms
                self.counters.last_run_frames = self._run_peak_frames
                if self.state == ABSENT:
                    # A run of evidence that ended without ever confirming presence: a
                    # corrupted frame, a light flicker, a hand across the lens, or simply too
                    # short to count. Either way it produced no event.
                    self.counters.runs_rejected_as_too_short += 1
                self._run_started_ms = None
                self._run_frames = 0
                self._run_peak_frames = 0

        changed = False
        reason = "steady"

        if self.state == ABSENT:
            if self._run_started_ms is None:
                reason = "no_evidence"
            else:
                held_ms = timestamp_ms - self._run_started_ms
                if (
                    self.counters.signals_since_change >= config.present_confirm_frames
                    and held_ms >= config.minimum_evidence_ms
                ):
                    self.state = PRESENT
                    changed = True
                    reason = "present_confirmed"
                    self.counters.entered_at_ms = timestamp_ms
                    self.counters.signals_since_change = 0
                    self.counters.blanks_since_change = 0
                    self._run_started_ms = None
                    self._run_frames = 0
                    self._run_peak_frames = 0
                elif held_ms < config.minimum_evidence_ms:
                    # Looks like evidence, but has not lasted long enough to be a person.
                    reason = "burst_too_short"
                else:
                    reason = "present_pending"
        else:
            grace_elapsed = (
                self.counters.last_evidence_ms is not None
                and timestamp_ms - self.counters.last_evidence_ms >= config.release_grace_ms
            )
            if self.counters.blanks_since_change >= config.absent_confirm_frames and grace_elapsed:
                self.state = ABSENT
                changed = True
                reason = "absent_confirmed"
                self.counters.entered_at_ms = None
                self.counters.signals_since_change = 0
                self.counters.blanks_since_change = 0
            elif self.counters.blanks_since_change == 0:
                reason = "held"
            else:
                reason = "absent_pending"

        self._last_confidence = self._confidence_for(self.state, faces=faces, motion=signal)
        return PresenceDecision(
            state=self.state,
            previous_state=previous,
            changed=changed,
            confidence=self._last_confidence,
            reason=reason,
            frame_index=frame_index,
            timestamp_ms=timestamp_ms,
            source_detail=self._detail(
                self.state,
                motion_ratio=motion_ratio,
                faces=faces,
                frames=self.counters.frames_seen,
                reason=reason,
            ),
        )

    @property
    def last_confidence(self) -> float:
        return self._last_confidence
