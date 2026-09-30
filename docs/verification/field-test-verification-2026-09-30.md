# 现场测试独立验证报告（2026-09-30）

> 最后更新：2026-09-30
> 验证人：verifier（独立于 t2/t3/t4/t5/t12 的实现者）
> 权威来源：本文件是本轮**独立复核**的原始记录。所有判定都来自我在本机亲自跑的命令、读的代码与查的数据库；
> 不采信实现任务的回报文字。原始日志与中间产物在 `data/v6-*.log`、`data/v6-*.json`（未提交）。
> 三态约定：**通过** = 我亲自复现且结果与条款一致；**失败** = 复现出与条款不符的结果；**未测** = 我无法在本轮条件下验证（一律写清原因与用户可执行的补测步骤）。

## 0. 验证基线与方法

| 项 | 事实 |
|---|---|
| 起始修订 | `2b2321d`（t4 提交，`npm test` 当时 = 95 项） |
| 结束修订 | `2a3dd52`（t16：把 `tests/perception/`、`tests/console/` 接入 `npm test`）+ **两个未提交的在途文件**：`scripts/field-test.ts`、`scripts/verify-voice-noise.ts`（`git status` 显示 ` M`，验证期间 t16 仍在编辑） |
| 验证过程中遇到的中间态 | 12:06 左右 `npm test` 一度 **红**（`tests/console/field-test-console.test.ts` 报 `ERR_INVALID_TYPESCRIPT_SYNTAX`），原因是 t16 正在写 `scripts/field-test.ts`（半写状态）。文件 settled 后重跑 → 120/120 绿。**过程结论：并发编辑期间任何「全绿」声明都不可信，验证必须记录修订号** |
| 我的写权限 | 只写 `docs/verification/`。**未修改任何实现代码/测试/文档**（`git status` 里那两处 `M` 不是我改的） |
| 真实调用清单（花了钱的） | ① `node scripts/verify-voice-noise.ts --tiers 3,0` → **12 次真实 MiMo ASR**；② `npm run verify:provider` → **1 次真实 DSH→MiMo 工具回合**；③ 设备验收 3 次（本地播放/录音，无 API）。**未调用** TTS、未跑对话模型、未做真人语音采集 |
| 离线检查 | `npm test`、`check:docs`、`tests/console`、`tests/perception`、Python 两套单测、事件日志、SQLite、磁盘、出网扫描、`--self-test`、`--fake` |

## 1. 结论速览

| 任务 | 状态（实现者自报） | 我的判定 | 通过 | 失败 | 未测 |
|---|---|---|---|---|---|
| t2 噪声鲁棒语音前端 | failed（契约范围问题）→ t17 补正 | **实质通过** | 6 | 0 | 1（真人语音下的 ASR） |
| t3 摄像头在场检测 M6 | completed | **通过（1 项必须标未测）** | 7 | 0 | 1（真人在镜头前） |
| t4 现场测试控制台 | completed | **通过** | 7 | 0 | 2（人耳可听性、浏览器采集） |
| t5 核心接线修复 | completed | **部分通过** | 6 | **1（条款 2：CLI addressed）** | 1（--dsh 自然语言回合） |
| t12 残差修复 | completed | **通过** | 5 | 0 | 0 |

合计 34 条条款：**31 通过 / 1 失败 / 2 未测**（另有 3 条「通过但附缺陷」，见 §8）。

**必须先修的一条**：t5 条款 2 宣称「长停顿后下一句能被正确接受」，在**真实 CLI 路径上不成立**（缺陷 F1，§8.1）。

---

## 2. 逐任务逐条核对

### 2.1 t2 噪声鲁棒语音前端（7 条）

