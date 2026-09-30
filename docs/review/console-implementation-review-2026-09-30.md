# 评审：现场测试控制台与隐私修正（t4 产物）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t4 实现者 app-engineer 与 verifier）
> 日期：2026-09-30
> 评审对象：t4「现场测试控制台（单命令入口 + 引导式设备验收 + 隐私修正）」的**产物本身**
> 复核对象：t6 / `docs/verification/field-test-verification-2026-09-30.md` §2.3（独立验证报告）
> 唯一写入路径：本文件。未修改任何实现代码、测试或其他人的文档。
> 权威来源（本评审实际跑过/读过的）：`scripts/field-test.ts`、`scripts/serve-chat.ts`、`scripts/voice-turn.ts`、`tests/console/field-test-console.test.ts`、`package.json`、`docs/testing.md`、`docs/handoff.md`、`README.md`、`config/xixi.example.yaml`、`docs/recon/field-test-report-2026-09-30.md`，以及**我本人在真机上启动的控制台**（live HTTP 探针）

---

## 1. 结论

**verdict：needs_revision（实现是真实的：三条关键判据我都在真机上亲自复现过；findings 只有 1 条，是「派生产物/文档里已经过时的自检项数」，不是隐私或功能缺陷）**

一句话：**隐私修正是真的，不是注释**——我自己启动控制台、亲自发了三次 `/api/voice`（无语音 / 有语音 / 两段语音），`data/voice-web` 前后都是空的、`xixi-vad-*` 临时目录前后都是 0、`speechAudioOnDisk` 三次都是 `null`，响应里还写出被删掉的临时目录路径；多段语音是真的（一段 6.4 s 录音里 VAD 出 2 段 → `segmentsUsed: 2`、`droppedSegments: []`、notes 明写「2 段语音，已全部使用」）；保留/清理策略是真的（我直接调用 `pruneVoiceDir` 跑了两套策略，旧文件删、新文件留、`unrelated.txt` 与子目录不受影响）。t4 自认的两处未声明改动（`package.json`、`scripts/voice-turn.ts`）**必要且正确**，并且**归因清楚：是 captain 的 inScope 遗漏**（条款 5 明写 `voice-turn.ts`、条款 1 要求「一条命令」，两个文件都没进 inScope），不是成员越权。

| 维度 | 判定 |
|---|---|
| t4 的 7 条验收标准 | **7 条真正满足**（第 6 条附 F1，属「当时对、现在漂移」，不推翻条款成立） |
| 隐私修正（无语音不留原始录音） | **我亲自在真机复现：成立**（见 §3.1） |
| 多语音段不再静默丢弃 | **我亲自复现：成立**（见 §3.2） |
| 保留/清理策略真的生效 | **我直接调用 pruneVoiceDir 复现：成立**（见 §3.3） |
| 两处未声明改动 | **必要、正确、归因于 captain 的 inScope 遗漏**（见 §4） |
| 复核 verifier | **它的 t4 结论是基于真实运行**（真实 POST + 真机验收），不是只读代码；我的 live 探针与它逐条吻合 |
| 文档诚实性（条款 6 指定的三处数字） | **三处都改了**（36→95、`tests/scenarios` 有语料、2.4×→2.57×）；只有**自检项数 24**这一处现在是错的（F1） |
| 环境门禁 | 我自己复跑：`tests/console` **15/15**、`npm test` **133/133**、`check:docs` **exit 0**、`--self-test` **31/31** |

---

## 2. 逐条核对 t4 的 7 条验收标准

