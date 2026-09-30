"""perception-edge — 本地摄像头「人物在场」检测（M6）。

设计边界（与仓库铁律一致）：
  * 连续视频绝不外传：本包只在本机抓帧 + 本地推理，没有任何网络客户端。
  * 不做多机位、不做人脸识别（不认识「是谁」）、不做录像；只回答「家里有没有人」。
  * 结论只以 `presence.changed` 事件（xixi.event.v1）的形式离开本包，见 emitter.py。
"""

from .camera import CameraConfig, FrameGrabber, FrameStats
from .debounce import DebounceConfig, PresenceDebouncer
from .detector import (
    DetectionConfig,
    FrameSignals,
    PresenceDetector,
    create_face_detector,
    load_yunet_model_path,
)

__all__ = [
    "CameraConfig",
    "FrameGrabber",
    "FrameStats",
    "DebounceConfig",
    "PresenceDebouncer",
    "DetectionConfig",
    "FrameSignals",
    "PresenceDetector",
    "create_face_detector",
    "load_yunet_model_path",
]

__version__ = "0.1.0"
