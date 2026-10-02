# t3 流式语音（pack Phase 8）实测记录 — 2026-10-01

基线修订号（我开工时的 HEAD）：3f054fd
完工时 HEAD：1dc2102（captain 期间提交了 t2 与两处文档；我的产物仍全部在工作区，未提交）

## 一、命令与口径

四段延迟的口径逐字来自 docs/benchmarks/v01-baseline.md §3.1：
① VAD end → ASR final（speech.endpointDelayMs 单列、不折进①）
② ASR final → 首个模型 token（含引擎组装与首个流式 chunk）
③ 首个 token → 首个可听音频（V0.1 是「整段回复一次合成」的上界；流式改造后是「第一块」的合成）
④ ①+②+③+端点保持（e2eToFirstReplyAudioMs 的口径）

同批「改造前」对照：`--legacy-tts` 在**同一次调用、同一段回复文本**上再做一次整段合成，
所以两列可以逐轮配对；V0.1 的历史列（n=16，2026-09-29 四批）只作为旁证印在报告里，不合并。

### 实测命令（3 批 × 4 夹具 = 12 轮，真实调用 ASR + LLM + TTS）

```
node scripts/voice-turn.ts --wav tests/audio-fixtures/direct-question.wav --wav tests/audio-fixtures/followup-turn.wav --wav tests/audio-fixtures/longer-turn.wav --wav tests/audio-fixtures/tv-dialogue.wav --trace
```
连跑 3 遍，raw 输出存 data/voice/bench/final2-1|2|3.txt（data/ 已 gitignore）。

## 二、结果（n=12，P50/P90 线性插值，与基线同规则）

| 指标 | P50 | P90 | 最小 | 最大 |
|---|---:|---:|---:|---:|
| ① VAD end → ASR final | 449 | 668 | 318 | 676 |
| ② ASR final → 首 token | 1962 | 4654 | 505 | 6825 |
| ③ 首 token → 首段可听 | 1719 | 3017 | 1078 | 3262 |
| ④ 首段可听总延迟 | 4626 | 8067 | 2479 | 10919 |
| 参考：每轮块数 | 1 | 2 | 1 | 2 |
| 参考：首块字数 | 13 | 16 | 6 | 29 |

对照（同一批 --legacy-tts，n=12）：
③(整段回复一次合成) P50 1214 / P90 2050；④ 合计 P50 3971。
V0.1 历史列（docs/benchmarks/v01-baseline.md §3.2，n=16，非同一批）：
① 569 / ② 2629 / ③ 2285.5 / ④ 6816。

结论：④ P50 6816（V0.1）→ 4626（本批，-32%）；③ 与 V0.1 的 2285.5 不可直接比
（一个是「整段回复」一个是「第一块」，物理量不同），但与同一批的整段合成 1214 相比，
流式并没有把 ③ 压到 1.5 s 以内。**目标 P50 ≤ 1.5 s 未达成**：P50 1719 ms（超出 15%），
且 ② 的 P50 1962 ms 单独就已经超过 1.5 s —— 见下面的归因。

## 三、为什么打不中 1.5 s（可复算的归因）

1. ④ = 端点保持(≈450–680) + ②(1962) + ③(1719)。要让 ④ ≤ 1500，②+③ 必须 ≤ ~1000，
   而 ② 单独就接近 2000 —— 这是模型首 token 的延迟，不是流式改造能改的量。
2. ③ 的构成（--trace 逐 delta + 直接探针实测）：
   - 首 token → 首块 dispatch：早期版本 0（等整段）→ 现在 60–300 ms（首个逗号即放行）；
   - MiMo TTS 单次往返实测（同一进程、同一 key、4 种长度 × 3 轮）：
     2 字 581/870/1050 ms、3 字 711/785/860 ms、13 字 969/1150/1185 ms、30 字 1613/1806/2016 ms。
     即首块 10–16 字 ≈ 1.0–1.3 s，这就是 ③ 的下限。
3. 想达到 1.5 s 只有两条路（都不在本轮范围内）：
   (a) 更快的 TTS（本地或更低延迟的合成端点）；
   (b) 首块切到 4–6 字（③ ≈ 0.6–0.9 s），代价是听感变碎、总时长与调用数上升。
   另外必须同时把 ② 压到 ~600 ms，否则 ④ 仍到不了 1.5 s。

## 四、打断与应和的离线测量

```
npm run voice:bargein            # exit 0（= node scripts/voice-bargein.ts）
node scripts/voice-bargein.ts --strict   # exit 0
```
- 判定延迟 192 ms ≤ 500 ms 目标（VAD 提交 STARTING/SPEAKING − 真实语音起点）；
- 播放队列：3 段，已听 992 ms，丢弃 3 段（5408 ms 未播音频）；
- **可听停止判据**（新增，--strict）：打断 200 ms 后仍可听 = 否；被判停后位置不再推进；
- 应和候选：本夹具只有 1 段语音，无内部停顿（pauseMs 空），决策 = 无 —— 如实报告。
- 仍未验收：扬声器物理静音延迟（需设备验收，caveat 字段写明）。

## 五、门禁

```
npm test        → ℹ tests 437 / pass 437 / fail 0 / exit 0（duration_ms 24831）
npm run check:docs → 检查了 94 份 markdown；失效链接 0；exit 0
npm run voice:bargein → exit 0
```