| # | 条款 | 判定 | 我自己的核对方式与结果 |
|---|---|---|---|
| 1 | 一条命令启动，只监听 127.0.0.1，中文界面，非工程师看得懂 | **真正满足** | 我实跑 `node scripts/field-test.ts --offline --port 8807 --no-open --no-tts` → 启动后 `GET /` = **HTTP 200、26901 字节**；`--help` 也**真的实现了**（`node scripts/field-test.ts --help` → 打印用法后 exit 0，不占端口，输出里明写「只监听本机 127.0.0.1，别人访问不到」）。页面标记我逐个在 HTML 里查过：麦克风/噪声底/在场/未接入/延迟/VAD/ASR/首字/总时长/沉默/拒绝/隐私/保留策略/设备验收/按住说/127.0.0.1 **全部 present**。反例核对：`package.json` 有 `field-test` 脚本，且全仓 24 个 `npm run X` 引用**全部存在**（无悬空命令） |
| 2 | 页面显示麦克风电平/噪声底、在场状态、延迟分段、最终动作（含沉默与拒绝原因） | **真正满足** | 同上 HTML；另外每轮响应里 `stages{vadMs,asrMs,llmFirstChunkMs,llmTotalMs,ttsMs,totalMs}`、`action`/`actionText`/`reason`/`reasonText` 都在我三次 live 请求的 payload 里（例如 `action:"SILENCE"` + 「沉默（西西决定不说话）」+ 「没有听到人声：麦克风里没检测到语音段」） |
| 3 | 设备验收引导（麦克风→扬声器→摄像头）+ 通过/失败/下一步 + 写报告 | **真正满足** | `--self-test` 里三项顺序与逐项结论都在（「麦克风（说话能不能进来） / 扬声器（西西说话你能不能听到） / 摄像头（西西在不在场）」→ `pass,fail,pass`），并给出「下一步动作」；报告落盘用**替身设备**实测 244 行（真机报告 `docs/recon/field-test-report-2026-09-30.md` 由 verifier 真机跑过，我抽读了它的结构与逐项证据 JSON） |
| 4 | **隐私修正**：不再整段落盘；无语音时磁盘不留原始录音；只保留/清理语音段并说明策略 | **真正满足（我在真机亲自复现）** | 见 §3.1：无语音 → `voice-web` 前后 `[]`、`xixi-vad-*` 前后 0、note 明写「磁盘上不会留下任何录音（连临时文件也已删除）」；有语音 → 同样 `[]`/0、`speechAudioOnDisk:null`；策略对象（含 `reason` 与来源 `config/xixi.example.yaml`）随每次响应返回 |
| 5 | **多语音段不再静默丢弃**：`/api/voice` 与 `voice-turn.ts` 使用全部语音段 | **真正满足（我在真机亲自复现）** | 见 §3.2：我把两段夹具拼成一段（中间 1.5 s 静音）→ VAD 出 2 段 → `segmentsTotal 2 / segmentsUsed 2 / droppedSegments []`，notes 明写「2 段语音，已全部使用（按顺序拼接，段间插入 300ms 静音）」；`npm run voice:turn -- --fake` 同一条核心路径 exit 0 |
| 6 | 修正过期数字：testing.md「36 项」、README「36 项」「tests/scenarios 尚为空」、handoff「2.4×」 | **真正满足（附 F1）** | 我逐处核对：`docs/testing.md:5` 已从「36 项」改为「95 项」且**补上了 `tests/scenarios/ 是语料模块、tests/replay/ 仍为空，都不产生用例`**；`README.md:91` 已是「`tests/scenarios/` 有语料（`corpus.ts`，8 个场景）但没有 `*.test.ts`」（不再是「尚为空」）；`docs/handoff.md:52` 已是 **2.57×**（22.3 字 vs 57.3 字）。**三处都真的改了、方向正确**；但同一批数字现在是 133 项、`tests/console` 也已进 glob（F1，属 t16 引起的新漂移） |
| 7 | `npm test` 与 `check:docs` 全绿；无麦克风/摄像头/密钥时给可读错误 | **真正满足** | `check:docs` 我跑 → 35 份 markdown、0 问题、**exit 0**；`npm test` → **133/133**、`tests/console` → **15/15**。可读错误我从**两路**核过：`--self-test` 实测「没有音频时给可读中文错误（不是堆栈）｜HTTP 400｜没有收到音频数据｜按住「按住说」按钮说话…」与「未知接口给中文提示而不是白屏｜没有这个接口」；缺密钥走 `ConsoleError('MISSING_KEY', …, 503)`（`scripts/field-test.ts:738-739`），`--offline` 下无需密钥即可用（我整轮 live 探针就是 offline 跑的） |