| # | 条款 | 判定 | 证据（命令 + 关键输出 + 位置） |
|---|---|---|---|
| 1 | 去直流 + 高通 + 噪声底自适应，参数有实测依据，来源写进 `docs/design/voice.md` | **通过** | `services/voice-edge/voice_edge/frontend.py:184-218`（`condition` = 去直流 + 零相位双二阶高通；`condition_for_vad` 用校准噪声底）、`:605-689`（`derive_frontend_params`：<100 Hz 占比 ≥50% → 120 Hz、≥20% → 100 Hz；门限 = 噪声底 + 余量；噪声底 > −35 dBFS → 建议采集增益 0 dB，理由串明写「实测 1:1 换回约 5.5 dB」）。依据来自 t1 实测（56% 低频占比、噪声底 −30.86 dBFS），我核对了 `docs/recon/field-test-environment-2026-09-30.md` §1.4 与代码里的数字一致 |
| 2 | `python -m voice_edge.calibrate` 在真实麦克风上可跑并输出 JSON（分带能量 + 建议参数） | **通过** | `cd services/voice-edge; .venvs/field-probe/Scripts/python.exe -m voice_edge.calibrate --seconds 5` → **exit 0**，JSON 含 `bandDbfs{under100,100-300,300-3400,3400-8000}`、`lowFrequencyShare 0.288`、`params{highpassHz 100, gateThresholdDbfs −22.9, suggestedCaptureGainDb 0, rationale[...]}`。注：仓库里的 `data/voice/frontend-profile.json` 的 source 是 `wav:..\..\data\recon\ambient-5s.wav`（**文件来源，不是活体校准**）；我这轮跑的是活体 |
| 3 | `tests/audio-fixtures/noisy/` ≥3 个 SNR 档，每条记录 SNR 与生成方式 | **通过** | 磁盘实测 30 个 WAV + `manifest.json`：5 个夹具 × 6 档（18/9/6/3/0/−6 dB），`noiseSource.path = data/recon/ambient-5s.wav`（t1 的真实环境录音）、`snrDefinition` 明写 300–3400 Hz 频带 + 前端条件化后测量、布局 `[150ms 前导+语音+500ms 尾] + [等长纯噪声段]`（`make_noise_fixtures.py:128-159`）。**我独立重算了全部 30 条**：按 `S²=M²−N²` 反推的语音带 SNR 与 `measuredSnrDb` 最大偏差 **0.42 dB**（多数 ≤0.1 dB） |
| 4 | `verify-voice-noise.ts` 输出转写/字符相似度/端点延迟/失败清单，退出码反映成败 | **通过** | 真实跑 `--tiers 3,0` → 报告含 `clips[].transcript/similarity/endpointDelayMs/failures`、`tiers[].meanSimilarity`、`failureList`，并且**有失败档时 exit 1**（实测 exit 1）；全通过档 `--tiers 18` 时 exit 0 |
| 5 | 给出可复现成功边界，困难样本不得删除 | **通过** | 我的独立真实跑：`lowestPassingTierDb = 3`，3 dB 档 4/4 检出、均值 0.805、0 条失败；0 dB 档 0.491、2 条 `SIMILARITY<0.6`。`noisy/` 里 −6 dB 与 0 dB 的困难夹具**都在磁盘上**（`npm test` 内有用例 `hard clips are kept, not deleted`） |
| 6 | 纯函数有离线单测（`tests/unit/voice/`），`npm test` 全绿 | **通过** | `node --test` 里 `front-end DSP unit tests pass (python, services/voice-edge/tests)`（39 项 Python）✔；`tests/unit/voice/frontend.test.ts` 7 项 ✔；`npm test` **120/120**（当前修订）与 95/95（起始修订）都绿 |
| 7 | `check:docs` 通过；`docs/design/voice.md` 已更新 | **通过** | `npm run check:docs` → 32 份 markdown，0 问题，exit 0；`docs/design/voice.md` 存在且写明高通/门限来源与边界（t17 已核实，我抽查了其中与 CAD 相关的 §1.6 谱减结论与脚本里 `--nr` 默认关闭一致） |
| — | （附加要求）成功边界的「绝对 dB」口径 | **未测/不确定** | 见 §9 不确定性 C1：manifest 的 SNR 是「语音 vs 噪声」，而文件里可观测的是「语音+噪声 vs 噪声」= 10log10(1+SNR)（0 dB 标签 → 3.0 dB）。用哪个口径读「3 dB 边界」会得到不同绝对值。两种口径我都复现了（±0.12 dB 内），但**真人语音条件下的边界未测** |

### 2.2 t3 摄像头在场检测 M6（8 条）

| # | 条款 | 判定 | 证据 |
|---|---|---|---|
| 1 | `services/perception-edge` 能从默认摄像头周期抓帧并在本地判定，连续视频不外传 | **通过** | `node scripts/verify-camera-presence.ts --seconds 15` → **PASS, exit 0**，`detector.face_backend=yunet`、`frames_seen=379`（25.3 fps）、`privacy{video_uploaded:false, stills_uploaded:0, frames_written_to_disk:0, network_clients:0, local_only:true}`。独立佐证：`services/perception-edge/perception_edge/*.py` 里**没有任何** `socket/requests/urllib/http/httpx/aiohttp` 导入（我的 grep 为空） |
| 2 | 检测器选型有书面理由与实测，且未引入 torch | **通过** | `docs/design/perception.md:81-87`（YuNet 227 KB 需下载 / Haar 930 KB 自带 18.64 ms 召回弱 / HOG 不用：空场景 0–2 误报、107.6 ms）+ `docs/recon/camera-detector-choice-2026-09-30.md`；`.venvs/cv4` 里**无 torch**（pip list 只 opencv-python-headless 4.14.0 + numpy）。`detector.py:13` 明写运行时不下载模型 |
| 3 | 状态变化写成 `presence.changed`（复用契约），未新增类型 | **通过** | `data/perception/field-test.sqlite` 的 `events` 表逐行：`presence.changed, schema_version=1, source=perception.laptop_camera, payload={present:false, source_detail:"state=absent startup frames=0 motion_ratio=0.0000 faces=0 gate=motion+face reason=camera_started"}`；`contract_problems: []`（验收脚本用已发布契约校验过） |
| 4 | 数据库有当前在场投影（迁移文件），含 value/source/updated_at/confidence/TTL，历史仍由事件日志保存 | **通过** | `packages/domain/src/migrations/002_world_state.sql`（新增表，`schema_version/value/source/updated_at/confidence/ttl_seconds` 一一对应 §5.3，注释说明投影可由事件重建）；`schema_migrations` 实测已应用 (1,001)(2,002)；`world_state` 实测 1 行 `('presence.home',1,'absent','perception.laptop_camera','2026-09-30T12:03:30+08:00',0.85,60.0)` |
| 5 | 防抖：短暂遮挡/单帧误检不翻转，参数与理由写进文档 | **通过** | `docs/design/perception.md §4`（帧差动 6 灰阶 + ≥0.5% 运动像素、每 10 帧 YuNet、15 帧入场 / 45 帧离场 / 3 s 释放宽限 / 1.5 s 最短证据）；`run.py` 同名参数 `--motion-pixel-threshold 6/--motion-min-ratio 0.005/--present-confirm-frames 15/--absent-confirm-frames 45` 与文档一致；离线用例含「高斯噪声不算运动」 |
| 6 | 离线回归覆盖有人/无人/误检边角，图片来源与许可已注明，`npm test` 全绿 | **通过（附缺陷 F5、F4）** | `tests/perception/`：node 10 项 + Python 39 项，我单独跑 **10/10、39/39 全过**；`scenes.py` 首行「Synthetic camera scenes, drawn by code: no external assets, no licence questions」（无外部素材 → 无许可问题），并**明确承认当前摄像头朝天**。**但**：接入 `npm test` 是 t16（`2a3dd52`）才做的，t3 完成时 `npm test=95` 并不包含这 49 项（缺陷 F5） |
| 7 | `verify-camera-presence.ts` 抓真实摄像头输出事件/帧率/耗时，无摄像头时明确失败 | **通过** | 真实跑（见 #1）；无摄像头路径我用 `--camera-index 9` 触发 `run.py` → **exit 2** + 中文可操作提示（「摄像头不可用，或已被其它程序占用…先关掉占用摄像头的程序」） |
| 8 | `check:docs` 通过；`docs/design/perception.md` 与选型报告已更新 | **通过** | `check:docs` exit 0；两份文档存在且内容与代码一致（我核对了模型来源/大小/耗时表与 `bench.py` 的 `needs_download` 字段） |
| — | 真人在镜头前的检出 | **未测** | 摄像头画面实测为天花板 + 衣柜（无人）→ 见 §9 U1（用户可执行自测步骤） |

