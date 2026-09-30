"""Synthetic camera scenes, drawn by code: no external assets, no licence questions.

Why generated images at all: the regression tests must run offline and deterministically,
and the real webcam currently points at the ceiling (T0 recon). Every synthetic scene here
exists to pin down one *decision*, and the tests assert decisions, never pixels:

  * `empty_static`     — a room where nothing moves: must never claim presence;
  * `empty_noisy`      — the same plus per-frame sensor noise: the classic false positive;
  * `person_moving`    — a soft-edged figure crossing the frame: motion gate fires;
  * `person_still_on_face_scene` — a drawn face (YuNet detects it at 640x480): the face
    confirmation path fires even when motion is weak, which is what answers "someone is
    present but not moving".

One deliberate design choice: the moving figure is soft-edged (Gaussian-blurred). A sharp
rectangle *does not work* as a motion fixture at the service's processing width, because
downscaling a hard edge with fractional per-frame offsets can leave every pixel of the edge
below the 6-grey-level threshold — measured 0.0047 changed ratio, i.e. no motion at all. A
soft edge changes by 2-4 grey levels per pixel across a wider band, which is what a real
person (and a real, slightly out-of-focus camera) produces.
"""

from __future__ import annotations

from typing import Sequence

import cv2
import numpy as np

DEFAULT_SHAPE = (480, 640)


def empty_static(shape: tuple[int, int] = DEFAULT_SHAPE, fill: int = 200) -> np.ndarray:
    """A flat, motionless scene. Rendered as a room-ish gradient so it is not degenerate."""
    height, width = shape
    scene = np.full((height, width, 3), fill, np.uint8)
    cv2.rectangle(scene, (0, int(height * 0.72)), (width, height), (fill - 30, fill - 25, fill - 20), -1)
    cv2.rectangle(scene, (int(width * 0.06), int(height * 0.10)), (int(width * 0.34), int(height * 0.55)), (fill - 40, fill - 35, fill - 30), -1)
    return scene


def empty_with_noise(
    shape: tuple[int, int] = DEFAULT_SHAPE, fill: int = 200, sigma: float = 3.0, seed: int = 11
) -> np.ndarray:
    """Flat scene plus Gaussian sensor noise: no structure, so it must not read as a person."""
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, sigma, (shape[0], shape[1], 3))
    return np.clip(empty_static(shape, fill).astype(np.float32) + noise, 0, 255).astype(np.uint8)


def speckle_frame(shape: tuple[int, int] = DEFAULT_SHAPE, ratio: float = 0.25, amplitude: int = 90, seed: int = 7) -> np.ndarray:
    """One heavily corrupted frame — the "one bad frame" false positive."""
    rng = np.random.default_rng(seed)
    frame = empty_static(shape)
    mask = rng.random(shape[:2]) < ratio
    frame[mask] = np.clip(frame[mask].astype(np.int16) + amplitude, 0, 255).astype(np.uint8)
    other = rng.random(shape[:2]) < ratio
    frame[other] = np.clip(frame[other].astype(np.int16) - amplitude, 0, 255).astype(np.uint8)
    return frame


def person_moving(
    x: int,
    y: int = 80,
    shape: tuple[int, int] = DEFAULT_SHAPE,
    body: tuple[int, int] = (130, 230),
) -> np.ndarray:
    """A soft-edged figure at (x, y). Consecutive positions produce real motion signal."""
    scene = empty_static(shape)
    height, width = body[1], body[0]
    x0 = max(0, min(shape[1] - width, x))
    y0 = max(0, min(shape[0] - height, y))
    patch = np.full((height, width, 3), 200, np.uint8)
    centre = (width // 2, height // 2)
    cv2.ellipse(patch, (centre[0], centre[1] - int(height * 0.30)), (int(width * 0.28), int(height * 0.16)), 0, 0, 360, (90, 90, 90), -1)
    cv2.ellipse(patch, (centre[0], centre[1] + int(height * 0.12)), (int(width * 0.40), int(height * 0.36)), 0, 0, 360, (70, 70, 75), -1)
    patch = cv2.GaussianBlur(patch, (11, 11), 0)
    scene[y0 : y0 + height, x0 : x0 + width] = patch
    return scene


def person_track(
    count: int,
    start_x: int = 40,
    step: int = 12,
    y: int = 80,
    shape: tuple[int, int] = DEFAULT_SHAPE,
    width_span: int = 320,
) -> list[tuple[np.ndarray, float]]:
    """`count` frames of a figure walking across the frame, at 30 fps timestamps."""
    interval = 1000.0 / 30.0
    return [
        (person_moving(start_x + (index * step) % width_span, y, shape), index * interval)
        for index in range(count)
    ]


def still_track(count: int, fill: int = 200, shape: tuple[int, int] = DEFAULT_SHAPE) -> list[tuple[np.ndarray, float]]:
    interval = 1000.0 / 30.0
    return [(empty_static(shape, fill), index * interval) for index in range(count)]


# --------------------------------------------------------------------------- face rig

def rig_face(shape: tuple[int, int] = (260, 220)) -> np.ndarray:
    """A drawn face that `cv2.FaceDetectorYN` detects (verified: 1 face at 640x480).

    This is a *rig* for the confirmation path, not a claim that pixel art generalises to
    real faces; real-face validation is a documented user-run step (see the recon report).
    """
    height, width = shape
    face = np.full((height, width, 3), 190, np.uint8)
    centre = (width // 2, int(height * 0.5))
    cv2.ellipse(face, centre, (70, 92), 0, 0, 360, (150, 170, 195), -1)
    for offset in (-28, 28):
        cv2.ellipse(face, (centre[0] + offset, centre[1] - 24), (13, 8), 0, 0, 360, (245, 245, 245), -1)
        cv2.circle(face, (centre[0] + offset, centre[1] - 24), 6, (45, 45, 45), -1)
    cv2.ellipse(face, (centre[0], centre[1] + 34), (22, 11), 0, 0, 180, (55, 45, 45), 3)
    cv2.line(face, (centre[0], centre[1] - 6), (centre[0], centre[1] + 14), (140, 120, 100), 3)
    cv2.ellipse(face, (centre[0], centre[1] - 50), (72, 52), 0, 180, 360, (65, 55, 50), -1)
    return face


def face_scene(
    offset: tuple[int, int] = (0, 0),
    shape: tuple[int, int] = DEFAULT_SHAPE,
    background: int = 70,
) -> np.ndarray:
    """The rig face pasted on a dark background; small offsets give motion *and* a face."""
    face = rig_face()
    scene = np.full((shape[0], shape[1], 3), background, np.uint8)
    height, width = face.shape[:2]
    x0 = max(0, min(shape[1] - width, 40 + offset[0]))
    y0 = max(0, min(shape[0] - height, 20 + offset[1]))
    scene[y0 : y0 + height, x0 : x0 + width] = face
    return scene


def face_track(count: int, shape: tuple[int, int] = DEFAULT_SHAPE) -> list[tuple[np.ndarray, float]]:
    """`count` frames of the face rig, jittering by a few pixels so motion is present too."""
    offsets: Sequence[tuple[int, int]] = ((0, 0), (12, 6), (-8, 10), (6, -6))
    interval = 1000.0 / 30.0
    return [
        (face_scene(offsets[index % len(offsets)], shape), index * interval) for index in range(count)
    ]