---

## 3. 我亲自做的三项验证（关键：不是读注释，是打真接口）

方法：`node scripts/field-test.ts --offline --port 8807 --no-open --no-tts` 在后台起真服务，再用自写 Node 探针 POST `/api/voice` 三次；每次请求前后各记录一次 `data/voice-web` 的目录清单与 `%TEMP%\xixi-vad-*` 的目录数。测试素材：一个 3.0 s 近静音 WAV（16 kHz，振幅 0.0004）、`tests/audio-fixtures/direct-question.wav`、以及**我拼接**的两段夹具（1.5 s 静音间隔，共 6.379 s）。

### 3.1 无语音请求 → 磁盘上不留任何录音（条款 4 的核心）

| 观测点 | 请求前 | 请求后 | 结论 |
|---|---|---|---|
| HTTP | — | **200**，`elapsedMs 2435` | 不是报错，是正常判定 |
| `reason` / `action` | — | `NO_SPEECH_DETECTED` / `SILENCE` | 与页面文案一致 |
| `data/voice-web` 文件清单 | `[]`（目录不存在） | **`[]`** | 没有原始录音，也没有语音段 |
| `%TEMP%\xixi-vad-*` 目录数 | 0 | **0** | 临时目录**已删** |
| `payload.privacy.speechAudioOnDisk` | — | `null` | 明确声明未落盘 |
| `payload.privacy.note` | — | 「没有检测到语音：磁盘上不会留下任何录音（连临时文件也已删除）」 | 可判读 |
| `notes[0]` | — | 「原始整段录音没有落盘：只在系统临时目录 `C:\Users\zz\AppData\Local\Temp\xixi-vad-DHw6oh` 里存在到 VAD 结束，已删除（3000ms / 16000Hz / 1 声道）」 | **把临时目录路径写出来了**，可事后核对 |

**有语音请求**（`direct-question.wav`）：HTTP 200、`segmentsTotal 1 / segmentsUsed 1`、`speechAudioOnDisk: null`、`voice-web` 前后都是 `[]`、`xixi-vad-*` 前后 0、note「整段录音不落盘；语音段也没有落盘（只用于这一次识别）」。→ **整段录音确实只在 OS 临时目录里活到 VAD 结束，ASR 之前就删了**（代码侧对应 `field-test.ts:673` 建临时目录、`:677` 写 `capture.wav`、`:679` 跑 VAD、`:681` 立即 `rmSync`，`:825-828` 的 `finally` 再兜一次；`:770-776` 只在 `policy.keepSpeechSegments` 为真时才写 `speech-*.wav`）。

**三次请求结束后**：`data/voice-web` 仍为 `[]`、`xixi-vad-*` 仍为 0。默认策略下**这台机器上不留任何语音文件**。

### 3.2 两段语音 → 不再静默丢弃（条款 5 的核心）

`data/t9/two-segments.wav` = `direct-question.wav` + 1.5 s 静音 + `followup-turn.wav`（24000 Hz、6379 ms）：

```json
"segmentsTotal": 2, "segmentsUsed": 2, "droppedSegments": [],
"segments": [ {"startMs":320,"endMs":2496,"durationMs":2176},
              {"startMs":4992,"endMs":6304,"durationMs":1312} ],
"notes": [ "这一段录音里有 2 段语音，已全部使用（按顺序拼接，段间插入 300ms 静音）", ... ]
```