### 2.3 t4 现场测试控制台（7 条）

| # | 条款 | 判定 | 证据 |
|---|---|---|---|
| 1 | 一条命令启动，只监听 127.0.0.1，中文界面可读 | **通过** | `node scripts/field-test.ts --offline --port 8799 --no-open` → 启动横幅「地址：http://127.0.0.1:8799｜只监听本机 127.0.0.1，别人访问不到」+ 中文三步上手；`--self-test` 内单测「服务只监听 127.0.0.1」（临时端口 62333 探到的是 127.0.0.1） |
| 2 | 页面显示麦克风电平/噪声底、摄像头在场、每轮延迟分段与最终动作（含拒绝原因） | **通过** | `--self-test` 24/24（含「页面包含全部中文说明与数字含义｜12 个标记全部存在」「每轮都有延迟分段（VAD/ASR/首字/总时长）」「每轮都有动作与原因的中文解释」）；在场卡片四态「投影/事件/未接入/读取失败」由 `readPresence()` 返回，未接入时是状态不是异常 |
| 3 | 内置设备验收引导（麦克风→扬声器→摄像头）+ 通过/失败/下一步 + 写报告文件 | **通过** | 我用 `runDeviceAcceptance({reportDir: <临时目录>})` 真机跑：三项顺序正确、逐项 `verdict` + `nextAction` + 证据 JSON + 落盘报告（202 行）。仓库里的 `docs/recon/field-test-report-2026-09-30.md` 结构相同（我抽读了 1-11、21-25、70-73、174-187 行） |
| 4 | 隐私：`/api/voice` 不再整段落盘；无语音时不留原始录音；只保留/清理语音段并说明策略 | **通过** | 对**真实运行的 offline 服务**发两次 POST（见 §5）：无语音 → 200 `SILENCE/NO_SPEECH_DETECTED`，`data/voice-web` 前/后都是 `[]`，`xixi-vad-*` 临时目录前/后都是 0；有语音 → 200 `SPEAK`，用了 1 段（320–2520 ms），`data/voice-web` 仍为 `[]`、临时目录 0。`.gitignore` 外的临时目录用 OS temp 且 `finally` 清理 |
| 5 | 多语音段不再静默丢弃 | **通过** | `--self-test`：`VAD 检出多段 [2 段] → 全部送进识别（2/2，丢弃 0）→ 识别收到 181868 字节（仅第一段约 104448）`；`tests/console` 有用例「every VAD segment is used; anything left out is reported with a reason」✔ |
| 6 | 修正过期数字（`docs/testing.md` §3「36 项」、README「36 项」「tests/scenarios 尚为空」、handoff「2.4×」） | **通过（但当前又漂移，见 F4）** | 实测：`README.md:91` 已写「`tests/scenarios/` 有语料（8 个场景）但没有 `*.test.ts`」；`docs/handoff.md:52` 已是 **2.57×**（22.3 vs 57.3 字）；`docs/testing.md:5` 当时写「95 项」与当时实际一致。**当前** `npm test` 已是 120 项而这三处仍写 95 → 新的漂移（F4，t16 引起） |
| 7 | `npm test`/`check:docs` 全绿；无麦克风/摄像头/密钥时给可读错误 | **通过** | `npm test` 120/120 exit 0、`check:docs` exit 0；错误面实测：缺音频 → **400**、未知接口 → **404** + 中文 `message+hint`、缺 Python/探测二进制 → 中文下一步（单测覆盖）；`--offline` 无密钥可用（我整轮隐私测试就是在 offline 下做的） |
| — | 人耳能否听到扬声器 / 浏览器麦克风采集 | **未测** | 见 §9 U2、U5 |

### 2.4 t5 核心接线修复（7 条）

