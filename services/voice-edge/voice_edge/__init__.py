"""Voice Edge — 本地音频侧（《方案》§14）。

职责边界（ADR-0007）：
  本目录只负责音频：VAD 分段、端点判定、离线打断判定，以及未来的设备 I/O。
  ASR / TTS 走小米 MiMo（由 Node 侧 `packages/model-adapters` 调用），
  唤醒词、backchannel 判定、电视/真人区分一律由西西自己的逻辑负责。
"""

__all__ = ["config", "segment"]