离线替身 ASR 收到的字节数 181868，对照单段请求的 **105644 字节** → **两段真的都进了识别**（不是只喂第一段）。`droppedSegments` 为空数组且类型化（`DroppedSegment`），所以「有丢弃」时会带原因而不是沉默。`voice-turn.ts` 走的是同一份 `planSpeechSegments`/`buildSpeechAudio`（我读 `f824666` 的 diff 确认它为复用而非复制；`npm run voice:turn -- --fake` exit 0，输出含 `segmentsTotal/segmentsUsed/droppedSegments`）。

### 3.3 保留/清理策略真的生效（不是「只写在注释里」）

`pruneVoiceDir` 是导出的纯函数，我直接喂两套策略跑（临时目录、自造假文件、用 `utimes` 设置年龄）：

| 策略 | 输入 | 结果 |
|---|---|---|
| `store_raw_audio=false` + `raw_audio_retention_days=0`（**出厂默认**） | `capture-old.wav`(10d)、`capture-recent.wav`(1d)、`speech-old.wav`(10d)、`speech-recent.wav`(1d)、`unrelated.txt`(100d)、`subdir/` | **删 4 个**（每条带中文 `reason`：「旧版留下的整段原始录音：策略要求不留原始录音」/「语音段：当前策略不保留语音段」）；**保留 `unrelated.txt` 与 `subdir/`** |
| `store_raw_audio=true` + `raw_audio_retention_days=3` | 同上 | **只删超期 2 个**（`capture-old.wav` 10d、`speech-old.wav` 10d）；**保留 `capture-recent.wav`、`speech-recent.wav`**、`unrelated.txt`、`subdir/` |

→ 策略是**可执行的**、只碰 `capture-*.wav` / `speech-*.wav`、不动别人的文件；控制台启动时真的调用它（`field-test.ts:1805` 与 `:3091`）。出厂默认 `config/xixi.example.yaml:46,54` = `raw_audio_retention_days: 0` + `store_raw_audio: false` → 默认**什么都不留**，与 §20.1 的读法一致。

---

## 4. 复核 t4 自认的两处「未声明但被条款要求」的改动

**先给归因结论：这是 captain 的 inScope 遗漏，不是成员越权**——t4 的 inScope 只有 `scripts/field-test.ts`、`scripts/serve-chat.ts`、`tests/console/`、`docs/testing.md`、`docs/handoff.md`、`README.md`、`docs/recon/field-test-report-*.md`，而验收条款 5 的正文写的是「**`/api/voice` 与 `scripts/voice-turn.ts`** 使用全部语音段」，条款 1 要求「一条命令启动」（需要 `package.json` 的 `field-test` 脚本）。两个文件都被条款点名或必需，却都没进 inScope —— 与 AGENTS.md §9.1 记的 t12/t2 是同一类错误。

| 改动 | 落地位置 | 我的核对 | 判定 |
|---|---|---|---|
| `package.json` 新增 `"field-test": "node scripts/field-test.ts"` | `f824666`（与 t3 同一次提交里） | 该脚本存在且可执行（`--help`/`--self-test`/真机验收我都跑过）；全仓 24 个 `npm run X` 引用无悬空 | **必要且正确** |
| `scripts/voice-turn.ts`：`segments[0]` → `planSpeechSegments` 全部段 + `buildSpeechAudio` 拼接 + `droppedSegments` | `f824666` 的 diff | diff 显示：删掉 `sliceWav(readWav(absolute), speech.startMs, speech.endMs)`，改为 `planSpeechSegments(segmentation.segments)` → `buildSpeechAudio(...)`；新增 `segments/segmentsTotal/segmentsUsed/droppedSegments` 四个字段；注释与 `note` 都写明「不再静默丢弃」。`npm run voice:turn -- --fake` exit 0，输出 `segmentsUsed 1 / droppedSegments []` | **必要且正确**（条款 5 直接要求） |