| # | 条款 | 判定 | 证据 |
|---|---|---|---|
| 1 | `silence_tolerance` 真正接进 FSM，有「经引擎」而非手工构造的证据 | **通过** | 我自写脚本（`node --input-type=module`，独立于仓库测试）经 `ConversationEngine` 实测：同一 21 s 停顿在 `tolerance=1` → `lingerMs=45000` 且 `ACCEPTED_CONTINUATION`；`tolerance=0` → `lingerMs=15000` 且 `REJECTED_NOT_ADDRESSED`；`0.7` → 36000 且接受。落库 `conversation.decision` 里 `linger_ms/silence_tolerance` 与实际一致（45000/1、15000/0、36000/0.7） |
| 2 | `scripts/chat.ts` 的 addressed 语义修复：窗口超时回 IDLE 后下一句仍被接受 | **失败** | 见 §8.1 F1：`engine.state` 是**缓存**状态，全仓**无任何生产代码调用 `engine.tick()`**，因此长停顿后**第一句**仍 `REJECTED_NOT_ADDRESSED`，**第二句**才被接受。修复本身是真实改进（按 `docs/design/conversation.md:53-57` 的描述，旧逻辑是「超时后后面每一句都被拒」的**永久锁死**，现在只是**每次长停损失一句**），但条款字面要求的「下一句被接受」在 CLI 路径上不成立（只用显式 `tick()` 的集成测试能通过）；`conversation.md:50` 的「这条拒绝分支**不可达**」也不成立 |
| 3 | 被拒绝的轮次可审计（版本化事件 + reason，遵守铁律 5） | **通过** | `packages/contracts/schemas/events/conversation.decision.v1.json` + 实测落库（真实 DB 6 行 + 我自造 1 行）：payload 只含 `session_id/turn_index/accepted/reason/action/fsm_state/fsm_state_before/addressed/acceptance_score/linger_ms/silence_tolerance`，**无用户原话、无模型推理**；我自造的拒绝轮 `accepted:false, reason:REJECTED_NOT_ADDRESSED, action:SILENCE` 且 `recentTurns=0`（不进历史） |
| 4 | DSH 路径工具齐平：`plugins/xixi-tools` 增加只读 `xixi_get_weather` | **通过（附未测项）** | `plugins/xixi-tools/index.js:261` 定义工具、`:80/:101/:111/:244` 全部 `additionalProperties:false` + 执行前再校验、`:23-24` 与直连路径**同一** Open-Meteo 端点、`:145` 30 分钟缓存、`:211` 默认地点来自 `XIXI_PLACE`；单测 8 项在 `npm test` 全过；`npm run verify:provider` 真实 DSH→MiMo→工具调用 **exit 0**。未测：`--dsh` 的完整自然语言「问天气」回合（需交互式 CLI，本轮未跑，见 U4） |
| 5 | 适配器错误分类保真（AUTH/RATE_LIMIT/QUOTA 不再一律 PROVIDER_FAILED），有单测 | **通过** | `npm test` 内 `tests/unit/core/brain-error-classification.test.ts` 5 项 + 集成 1 项全过（输出可见「transport and provider failures become typed BrainErrors」「the DSH path keeps the harness error code in originalCode」）；`verify:provider` 真实链路 exit 0 |
| 6 | 死码与语义诚实（SESSION_MISMATCH、BACKCHANNEL/WAIT） | **通过** | 全仓 grep `SESSION_MISMATCH` → **0 命中**（已删除）；`tests/unit/core/dead-code-truthfulness.test.ts` 4 项断言「BACKCHANNEL/WAIT 无生产者」且契约仍接受这两个 action，`npm test` 全过；`docs/design/brain-and-models.md` 有对应说明（t5 自述，我核对了测试断言而非文档措辞） |
| 7 | `npm test` 全绿、`check:docs` 通过、两份设计文档已更新 | **通过** | 120/120 + `check:docs` exit 0（当前修订）；`docs/design/conversation.md`、`docs/design/brain-and-models.md` 均已被 t5 更新（抽查 `conversation.md` 的 FSM/窗口段与代码常量一致） |

### 2.5 t12 残差修复（5 条）

| # | 条款 | 判定 | 证据 |
|---|---|---|---|
| 1 | `mimo.ts` 的 MISSING_KEY 保真，有单测 | **通过** | `packages/model-adapters/src/mimo.ts:145` `const headers = this.#headers();` 在 `:147 try {` **之前**（注释 :139-142 说明为什么），`:129-131` 抛 `ModelError('MISSING_KEY')`；单测断言 `ModelError.code==='MISSING_KEY'` 且 `attempted===0`（fetch 未调用），`npm test` 过 |
| 2 | `tests/integration/brain-adapter.test.ts` 的 KNOWN GAP 用例被移除或改为「已修复」 | **通过** | 全仓 `grep 'KNOWN GAP'` → **0 命中**；`npm test` 里该文件 6 项全过（含「a missing API key fails as MISSING_KEY before any request is attempted」） |
| 3 | `docs/design/security-and-privacy.md` §6 更新 | **通过** | `:122` 「**被拒绝的轮次有记录**」、`:126` 「`reason_code` 与分值已落库」、`:133` 「仍然只存 `reason_code` 与分值…没有用户原话」 —— 与我的实测 payload 字段完全一致 |
| 4 | `plugins/xixi-tools/package.json` 的 description 反映两个工具 | **通过** | 实测 `description` = 「xixi 工具集（只读）：xixi_get_current_time + xixi_get_weather…」 |
| 5 | `npm test` 全绿（≥87 项）且 `check:docs` 通过 | **通过** | **120/120** exit 0、`check:docs` exit 0（当前修订）；起始修订为 95/95 |

---

## 3. 设备侧独立复现（真机）

### 3.1 端点读数（每次验证都读，这是 t1 的教训）

命令：`runDeviceAcceptance()` 的探测程序 + 我自己的 `data/recon/probe_volume.py`（pycaw，独立实现），两者一致：

| 端点 | muted | 音量标量 | dB | 备注 |
|---|---|---|---|---|
| 默认输出「扬声器 (Realtek High Definition Audio)」 | **false** | **0.661** | −6.19 dB | t1 已把出厂静音解除，本轮仍是 false |
| 默认输入「麦克风 (Realtek High Definition Audio)」 | false | **0.5647** | **+0.23 dB** | **注意**：t1 结束时是 +5.5 dB（标量 0.8012），本轮实测已被改成 ≈0 dB。**没有任何代码会设置它**（全仓无 pycaw 写调用），属于机器状态；这正是 t1/前端建议的配置，但无人保证 |

### 3.2 麦克风（「噪音很大」的当前数值）

`runDeviceAcceptance` 的 mic 探测（3 s，1 通道，44.1 kHz）实测：**RMS −32.32 dBFS、噪声底 −36.18 dBFS（50 ms 帧 p10）、峰值 −16.47 dBFS**。
对照 t1 勘测（2 通道平均、采集 +5.5 dB）：RMS −27.25 dBFS。差值 ≈ **5.4 dB**，与采集端点从 +5.5 dB 降到 +0.23 dB（−5.27 dB）吻合 → **独立确认了 t1 的「噪声随采集增益 1:1 变化」结论**。