**同时提醒一条工程口味问题（不构成 finding）**：`voice-turn.ts` 反过来 `import ... from './field-test.ts'`，即 CLI 依赖了控制台脚本。目前 `field-test.ts` 的入口有 `if (import.meta.main)` 之类的守卫（`voice:turn` 能正常跑、不会顺手启动服务），所以没有实际故障；但「控制台脚本是共用核心的宿主」这个方向值得注意——更干净的做法是把 `planSpeechSegments/buildSpeechAudio` 放进 `scripts/lib/`。

---

## 5. 复核 verifier（t6）的结论

| verifier 的说法（§2.3） | 我的复核 | 判断 |
|---|---|---|
| 条款 1「`--offline --port 8799` → 启动横幅 + 中文三步上手；`--self-test` 内单测证明只监听 127.0.0.1」 | 我另起了 `--port 8807`，`GET /` 200/26901 字节、16 个中文标记全在；`--help` 也已实现 | **基于真实运行**，不是只读代码 |
| 条款 3「我用 `runDeviceAcceptance({reportDir: <临时目录>})` 真机跑：三项顺序正确、逐项 verdict + nextAction + 证据 JSON + 202 行报告」 | 我用 `--self-test` 走了同一函数的替身路径（244 行报告），并读了仓库里真机报告的逐项证据 JSON 结构与它的描述一致 | **可信** |
| 条款 4「对真实运行的 offline 服务发两次 POST：无语音 → voice-web 前/后 `[]`、临时目录前/后 0；有语音 → 200 SPEAK、voice-web 仍 `[]`、临时目录 0」 | **我自己做了同一实验、独立得到同一结果**（还多做了两段语音与「三次请求后仍为 0」） | **独立复现，强证据** |
| 条款 5「`--self-test`：VAD 检出多段 [2 段] → 2/2，识别收到 181868 字节（仅第一段约 104448）」 | 我在真机 `/api/voice` 上复现了同一组数字：**181868 字节**（两段）对 **105644 字节**（单段） | **吻合** |
| 条款 6「README:91 已写有语料没有 test、handoff:52 已是 2.57×、testing.md:5 当时 95 与实际一致；当前已漂移到 120」 | 三处修改我都核对为真；当前实际是 **133**（t16 之后又加了 13 项） | **它的判断正确**，只是数字继续漂移 |
| 条款 7「`npm test` 120/120、check:docs exit 0；缺音频 400、未知接口 404 + 中文 message+hint」 | 我复跑 133/133、console 15/15、check:docs exit 0；400/404 的中文文案我在 `--self-test` 输出里看到原文 | **可信** |
| 它把「人耳能否听到扬声器」「浏览器麦克风采集」列为**未测**（U2/U5） | 与它的报告一致；这两条确实需要人参与 | **没有把未测写成通过** |

**另外记录一条与 t4 报告口径有关的历史差异（不作为 finding）**：t4 的完成回报写「扬声器相对差 12.97 dB（多轮 9.1–14.7 dB）…三项全 PASS」，而**今天**同一路径 `docs/recon/field-test-report-2026-09-30.md` 的内容是「**总体结论：未通过（FAIL）**…按**能量比**口径只有 2.41 dB（< 10 dB）」——该文件在 `7242973`（t19）被重写过，采用的是 T6-F2 之后更严格的能量比主判据。**t4 交付当时的结论（相对分位口径下三项 PASS）在其时点是诚实的**；现在读这份文件看到的 FAIL 是后续任务按更严口径重跑的结果。这条差异会影响「用户能不能拿到一份三项 PASS 的验收报告」这个团队目标，建议 captain 在收尾时统一口径并重跑一次真机验收（**超出本评审范围，我只如实记录**）。

---

## 6. findings（needs_revision 的依据）

### F1（low）「离线自检 24 项」已经过时：实际是 31 项；README 关于 `tests/console` 不进门的说法也已反转