判定：麦克风一项「通过（有风险）」是诚实的——它能录到声音，但底噪仍高（−36 dBFS），说话声只比它高几 dB 时识别会不稳。控制台把这条风险原文写进了 `nextAction`。

### 3.3 扬声器：把「程序渲染了」与「麦克风听到了」分开

| 结论类别 | 指标 | 验收脚本实测（我跑的） | 我的独立测量 | 说明 |
|---|---|---|---|---|
| **程序渲染了音频** | WASAPI loopback 与播放信号相关性 | **0.89**（对齐 269.2 ms） | **0.89**（对齐 249.2 ms） | 证据，不作门禁；静音时也会高（t1 §2.6 实测 0.9996 不变） |
| 播放信号本身 | 峰值 | −5.49 dBFS（削顶采样 0） | −5.49 dBFS（0） | 无削顶 |
| **麦克风真的听到了** | 播放窗 − 前置静音窗（帧级 dB） | **p95 差 11.68 dB**（判定 ≥10 → 通过）；**均值差 6.71 dB** | **p95 差 11.83 dB**；**均值差 6.75 dB**；**能量比只有 2.69 dB** | 见 F2：门限用的是帧级**分位/均值**口径 |

### 3.4 摄像头

| 项 | 实测 |
|---|---|
| 后端/分辨率 | `CAP_DSHOW`、640×480（最大可到 1280×720） |
| 帧率 | 验收脚本 15 s 内 379 帧（**25.3 fps**）；console 探测 15 帧 **27.9 fps**（t1 勘测 30 fps 同量级） |
| 画面 | `lumaMean 124.3 / lumaStd 36.9 / uniqueLuma 202`（真实有效画面，非纯黑/纯色） |
| 在场检测 | `world_state.presence.home = absent`（TTL 60 s、confidence 0.85、`stale=false`），无人画面 0 次转换（正确结果） |

---

## 4. 数据侧（测试数据的来源与独立复核）

| 数据 | 数量/来源 | 我的独立复核 |
|---|---|---|
| 干净语音夹具 | `tests/audio-fixtures/*.wav` 5 个（backchannel/direct-question/followup-turn/longer-turn/tv-dialogue），由 `scripts/make-audio-fixtures.ts` 用 MiMo TTS 生成 | 直接使用 |
| **噪声夹具** | `tests/audio-fixtures/noisy/` **30 个** = 5 夹具 × 6 档（18/9/6/3/0/−6 dB）；噪声源是 **t1 的真实环境录音** `data/recon/ambient-5s.wav`（不是合成白噪）；生成方式记在 `manifest.json`（含 `snrDefinition`、布局、lead/tail padding） | **独立重算 30 条**：用 `S²=M²−N²` 反推语音带 SNR → 与 `measuredSnrDb` 最大偏差 0.42 dB；`混合/噪声` 比值与理论 10log10(1+SNR) 偏差 ≤0.12 dB。**结论：标签诚实、可复现** |
| **在场/不在场测试帧** | `services/perception-edge/perception_edge/scenes.py` 用代码绘制（`empty_static`/`empty_noisy`/`person_moving`/`person_still_on_face_scene`），首行明写「no external assets, no licence questions」 | 跑 `tests/perception` 10/10 + Python 39/39 通过；`--self-test` 用同一套生成帧跑「检测→事件→投影」写库链路，输出里明确标注 `mode: "self-test (generated frames, not a real person)"` → **没有拿合成图冒充真人实测** |
| 检测器选型的正对照图 | `data/models/{largest_selfie.jpg,lena.jpg,vtest.avi}`（t1 从公开源下载，仅供本机比对检测器是否会空转） | 这些**没有**被当作「真人实测」证据；`docs/design/perception.md` 明确把真人检出列为待测 |

---

## 5. 隐私侧独立验证

命令：起真实服务 `node scripts/field-test.ts --offline --port 8799 --no-open`，用 `fetch` 发两次 `POST /api/voice`（`{audioBase64}`）。

| 场景 | HTTP | 动作/原因 | `data/voice-web` 前 → 后 | `xixi-vad-*` 临时目录前 → 后 |
|---|---|---|---|---|
| 800 ms 纯静音 | 200 | `SILENCE` / `NO_SPEECH_DETECTED` | `[]` → `[]` | 0 → 0 |
| 真实语音夹具（direct-question） | 200 | `SPEAK` / `ACCEPTED_WAKE_OR_DIRECT`，用 1 段（320–2520 ms） | `[]` → `[]` | 0 → 0 |
| 缺音频字段 | 400 | 中文可读错误 | `[]` | 0 |
| 未知接口 | 404 | 中文 `message+hint` | — | — |

**结论：条款 4 的「整段录音不落盘」在真机、真服务、真 VAD 上成立**（有语音与无语音两种情况都没有在 `data/voice-web` 留下任何文件）。连续视频不外传：`services/perception-edge` 无任何网络客户端导入（我的 grep 为空），验收脚本 `privacy.network_clients = 0`。

---

## 6. 事件侧独立验证

**被拒绝的轮次可审计（t5 条款 3）**：

| 来源 | 条数 | 说明 |
|---|---|---|
| `data/chat/xixi.sqlite` | 6 行 `conversation.decision` | 我用 `node:sqlite` 直读，payload 含 `accepted/reason/action/fsm_state_before/addressed/acceptance_score/linger_ms/silence_tolerance` |
| `data/voice/xixi.sqlite` | 2 行 | 同上 |
| 我自造的拒绝轮（临时库） | 1 行 | `accepted:false, reason:REJECTED_NOT_ADDRESSED, action:SILENCE, addressed:false`，且 `recentTurns=0` |