- **位置**：
  - `scripts/field-test.ts:3038`（`--help` 文本）：「`node scripts/field-test.ts --self-test` 离线自检：隐私/多段语音/页面/报告，**24 项**，不碰麦克风、不联网」
  - `docs/handoff.md:57`：「离线自检 `node scripts/field-test.ts --self-test`（**24 项**）」
  - `README.md:93`：「现场测试控制台（`npm run field-test`）的 15 项控制台测试在 `tests/console/`，**故意不在 `npm test` 的 glob 里**」
  - `docs/testing.md:19`、`:130`、`:146` 三处重复同一「**不在 `npm test` 的 glob 里**」的说法
- **问题**：我实跑 `node scripts/field-test.ts --self-test` → 末行「**自检结果：31 项通过 / 0 项失败**」（t6-F2/F6/F7 的回归断言被加了进来，所以从 24 涨到 31）。`tests/console/**` 也已由 **t16（`2a3dd52`）接进 `npm test` 的 glob**（我核 `package.json` 的 `test` 脚本含 `"tests/console/**/*.test.ts"`），所以 README/testing.md 的「故意不在 glob 里」现在是**反的**。
- **影响面**：这两条都是给「接手者/用户」看的路标：一个是自己跑自检时的预期项数，一个是「哪些测试在默认门禁里」的判断依据。第二条更值得一提——按 README 的写法，接手者会以为控制台测试**不受**默认门禁保护，从而在改动 `field-test.ts` 时低估回归风险（实际它现在是受保护的，这是好事，只是文档说反了）。
- **为什么不算 t4 的错**：t4 交付时 24 项与「不在 glob」都是**当时的事实**（t4 报告第 8 条也明写「不在 npm test glob」并如实披露）；是 t16 与后续 T6-F 回归改动让这两条过期。本评审判 needs_revision 的理由是「产物的自述与当前工作区不一致」这一**状态**，而不是追责 t4。
- **requiredFix（最小改动，都是文档/文案）**：
  1. `scripts/field-test.ts:3038`：`24 项` → **`31 项`**（或改成不写死数字：「离线自检（隐私/多段语音/页面/报告，约 30 项）」以免再次漂移）；
  2. `docs/handoff.md:57`：同上改 `31 项`；
  3. `README.md:93` 与 `docs/testing.md:19/:130/:146`：把「故意不在 `npm test` 的 glob 里」改成「**已在 `npm test` 的 glob 里**（t16 起），也可用 `npm run test:console` 单跑」；
  4. **顺带**（同一批数字漂移、verifier 已记 F4）：`docs/testing.md:5`/`:124`、`README.md:40`、`docs/handoff.md:28`/`:117` 的 `95 项` → 实测 **133 项**（我复跑 `npm test` = tests 133 / pass 133 / fail 0）。
- **复现命令**：`node scripts/field-test.ts --self-test | Select-Object -Last 2`（末行 31 项）；`node -e "console.log(require('./package.json').scripts.test)"`（含 `tests/console`）；`npm test`（133 项）。

---