**发现（F9，info）**：真实库里**所有** `conversation.decision` 行的 `accepted` 都是 `true`——「拒绝可审计」这条目前只有单测/我自造的临时库证据，没有任何一次真实运行的拒绝记录。机制通过、真实拒绝样本未出现。

**在场事件与投影一致性**：`events` 表有 `presence.changed` v1 行、`world_state` 有对应行、`contract_problems: []`；离线用例还断言「事件与投影同事务、无第二写入方、投影可由日志重建」。

---

## 7. 下游是否真的采用了 t1 的地面事实（逐条）

| t1 结论 | 是否真的落地 | 证据 |
|---|---|---|
| 100–120 Hz 高通 | **是（硬编码常量）** | `frontend.py:644-652` 按 <100 Hz 占比选 120/100/80 Hz；`segment.py:273` 默认 `--highpass-hz 120`；`verify-voice-noise.ts:158` 也是 120。**但**：校准产物的 `highpassHz` 只作展示，前端不读它（我的活体校准给出 100 Hz，因为那次 <100 Hz 占比 28.8%）→ F8 |
| 采集增益设 0 dB | **半是**：代码只「建议」，机器状态「已改」 | `frontend.py:661-669` 建议 0 dB + 理由；控制台 `nextAction` 提示用户去改；**没有任何代码设置端点增益**（pycaw 只用于读）。当前端点实测 +0.23 dB（= 有人手工/脚本改过），仓库里查不到是谁改的 → F7 |
| WASAPI 优先 | **部分**：仅校准路径 | `calibrate.py:41 HOST_API_PREFERENCE = ("Windows WASAPI", "MME", ...)`（校准按此排序选输入设备）；设备探测的麦克风/扬声器仍走 PortAudio 默认（本机 = MME），浏览器采集不受我们控制 |
| `CAP_DSHOW` / 640×480 | **是** | `field-test.ts:1109-1116`（`cv2.VideoCapture(0, cv2.CAP_DSHOW)` + 640×480）、`perception_edge/camera.py`（DSHOW，1080p 请求封顶 1280×720） |
| YuNet + 帧差动 | **是** | `detector.py` 帧差动（6 灰阶 / ≥0.5% 像素，320×240 处理分辨率）+ 每 10 帧 YuNet（227 KB onnx，`load_yunet_model_path` 定位，运行时不下载） |
| 避免 HOG | **是，且写明理由** | `detector.py` 顶部注释直接引用「空场景 0–2 误报」；`perception.md:86` 同结论 |

---

## 8. 缺陷清单（最小复现 + 影响面 + 建议严重度）

> 我**没有**修改任何实现代码。以下交回 captain 决定是否修、以及由谁修。

### 8.1 F1（medium）：CLI 的 addressed 语义修复没覆盖真实路径 —— 长停顿后第一句仍被拒

- **最小复现**（不依赖任何仓库文件；`cd E:\worker2` 后把下面脚本喂给 `node --input-type=module`）：
  ```js
  // 与 scripts/chat.ts:127 完全相同的规则：addressed = engine.state === 'IDLE'
  const { FakeBrainAdapter } = await import('@xixi/brain-adapter');
  const { ConversationEngine } = await import('@xixi/conversation');
  const { openXixiStore } = await import('@xixi/domain');
  // 用可控时钟：第一句 → 前进 10 分钟 → 第二句（中间不调用 engine.tick()）
  ```
  实测序列（我跑到的原始结果）：`line1(state=IDLE) → accepted=true`；前进 10 分钟后 `line2 → addressed=false → accepted=false, REJECTED_NOT_ADDRESSED`；`line3 → accepted=true`。若在第二句前调用一次 `engine.tick()`，第二句立刻 `accepted=true`。
- **根因**：`engine.state`（`packages/conversation/src/engine.ts:117`）返回 FSM 的**缓存**状态，时钟只在 `tick()`（`:199`）或 `respond()` 内部推进；而**全仓没有任何生产代码调用 `engine.tick(`**（我对 `scripts/ packages/ apps/` 的 grep 为空）。t5 的集成测试之所以通过，是因为它在断言前显式调用了 `engine.tick(...)`（`tests/integration/conversation-engine.test.ts:243`）。
- **影响面**：用户休息一段时间后说的**第一句话会被无声拒绝**（页面上显示「未接受（REJECTED_NOT_ADDRESSED）」），第二句才会被接受。公平地说，修复**确实有效**：按 `docs/design/conversation.md:53-57` 的描述，旧逻辑（局部变量 `first`）在超时后会让**后面每一句**都被拒（等于永久锁死），现在只是**每次长停顿损失一句**。但 t5 条款 2 的字面要求（「下一句仍能被正确判定与接受」）仍未达成；`docs/design/conversation.md:50` 写的「`IDLE` 且未直呼这条拒绝分支**不可达**」与实测不符（每次长停顿后可达一次）。
- **建议严重度**：medium（不影响数据安全，但直接违反一条验收条款 + 用户可见的行为缺陷）。
- **建议修法（供 captain 决定）**：在 `chat.ts` 与 `serve-chat.ts` 计算 `addressed` 前先 `engine.tick()`（一行），或让 `engine.state` 以 `clock()` 实时求值。

### 8.2 F2（medium）：扬声器 10 dB 门限用的是「帧级 dB 分位」，不是能量比 —— 报告数字会高估约 9 dB

- **最小复现**：同一段回环录音同时算两种口径（我用的脚本逻辑与 `field-test.ts:1067-1094` 一致：`band_frame_db` 逐 50 ms 帧）：
  - 播放窗 p95 − 前置静音窗均值 = **11.83 dB**（console 实测 11.68 → 判定通过）
  - 播放窗均值 − 前置静音窗均值 = **6.75 dB**（console 6.71）
  - 播放窗语音带 RMS − 前置静音窗语音带 RMS = **2.69 dB**（若按 t1 §2.4 的 0.8–2.6 dB 口径，这条会 FAIL）
- **影响面**：报告中「通过（临界）：11.68 dB」会让读者以为声学余量很大；与勘测「夹具电平下只有 0.8–2.6 dB 抬升」表面矛盾（同一物理路径，两种口径）。门限方向性没错（静音时 p95 差会掉到 1–3 dB → FAIL），但**绝对 dB 不可解释为「信号比噪声高多少」**。
- **建议严重度**：medium（结论可信度/文档口径问题，非功能缺陷）。
- **建议**：在报告与页面标注该数字是「帧级峰值统计，不是能量比」，或增加一列能量比并按勘测阈值（如 ≥2 dB）判定。

### 8.3 F3（low）：`verify-voice-noise.ts` 的 `minSimilarity` 实际算的是均值

- **位置/复现**：`scripts/verify-voice-noise.ts:382` `minSimilarity: mean(rows.map((row) => row.similarity))`。实测 `data/voice/verify-voice-noise.json` 里 5 个 tier 的 `minSimilarity === meanSimilarity` 全部相等（clean 0.8/0.8、18dB 0.841/0.841、3dB 0.805/0.805、0dB 0.491/0.491）。我自己那轮（`data/v6-voice-noise-t3-t0.json`）同样相等。
- **影响面**：只读汇总字段的人若以「minSimilarity ≥ 0.6」判断，会漏掉最差的一条（真实最差在 `clips[].similarity`）；tier 的 PASS/FAIL 判定本身用的是逐条 `failures`，所以**门禁没有被绕过**。
- **建议严重度**：low（报告保真）。**建议**：改成 `Math.min(...)`。

### 8.4 F4（low）：`npm test` 从 95 → 120 后，四处文档数字仍写 95

- **复现**：`npm test` → `ℹ tests 120 / pass 120`；而 `docs/testing.md:5`、`:124`、`README.md:40`、`docs/handoff.md:28`、`:117` 仍写「2026-09-30 实测 **95 项**」，`testing.md:5` 还把范围写成「unit 77 + integration 18」（现在是 unit+integration+perception+console）。`check:docs` 不校验数字，所以仍绿。
- **影响面**：接手者会低估回归覆盖（漏掉 10 项在场检测 + 15 项控制台）。这是 t16 的改动引起的**新漂移**，不是 t4 的错（t4 当时 95 是准确的）。
- **建议严重度**：low（文档准确性，但属于项目硬规则「文档与代码同步」）。

### 8.5 F5（low）：t3 完成回报的「38 用例已接进 npm test」与核对时的事实不符

- **复现**：在 t3 的提交态（`2b2321d`）跑 `npm test` → 95 项，`tests/perception/` 的 10 项 node + 39 项 Python **都不在 glob 内**（`Select-String 'perception' data/v6-npmtest.log` 为空）。t16（`2a3dd52`）接入后 → 120 项。
- **影响面**：自述把「写了测试」说成「已接入回归」，会让下游误判保护力度（现已修复）。**建议**：以后自述里的「已接入 npm test」必须附 glob 实测输出。

### 8.6 F6（info）：扬声器门限允许「最多 3 次取较好值」

- **位置**：`scripts/field-test.ts:1396-1411`（`best >= 10` 才停止复测）。三次数字都进证据，属于已披露的取舍；但「取较好值」会略微抬高假 PASS 概率。
- **建议**：报告里同时展示三次的**最差/均值**，或对「临界通过」标注需人工确认。

### 8.7 F7（info）：采集增益「建议 0 dB」没有代码校验环节

- 代码只建议（`frontend.py:661-669`）与提示（控制台 `nextAction`），无人保证端点真的在 0 dB；当前端点实测 +0.23 dB 是**别人手工/脚本改的**（仓库内查不到写入方）。换机器或被系统改回时，页面会显示读数与建议，但不会判 FAIL。**建议**：麦克风一项增加「端点音量与建议值偏差 >3 dB → 信息提示/警告」的对照。

### 8.8 F8（info）：校准建议与实际前端参数不联动

- 活体校准给出 `highpassHz 100`（因那次 <100 Hz 占比 28.8%），而运行路径固定用 120 Hz（`segment.py:273`、`verify-voice-noise.ts:158`）。当前差异对结果影响小，但「校准产物」与「实际参数」是两个来源，容易被误读成「已按校准跑」。

### 8.9 F9（info）：真实数据库里没有一条「被拒绝」的 conversation.decision

- 只读 `data/chat/xixi.sqlite`(6) 与 `data/voice/xixi.sqlite`(2)：`accepted` 全为 `true`。机制有测试与我的自造样本兜底，但**真实运行的拒绝样本为 0**（见 §6）。**建议**：`npm run field-test` 的引导步骤里加一句「对电视方向说一句不该应答的话」以产生真实拒绝样本。

---

## 9. 未验证项与不确定结论（不得当作通过）

**未验证（我能说明原因，并给出用户可执行的补测步骤）**