## 7. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `node scripts/field-test.ts --offline --port 8807 --no-open --no-tts`（后台） | 启动成功；`GET /` = **HTTP 200 / 26901 字节**；关闭后端口释放（复探连接失败） |
| 自写 live 探针 → `POST /api/voice` ×3（无语音 / 单段语音 / 我拼接的两段语音） | 三次 HTTP 200；`data/voice-web` 前后均 `[]`；`xixi-vad-*` 前后均 0；`speechAudioOnDisk` 三次均 `null`；无语音 → `NO_SPEECH_DETECTED`/`SILENCE` + 「磁盘上不会留下任何录音」；两段 → `segmentsTotal 2 / segmentsUsed 2 / droppedSegments []`，离线 ASR 收到 **181868 B**（单段为 105644 B） |
| 自写 `pruneVoiceDir`/`retentionPolicy` 行为测试（临时目录 + `utimes` 造年龄） | 默认策略删 4 个（带中文 reason）、恰保留新文件与 `unrelated.txt`/`subdir`；`store_raw_audio=true`+3 天策略只删 2 个超期文件 |
| `node scripts/field-test.ts --help` | exit 0，打印用法与隐私说明，不启动服务、不占端口 |
| `node scripts/field-test.ts --self-test` | **31 项通过 / 0 项失败**，exit 0（含 400/未知接口中文文案、假 PASS 回归、两个扬声器口径回归、无残留临时目录） |
| `node --test "tests/console/**/*.test.ts"` | **15 / 15 pass**，exit 0 |
| `npm test` | **tests 133 / pass 133 / fail 0**，exit 0 |
| `npm run check:docs` | 35 份 markdown、0 问题、**exit 0** |
| `npm run voice:turn -- --fake --wav tests/audio-fixtures/direct-question.wav` | exit 0；输出含 `segmentsTotal 1 / segmentsUsed 1 / droppedSegments []`，note 明写「不再静默丢弃」 |
| 全仓 `npm run X` 引用审计（24 个） | 全部存在于 `package.json`（缺失 0） |
| 读 `f824666` 的 diff（`package.json` / `scripts/voice-turn.ts`） | 确认两处未声明改动的内容与必要性；`voice-turn.ts` 为**复用**（import 共享核心）而非复制实现 |

**未做的**：我没有跑 `--acceptance`（会真机播放声音、占用麦克风/摄像头，且当前报告口径已由 `7242973` 重写；verifier 已真机跑过并留证据）。**合规说明**：现场测试控制台启动时只写 `data/field-test/` 与（默认策略下）不写任何语音；我造成的磁盘变化只有 `data/t9/`（测试素材与探针）——**已全部删除**，`data/voice-web` 仍不存在、`xixi-vad-*` 仍为 0。

---

## 8. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | t4 七条验收标准 | **7 条真正满足**（第 6 条附 F1 的「现状漂移」） |
| 2 | 隐私修正（真机亲自复现） | **成立**：无语音/有语音/两段 三种请求后，`data/voice-web` 均无文件、`xixi-vad-*` 均为 0、`speechAudioOnDisk:null`；整段录音只在 OS 临时目录活到 VAD 结束 |
| 3 | 保留/清理策略 | **成立**：默认什么都不留；授权时按保留期只删超期的 `capture-*`/`speech-*`，不动他人文件 |
| 4 | 多语音段 | **成立**：2/2 段全部送识别（181868 B vs 单段 105644 B），`droppedSegments` 结构化报告原因 |
| 5 | 两处未声明改动 | **必要且正确**；归因 **captain 的 inScope 遗漏**（条款 5 点名 `voice-turn.ts`、条款 1 需要 `package.json`），非成员越权 |
| 6 | 复核 verifier | **它的 t4 结论基于真实运行**（真实 POST + 真机验收 + 独立复跑），我的 live 探针逐条吻合；未测项（人耳可听、浏览器采集）如实保留 |
| 7 | 文档诚实性 | 条款 6 点名的三处数字**真的改了**；唯一过时项是「自检 24 项 / console 不在 glob」与 95→133 的整批数字（F1） |
| 8 | 环境门禁 | 我自己复跑：console 15/15、`npm test` 133/133、`check:docs` exit 0、`--self-test` 31/31、`voice:turn --fake` exit 0 |

**总判定：needs_revision**。实现与隐私修正**我判为真实可信、可以放行**；唯一的 blocking 项是 F1 —— 产物的自述（`--help` 里的「24 项」、README/testing.md 里的「不在 npm test glob」）与当前工作区不再一致，而这两处正是接手者判断「哪些回归被默认门禁保护」的依据。把 F1 的四处文案与整批 95→133 的数字改齐后，t4 产物我判 **pass**。