| ID | 未验证事项 | 原因 | 用户可执行的补测 |
|---|---|---|---|
| U1 | M6「真人站在镜头前能被检出」 | 本机摄像头上仰朝天（我复核的帧是天花板/衣柜，`frames_with_evidence=0`） | `node scripts/verify-camera-presence.ts --seconds 40 --require-transition`（人站到镜头前）；或 `npm run field-test` 打开页面看在场卡片是否翻转为「在场」 |
| U2 | 人耳能否听到扬声器 | 本轮无人听音 | 用户播放一次：`npm run field-test` 页面点设备验收的扬声器一项（会响 ~3 s） |
| U3 | 真人对着麦克风说话时的 ASR 准确率 | 本轮真实 ASR 用的是「干净夹具 + 叠加真实环境噪声」的夹具，不是真人对着本机麦克风说的录音 | `npm run field-test` 用页面「按住说」录一句；或 `npm run voice:turn -- --wav <你的录音.wav>` |
| U4 | `--dsh` 路径完整自然语言「问天气」回合 | `--dsh` 是交互式的，本轮只跑了一次真实 DSH 工具调用（`npm run verify:provider` exit 0） | `npm run chat -- --dsh` 后问「成都明天天气怎么样」 |
| U5 | 浏览器麦克风采集（getUserMedia）与真实 TTS 回放 | 需要人按页面按钮，且会调用 TTS | `npm run field-test` → 按页面「按住说」 |
| U6 | 物理拔掉摄像头的情形 | 只能用 `--camera-index 9` 模拟（已实测 exit 2 + 中文提示） | 拔掉再跑 `node scripts/verify-camera-presence.ts` |
| U7 | 真机端到端对话总延迟 | 只有 `--self-test` 替身路径的分段（VAD 1535 ms / 首字 18 ms / 总 1564 ms） | 页面录一句后读「延迟分段」 |

**不确定结论（我不下判断）**

- C1 扬声器耦合的「真实余量」：2.69 dB（能量比）与 11.83 dB（帧级 p95）都可以复现，取决于口径（F2）。
- C2 麦克风底噪的来源（电子自噪声 vs 环境声场）：t1 的相干性 ≈0 支持「电子」，但需要物理遮挡麦克风才能定论。
- C3 采集端点增益被谁改到 +0.23 dB：我只观察到状态（t1 结束时是 +5.5 dB），仓库里查不到写入方。
- C4 边界数值的绝对含义：噪声夹具的 SNR 定义（语音 vs 噪声）与文件可观测口径（混合 vs 噪声）差 10log10(1+SNR)，见 §2.1 末行。

---

## 10. 本轮真实调用记录（可核账）

| 调用 | 次数 | 结果 | 产物 |
|---|---|---|---|
| MiMo ASR（`verify-voice-noise --tiers 3,0`） | 12 | clean 4/4 均值 0.800；3 dB 4/4 均值 0.805（0 失败）；0 dB 0.491（2 失败）→ verdict FAIL、exit 1（与实现者自报一致） | `data/v6-voice-noise-t3-t0.json`、`data/v6-voice-noise.log` |
| DSH→MiMo 工具回合（`npm run verify:provider`） | 1 | exit 0，「DSH → MiMo → 工具调用 → 回答 全链路可用」 | 控制台输出 |
| 设备验收（麦克风 3 s + 扬声器回环 + 摄像头抓帧） | 1 轮（含 1 次扬声器复测逻辑，本轮 1 次即达阈值） | overall **pass** | 临时报告（我指向 TEMP，**未覆盖** `docs/recon/field-test-report-2026-09-30.md`）+ `data/v6-acceptance.log` |
| 我自写的扬声器独立测量 | 1 | 见 §3.3 | `data/v6-speaker-independent.json` |
| 活体噪声校准 | 1 | exit 0，高通 100 Hz / 门限 −22.9 dBFS | `data/v6-calibrate-live.json/.txt` |
| 在场检测验收（15 s 真机）+ 生成帧自检 | 2 | 均 PASS / exit 0 | `data/v6-camera.log` |
| 隐私 POST（静音 / 真实语音 / 400 / 404） | 4 | 见 §5 | 内联输出 |

**没有调用**：TTS 合成、对话模型（离线替身代替）、真人语音采集、`--dsh` 自然语言回合。

---

## 11. 复现命令汇总（我实际跑过的）

```powershell
cd E:\worker2
# 离线基线（当前修订应为 120 项；起始修订 2b2321d 为 95 项）
npm test
npm run check:docs
node --test "tests/perception/**/*.test.ts"        # 10 项
node --test "tests/console/**/*.test.ts"           # 15 项
# Python 两套
E:\worker2\.venvs\cv4\Scripts\python.exe -m unittest discover -s tests\perception -p "test_presence.py" -v   # 39 项
# t2
cd services\voice-edge; E:\worker2\.venvs\field-probe\Scripts\python.exe -m voice_edge.calibrate --seconds 5
cd E:\worker2; node scripts\verify-voice-noise.ts --tiers 3,0 --out data\v6-voice-noise-t3-t0.json   # 真实 ASR，12 次
node scripts\verify-voice-noise.ts --fake          # 离线管线（当前修订 exit 0，起始修订 exit 1 —— 行为已变）
# t3
node scripts\verify-camera-presence.ts --seconds 15
node scripts\verify-camera-presence.ts --self-test   # 生成帧，明确标注非真人
cd services\perception-edge; E:\worker2\.venvs\cv4\Scripts\python.exe -m perception_edge.run --camera-index 9 --seconds 2   # exit 2
# t4
node scripts\field-test.ts --self-test               # 24/24
node scripts\field-test.ts --offline --port 8799 --no-open   # 然后 POST /api/voice（见 §5）
# t5 / t12
npm run verify:provider
npm run turns -- data\chat\xixi.sqlite 6
```

## 维护规则

- 本文件是**带日期的历史记录**（docs/verification 层）：新的验证写新的 `field-test-verification-YYYY-MM-DD.md`，不要改写本文的判定与数字。
- 本文的判定绑定 §0 记录的修订：**`2a3dd52` + 在途的 `scripts/field-test.ts` / `scripts/verify-voice-noise.ts`**。若之后再改这两处或 `package.json` 的 glob，本文相关结论（尤其 F3/F4/F5 与 `--fake` 行为）需重新验证。
- 缺陷由 captain 决定修复归属；修完应在**下一个**验证任务里复核，而不是把本文的「失败」直接改成「通过」。
