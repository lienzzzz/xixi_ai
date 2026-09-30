# 评审：摄像头在场检测 M6（t3 产物）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t3 实现者 vision-engineer 与 verifier）
> 日期：2026-09-30
> 评审对象：t3「摄像头在场检测 M6（本地检测 + presence 事件 + WorldState-lite）」的**产物本身**
> 复核对象：t6 / `docs/verification/field-test-verification-2026-09-30.md` §2.2、§3.4（独立验证报告）
> 唯一写入路径：本文件。未修改任何实现代码、测试或其他人的文档。
> 权威来源（本评审实际读过的）：`services/perception-edge/perception_edge/*.py`、`tests/perception/*.ts|py`、`scripts/verify-camera-presence.ts`、`packages/contracts/schemas/events/presence.changed.v1.json`、`packages/domain/src/{store.ts,migrations/002_world_state.sql}`、`docs/design/perception.md`、`docs/recon/camera-detector-choice-2026-09-30.md`、`data/recon/{perception-detector-bench.json,perception-camera-verify.txt}`、真实摄像头（我自己跑了两次）

---

## 1. 结论

**verdict：needs_revision（实现是真实可用的，核心三条「真复用契约 / 真不外传 / 参数有实测理由」我都独立证实；4 条 findings，其中 2 条必须先修，且都是「证据保真 / 可审计性」而不是功能缺陷）**

一句话：**这一次的产物经得起第二双眼睛**——契约复用是真的（无新事件类型、无 schema 漂移，Python 侧用**磁盘上同一份 schema** 自校）、隐私是**构造保证**（服务里没有任何网络客户端与写图路径，AST 扫描测试真的在跑）、防抖参数都有实测出处、WorldState-lite 的 TTL/stale/可重建三件套端到端落地（我在真库里看到 `world_state` 与最后一条事件时间戳逐字相同）。我自己在真实摄像头上跑了两次（8 s / 20 s：570 帧、28.1 fps、无人画面 0 次转换、`contract_problems: []`），并**直接用 read_image 看了 t1 存下的真实抓帧**——画面确实是「天花板 + 空调 + 衣柜」，所以「0 误报」这个结论成立而不是敷衍。

需要修的是一条**证据盲区**和两条**可审计性**问题：隐私测试注释自称断言了 `data/`，实际只扫服务与测试目录（F1）；`--require-transition` 敲错一个字符会被静默忽略而照样 PASS（F2）；`--self-test` 的**合成** presence 事件写进了现场验收共用的同一个库、且库里无法区分（F3）。

| 维度 | 判定 |
|---|---|
| t3 的 8 条验收标准 | **8 条全部真正满足**（其中第 6、7 条附 findings，见 §2） |
| 「真复用契约、没偷偷新增事件类型」 | **证实**（§3） |
| 「没外传 / 没写进仓库」 | **证实**（服务侧构造保证 + git 无画面），但**测试的断言范围比它自称的窄**（F1） |
| 「防抖参数有实测理由」 | **证实**（§4.2，每条都能指到代码或记录） |
| 复核 verifier 的结论 | **可信且克制**：它有真实抓帧证据、明确保留「真人未测」，没有把未测写成通过 |
| 铁律与隐私 | **通过**（无网络客户端、无 torch/GPU、无高风险能力、`data/` 全在 gitignore 且无图像被跟踪） |
| 文档诚实性 | **基本诚实**（未完成项写清、外部图许可如实标注「未记录」）；3 处措辞/数值需修（F1/F4/F5） |
| 环境门禁 | 我自己跑：`npm test` **125/125**、`check:docs` **exit 0**、Python **39/39**、perception node **10/10** |

---

## 2. 逐条核对 t3 的 8 条验收标准

| # | 条款 | 判定 | 我自己的核对方式与结果 |
|---|---|---|---|
| 1 | `services/perception-edge` 能从默认摄像头周期抓帧并在本地判定有人/无人；连续视频不外传 | **真正满足** | 我实跑 `node scripts/verify-camera-presence.ts --seconds 8`（隔离库）→ `verdict PASS, exit 0`：`frames_processed 207`、`fps_processed 24.9`、`camera{open_ms 807, read_ms_mean 28, fps_measured 35.7, 640×480}`、`detector.face_backend "yunet"`、`detect_ms_mean 6.46 / p95 53.76`、`frames_with_evidence 0`（无人画面 0 误报）、`contract_problems []`、`privacy{video_uploaded:false, stills_uploaded:0, frames_written_to_disk:0, network_clients:0, local_only:true}`。实现侧：`run.py:5-6` 的循环、`camera.py` DSHOW、`detector.py:257-304` 的帧差动 + 每 10 帧人脸 |
| 2 | 检测器选型有书面理由与实测（来源/大小/是否需下载/单帧耗时/CPU），且未引入 torch | **真正满足** | 我逐格比对了 `data/recon/perception-detector-bench.json` 与两份文档：YuNet 232,589 B / 29.28 ms / 604.8% 单核 / 75.6% 整机 / `needs_download:true`；Haar 930,127 B / 18.64 ms；组合路径 0.44 ms 中位、60 帧摊薄 **3.08 ms/帧**（= 3.08/33.3 = 9.2% 预算）；`environment.torch_installed:false`；正负对照 `selfie 46/135 YuNet vs 5 Haar`、`lena 1/1/1`、空场景 0/0、椒盐 0/0 —— **文档里的每个数字都能在 JSON 里找到**。依赖与许可逐条写在勘测 §8（含 `--headless` 理由与 YuNet 来自 OpenCV Zoo / Apache-2.0） |
| 3 | 状态变化写成 `presence.changed`（复用现有契约；如新增类型必须新建版本化 schema 并更新漂移测试） | **真正满足（本评审重点，已独立证实）** | 见 §3：磁盘 schema 只有一份、Python 用同一份自校、`EVENT_TYPES` 未改、漂移测试未动、真库 6 条事件全是 `presence.changed`/`schema_version 1` |
| 4 | 数据库有当前在场投影（迁移文件），含 value/source/updated_at/confidence/TTL，历史仍由事件日志保存 | **真正满足** | `packages/domain/src/migrations/002_world_state.sql`（新增、不动 001）：7 列与 §5.3 一一对应；真库 `schema_migrations` 有 (1,001)(2,002)；`world_state` 实测 1 行 `('presence.home',1,'present','perception.laptop_camera','2026-09-30T12:04:17.690+08:00',0.75,60.0)`，其 `updated_at` 与最后一条事件 `timestamp` **逐字相同**；`rebuildWorldStateFromEvents()` 有测试（删投影行 → 重建 → 值与时间戳一致） |
| 5 | 防抖：短暂遮挡或单帧误检不产生状态翻转（参数与理由写进文档） | **真正满足** | 参数 15/45/3000 ms/1500 ms 与 `DebounceConfig` 默认值逐字一致；行为有 39 项 Python 用例钉住（单帧椒盐 0 次转换、短证据算噪声、短遮挡不成对、长遮挡正好一次、释放宽限）；理由见 §4.2 —— 每条都能指到实测或明确的设计取舍 |
| 6 | 离线回归测试覆盖有人/无人/误检边角（`tests/perception/`），图片来源与许可已注明，`npm test` 全绿 | **真正满足（附 F1、F5）** | 我实跑 `node --test "tests/perception/**/*.test.ts"` → **10/10 pass**；`python -m unittest discover -s tests/perception` → **39 tests OK**；`npm test` **125/125**。来源与许可：`scenes.py:1` 明写「no external assets, no licence questions」；两张外部图（`largest_selfie.jpg`/`lena.jpg`）如实标注「未记录许可、不进仓库、只在存在时作为可选正对照」。**但**：Node 侧那条「画面不落盘」的断言**根本没看 `data/`**（F1），而 `data/` 里现在确实躺着 5 个图像/视频文件（全部来自 t1 勘测，非本任务写入） |
| 7 | `scripts/verify-camera-presence.ts` 抓真实摄像头输出事件、帧率与耗时，无摄像头时给出明确失败信息 | **真正满足（附 F2、F6）** | 真机两次（含一次 20 s：570 帧/28.1 fps，与 t3 自述逐字一致）；退出码 `2`（无摄像头）/`3`（缺模型）在 `run.py:325-331` 实现且有中文排查提示；`--require-transition` 存在且有效——我用 `--require-transition --seconds 3` 实测 **exit 1**（只有启动记录 → 判 FAIL，这正是它该做的）。**但**：未知 flag 被静默忽略（F2），脚本也没有 `--help`（F6） |
| 8 | `npm run check:docs` 通过；两份文档已更新；回报里有可粘贴段落 | **真正满足** | `check:docs` 我自己跑：34 份 markdown、0 问题、**exit 0**。两份文档已大幅更新（`perception.md` 272 行、勘测 161 行）；回报里确实给了可直接粘贴的 `progress.md`/`architecture.md` 段落 |

---

## 3. 重点核对：契约复用是否「真的复用」

| 检查 | 方法 | 结果 |
|---|---|---|
| 有没有新增事件类型 | 读 `packages/contracts/schemas/events/` 目录 + `EVENT_TYPES` | 目录里只有 4 个 schema（`conversation.decision.v1` / `conversation.turn.v1` / `presence.changed.v1` / `system.health.v1`）；`events.ts:50` 的 `define('presence.changed', 1, …)` 是既有条目。**未新增类型** |
| payload 形状是否被偷偷扩展 | 读 `presence.changed.v1.json` + `contracts.py:210-241` + 真库 payload | schema 是 `additionalProperties:false`、`required:[present, source_detail]`；Python 构造时**只**放这两个键，检测细节写进**信封既有字段**（`source` / `confidence`）与 `source_detail` 的一行摘要（≤200 字符，`:212`）。真库 6 行的 payload 全部只有这两个键 |
| schema 是否被改写 | `git log -- <schema>` | 最近一次改动是 `b769f11`（M0 初始提交），**t3 未碰 schema** |
| 漂移测试是否被动过 | 看 t3 inScope 与提交 | t3 的路径约定不含 contracts 的漂移测试；`schema_version` 仍为 1、`SCHEMA_VERSION = 1`（`envelope.ts:13`） |
| Python 生产方会不会「以为自己合规」 | 读 `contracts.py` | **不会**：`validate_presence_event()` 每次都从磁盘读 `envelope.v1.json` 与 `events/presence.changed.v1.json` 校验，且实现的是一个**显式白名单**子集——遇到没实现的 JSON Schema 关键字**直接抛错**（`contracts.py:85-87`）。这是比「忽略未知关键字」诚实得多的做法 |
| 端到端是否被权威校验器复核 | 读 `verify-camera-presence.ts:211-232` | 脚本把真库里读回的事件重建成信封，用 **TypeScript 权威 `validateEvent()`** 复核，结果写进 `contract_problems`。我两次真跑的 `contract_problems` 都是 `[]` |
| 事件是不是唯一事实来源 | 读真库 | `events` 6 行（全部 `presence.changed`），`world_state` 只有 1 行；`world_state.updated_at` = 最后一条事件 `timestamp`（逐字相同）。写入方两处（Python `emitter.py:150-197` 与 TS `store.recordPresenceChanged`）都是「事件 + 投影同一事务」，`emitter.py:168-172` 在 SQLite 出错时 `rollback()` 并写明原因 |

**结论：契约复用是真的，不是「长得像」。**

---

## 4. 复核 verifier（t6）的结论

### 4.1 verifier 说了什么、我核到什么

| verifier 的说法（§2.2 / §3.4） | 我的复核 | 判断 |
|---|---|---|
| 条款 1「`--seconds 15` → PASS/exit 0、`frames_seen=379`（25.3 fps）、`privacy{video_uploaded:false…}`、服务里没有任何 `socket/requests/urllib/http/httpx/aiohttp` 导入（grep 为空）」 | 我独立复跑 8 s：207 帧/24.9 fps/`privacy` 同样四个 false；我另用 grep 扫全服务：**只有** `argparse/sys/time/dataclasses/typing/cv2/numpy`，没有网络客户端；并且我读了它的 AST 扫描用例（`test_presence.py:452-468`）——它真的 `ast.parse` 每个文件并对 import 清单断言，不是空跑 | **证据充分** |
| 条款 4「`world_state` 实测 1 行 `('presence.home',1,'absent',…,0.85,60.0)`、`schema_migrations` 已应用 (1,001)(2,002)」 | 我读真库确认列与行；我读到的当前行是 `present/0.75`（因为 12:04 那次运行留下了新事件），`ttl_seconds 60.0`、`schema_version 1` 一致 | **证据充分** |
| 条款 6「`tests/perception` node 10 项 + Python 39 项，我单独跑 10/10、39/39」 | 我实跑 10/10、39/39；`scenes.py` 首行确为「no external assets, no licence questions」 | **证据充分** |
| 条款 7「无摄像头路径我用 `--camera-index 9` 触发 → exit 2 + 中文可操作提示」 | 我读了 `camera.py:104-150` 的开流/首帧失败分支与 `run.py:325-328` 的 `return 2`，与它的记录一致（我未再占用一次设备去复现 exit 2） | **可信** |
| §3.4「`lumaMean 124.3 / lumaStd 36.9 / uniqueLuma 202`（真实有效画面，非纯黑/纯色）」 | 我做了更强的检查：**直接打开 t1 留下的真实抓帧** `data/recon/camera-frame-DSHOW-0.png`（640×480），看到的是「天花板 + 空调 + 衣柜」，画面里没有人 | **它没有虚报**；这条同时证实了「摄像头朝天」这个前提 |
| 它明确把「真人在镜头前」列为**未测**（U1），并给出用户自测命令 | 与我读到的一致：`docs/design/perception.md:219-231`、勘测 §7 都把这条写成未完成 | **没有把未测写成通过** |

### 4.2 它的证据里有一处它没查、我查了

verifier 的条款 6 证据写「`--self-test` 用同一套生成帧跑『检测→事件→投影』写库链路，输出里明确标注 mode…没有拿合成图冒充真人实测」。**方向对**，但它没有指出一个副作用：那次 self-test 的**合成 presence 事件被写进了现场验收共用的同一个库**（见 F3）。我做了确认性复现：用**隔离库**重跑 `--self-test`，得到的事件与真库里 12:04 那 4 条**逐字相同**（`frames=47 motion_ratio=0.1480` / `frames=181` / `frames=286 motion_ratio=0.0318`，置信度 0.75/0.85）。也就是说这条不是猜测，是可复现的。

### 4.3 verifier 的失误与克制

- **克制**：它没有因为「摄像头朝天、0 次转换」就把条款 7 判失败，也没有因为「self-test 能跑通」就把「真人检出」判通过——分寸是对的。
- **失误**：唯一一处是 4.2 的漏检（不算造假，它引用的是运行输出，只是没往下追一步）。另外它没有核 t3 **自述**的「离线回归 38 用例」与实际 39 项的偏差（无害，但说明它主要核的是自己的复跑而不是对方回报的措辞）。

---

## 5. 铁律与隐私检查（本任务重点）

| 检查项 | 结论 | 我实际怎么核的 |
|---|---|---|
| 连续视频绝不上云（铁律 6） | **通过（构造保证）** | 全服务 import 清单里没有任何网络客户端；`run.py:15-18` 与 `semantic.py` 把「截图外发」留成**调用即抛错**的 stub（`SemanticAnalysisNotImplemented`），`enabled=True` 也会抛；有 AST 扫描单测守住（`test_presence.py:452-468`） |
| 画面不落盘、不进仓库 | **通过** | 服务里 grep 不到 `imwrite/VideoWriter/write_bytes/tofile/.png/.jpg` 任何写图路径；`git ls-files "*.png" "*.jpg" "*.avi" "*.onnx" "*.sqlite"` → **空**；`git check-ignore` 确认 `data/` 整体被忽略（含 t1 的抓帧、YuNet 模型、现场库）；另外 t3 自己的测试会扫服务与测试目录断言无图片 |
| 未新增高风险能力（铁律 7） | **通过** | 新增的都是本地检测与只读产物；不做人脸识别（不回答「是谁」）、不录像、不做门锁/支付类动作；`semantic.py` 明确「刻意未实现」 |
| 未引入 torch / GPU 依赖（铁律 12） | **通过** | `bench.json` 的 `environment.torch_installed:false`；`.venvs/cv4` 用 `opencv-python-headless 4.14.0.94 + numpy 2.5.3`（headless 刻意不带 GUI）；AST 扫描把 `torch` 列进禁用名单 |
| 不存模型私有推理（铁律 5） | **通过** | 事件 payload 只有 `{present, source_detail}`；逐帧证据只打成 stdout 的 `frame` 记录，**从不入库**（`emitter.py:206-208` 明确注释） |
| 不实现多个里程碑（铁律 11） | **通过** | M7 主动问候接线被明确排除（`perception.md:242`）；本任务是「一条命令跑一段」而不是常驻服务（`perception.md:239`） |

---

## 6. 文档诚实性检查

| 位置 | 说法 | 我的核对 |
|---|---|---|
| `docs/design/perception.md` §1 状态表 | 已实现/刻意未实现/未完成三态分明 | **诚实**：把「真人站在镜头前」写成**未完成**，把语义分析写成「刻意未实现：只留接口」 |
| `docs/recon/camera-detector-choice-2026-09-30.md` §5 | 外部图「上游来源与许可没有记录、不进仓库」 | **诚实**，且与 git 实际一致 |
| 勘测 §7 未实测清单 | 每一条都写「未实测」+ 怎么补 | **诚实** |
| `perception.md:85` / 勘测 §4 | YuNet 29.28 ms、604.8%、232,589 B | **逐格对上 bench JSON** |
| `perception.md:19` 勘测 §6 的真实摄像头表 | 421 帧/27.5 fps/0 转换（那份文件） | **对得上**——该文件是 UTF-16LE，需按 UTF-16 读；我另外用 UTF-16 解出 570 帧/28.1 fps 的第二份记录，与 t3 自述一致 |
| `perception.md:54-57` 帧差动阈值 | 「6 灰阶来自 T0 实测：静态场景平均绝对差 0.8 灰阶、p99 = 5.0」 | **成立**（勘测 §3 确实写 0.8 灰阶 / p99 5.0） |
| `perception.md:55-57` 噪声底数值 | 「measured 20.8 dB on the noise-only reference」这类数字在**代码 docstring** 里 | 需要在文档里区分「实测」与「设计取舍」的只有 F4 一处（0.5% 占比是设计取舍，写成了与实测并列） |
| 报账口径 | `perception.md` 写 39 项用例，t3 完成回报写「38 用例已接进 npm test」 | 实际是 **39**（我跑出 `Ran 39 tests`）；差 1 属措辞，且「已接进 npm test」当时不成立（t16 才接入）——verifier 已记为 F5 |
| 模型来源 | 勘测 §8 写 YuNet 来自 OpenCV Zoo / Apache-2.0 / 227 KB | **大小与来源成立**；但**没有校验和/版本指纹**（F5） |

`npm run check:docs`：**我自己跑，exit 0**（34 份 markdown、0 问题）。它是链接/引用/新鲜度检查器，不校验数字，所以不能替代上表的逐格比对。

---

## 7. findings（needs_revision 的依据；每条含文件与行号）

### F1（medium，必须先修）隐私断言存在盲区：注释默认 `data/` 已被覆盖，代码实际只扫两个目录

- **位置**：`tests/perception/camera-presence.test.ts:30-31` 与 `:191-199`
  - `:30` 注释（原文）：「**`data/` is git-ignored and holds no frames from this test run; asserted in the privacy test.**」
  - `:31` 代码：`const WATCHED_IMAGE_DIRS = [join(REPO_ROOT, 'services', 'perception-edge'), TESTS_DIR];`
  - `:191-199` 只遍历这两个目录里的 `.png|.jpg|.jpeg|.bmp|.avi|.mp4`。
- **问题**：`data/` **从未被扫描**，而注释把「`data/` 里没有本次运行的画面」写成「asserted in the privacy test」。实测 `data/` 下现有 5 个图像/视频文件（`data/models/{largest_selfie.jpg,lena.jpg,vtest.avi}`、`data/recon/camera-frame-{DSHOW,ANY}-0.png`），全部来自 t1 勘测——所以事实层面「t3 没把画面落盘」成立（我另用 grep 确认服务里没有任何写图路径），**但这条测试的覆盖面比它声称的窄**，而条款 6（图片来源与许可）与条款 1（连续视频不外传）都拿它当证据。
- **影响面**：`data/` 是**唯一**真正存放画面的目录（抓帧、模型、现场库都在这里）。将来有人把调试抓帧写进 `data/perception/`，这条测试仍会绿。
- **requiredFix**（最小改动，二选一）：
  - (a) 把注释改成与代码一致：「本断言只覆盖服务目录与测试目录；`data/` 里存在 t1 勘测留下的历史抓帧，故不对 `data/` 做全目录断言」；
  - (b) 更强：在 `:191` 前先记录 `data/` 下图像文件集合（文件名集合），用例结束后再断言集合**未新增**（允许已存在的 t1 文件），并把这条写进注释。推荐 (b)，因为它才真正守住「检测过程不落盘」。
- **复现命令**：`node -e "const fs=require('fs');const walk=(d,o=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;e.isDirectory()?walk(p,o):o.push(p)}return o};console.log(walk('data').filter(p=>/\.(png|jpe?g|avi|mp4)$/i.test(p)))"`

### F2（medium，必须先修）未知 flag 被静默忽略：`--require-transition` 敲错就变成一次「必然 PASS」的运行

- **位置**：`scripts/verify-camera-presence.ts:43-55`
  - `:44-47` `argValue()`：找不到 flag 就返回 fallback；
  - `:48-50` `hasFlag()`：只查 `args.includes(name)`；
  - `:54` `const requireTransition = hasFlag('--require-event') || hasFlag('--require-transition');`
  - 全文**没有**对未知参数的校验，也没有 `--help`（另见 F6）。
- **问题**：文档（`docs/design/perception.md:224-231`、勘测 §7）把用户自测步骤写成一个**必须敲对的长 flag**；一旦写错（例如 `--require-transiton`、`--requireTranscript`、或误写成 `--require-transitions`），脚本会当作没给这个 flag，**照常跑真实摄像头并按 §7 的默认逻辑打印 `PASS`**（`:313-320` 的分支：0 次转换也是 PASS，还补一句「0 次转换是正确结果」）。用户会拿着一个 PASS 以为自己完成了「真人检出」验收。
- **影响面**：这是**唯一**的「真人站在镜头前是否可被检出」的用户自测入口；假 PASS 的代价是这条验收永远没人真正做，而它正好是本轮 verifier 列出的两个未测项之一。
- **requiredFix**：在 `:43` 之后加一个允许参数白名单（`--seconds|--db|--camera-index|--self-test|--scenario|--require-event|--require-transition|--min-fps|--help`），遇到不在白名单里的参数就打印中文错误、列出可用参数并 **exit 1**（不要静默继续）；同时支持 `--help`（打印同 `docs/design/perception.md` §8.2 的用法）后 exit 0、不占用摄像头。可用 `node scripts/verify-camera-presence.ts --require-transiton --seconds 3` 复现当前行为（会正常跑完并 PASS），修好后应变成 exit 1 + 拼写提示。

### F3（medium）`--self-test` 的合成 presence 事件写进了现场验收共用的库，且库里无法区分

- **位置**：`scripts/verify-camera-presence.ts:40`（`DEFAULT_DB = data/perception/field-test.sqlite`）、`:53`（`--self-test` 不改变库）、`:143-149`（self-test 仍然带 `--db dbFile --append`）、`:136-138`（`--append` 才写库）；`perception_edge/emitter.py:150-197`（Python 在同一事务里写事件与投影）；`services/perception-edge/perception_edge/run.py` 的 `--source synthetic`
- **问题**：我用**隔离库**复跑 `--self-test`，得到 4 条事件与真库 `data/perception/field-test.sqlite` 里 12:04 的那 4 条**逐字相同**（`present=true frames=47 motion_ratio=0.1480`、`absent frames=181`、`present=true frames=286 motion_ratio=0.0318`，confidence 0.75/0.85）。而库里**没有任何字段**说明这些是合成帧产生的：`mode` 只出现在 stdout/summary（`:275`），事件的 `source_detail` 与真实运行格式完全一致（都是 `state=… frames=… motion_ratio=… faces=0 gate=motion+face reason=…`）。
- **影响面**：
  1. **误导性证据**：真库的 `events` 里有「有人出现/离开」的事实，而它们**从未在真实画面里发生过**。任何人（包括 M7 的主动问候消费方、以及下一个做验收的人）读这个库都会把它们当成真实在场转换——「场里有一个人」这件事就是靠这个投影传达的。
  2. 反过来，用户拿到「无人画面 0 次转换」这个结论时，库里同时存在合成转换，**两者无法由库本身区分**；t3 的「0 误报」结论只能靠「记录带外区分」来读。
  3. 这是可复现的（见上），不是理论风险。
- **requiredFix**（最小改动，二选一，推荐 (a)+(c)）：
  - (a) `--self-test` 默认改写到**独立库**（如 `data/perception/self-test.sqlite`），除非显式给了 `--db`；在 summary 与 stdout 里说明「本次写入的是自检库」。
  - (b) 若必须写同一库，则在事件里留下**可判读的标记**——`source_detail` 加一段（例如 `mode=self-test`，注意上限 200 字符，见 `contracts.py:212`），并在 `docs/design/perception.md` §5 写明「自检事件带 `mode=self-test`，消费方必须忽略」。**不要**改 payload 形状（契约是 `additionalProperties:false`，加字段会破坏已发布 v1）。
  - (c) 顺手清理：当前真库里那 4 条合成事件建议在文档里点名说明（或按项目惯例另开一个「清理/标注合成事件」的小任务），不要让它们继续冒充现场事实。

### F4（low）`docs/design/perception.md:53-57` 把「0.5% 占比」这条**设计取舍**写进了「实测」段

- **位置**：`docs/design/perception.md:53-57`
  - `:55`「6 灰阶来自 T0 实测：静态场景平均绝对差 **0.8 灰阶**、p99 = 5.0，阈值必须高于噪声底」
  - `:56`「0.5% 占比是为了挡住『全画面 1 个灰阶的缓慢漂移』（自动曝光会整幅变一点点）」
  - `:57`「实测：空场景与高斯噪声场景 `motion_ratio = 0.0`；人走动时 0.0089–0.087」
- **问题**：`:55` 引用的实测是真的（勘测 §3 原文：静态场景连续两帧平均绝对差 **0.8 灰阶**、**p99 5.0**、>5 灰阶像素占 **0.66%**，阈值建议 6–8）。问题在 `:56` 的 **0.5% 占比**：它是**设计取舍**（挡住自动曝光引起的整幅缓慢漂移），但写在「实测」的段落里、与「6 灰阶来自 T0 实测」并列；勘测里唯一的占比实测是「>5 灰阶像素占 **0.66%**」，不能直接推出 0.5% 这个门限，所以这一条目前读起来像「测出来的」而实际是选的。
- **影响面**：low。阈值本身正确且被验证（`detector.py:262-268` 与 `run.py:53-54` 默认值一致；空场景/椒盐场景 0 误报有单测与真机数据），问题只在「实测」与「取舍」的边界被写糊。
- **requiredFix**：给 `:56` 明确标注性质，例如把 `:55-57` 改成——
  - 实测：「T0 记录静态场景两帧平均绝对差 **0.8 灰阶**、**p99 5.0**、>5 灰阶像素占 **0.66%**（勘测 §3）→ **6 灰阶**门限取自它（高于 p99）」；
  - 取舍：「**0.5% 运动像素占比**是为挡住自动曝光引起的整幅缓慢漂移而选的**设计取舍**（不是实测值；勘测的 0.66% 是另一个量，不能直接推出它）。服务里实测：空场景与高斯噪声场景 `motion_ratio = 0.0`，人走动时 0.0089–0.087」。

### F5（low）模型来源有 URL、没有指纹；`data/models/` 里的副本无法被校验

- **位置**：`docs/recon/camera-detector-choice-2026-09-30.md:144`（依赖与许可表：YuNet「来自 OpenCV Zoo（`opencv/opencv_zoo`，Apache-2.0）；不进仓库，放 `data/models/`」）；`services/perception-edge/perception_edge/detector.py:172-196`（`load_yunet_model_path`，只按路径找文件、不校验）；勘测 §8
- **问题**：文档写了来源与大小（232,589 B）与下载 URL（`detector.py:194`），但**没有校验和**。`data/models/face_detection_yunet_2023mar.onnx` 是本地二进制，任何人都可以替换而没有任何东西会发现——对「模型来源与许可写清」这条验收而言，缺一个可核对的指纹。
- **影响面**：low（本机单用户 PoC），但成本极低。
- **requiredFix**：在勘测 §8 与 `docs/design/perception.md` §3.4 的 YuNet 行补上我实测的指纹，并在 `load_yunet_model_path()` 的注释里写明「换模型请一并更新文档里的 SHA-256」：
  - `data/models/face_detection_yunet_2023mar.onnx`，232,589 B，**SHA-256 = `8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4`**。
  - 复现：`Get-FileHash data/models/face_detection_yunet_2023mar.onnx -Algorithm SHA256`。

### F6（info）验收脚本没有 `--help`，未知参数不报错

- **位置**：`scripts/verify-camera-presence.ts:43-55`、`:318`（用法只在 PASS 输出的末尾被打印）
- **问题**：`node scripts/verify-camera-presence.ts --help` **不会打印帮助，而是直接开摄像头跑默认 20 s**（我实测如此）。文档要求用户跑一条命令做验收，但没有「先看用法」的入口；配合 F2 的静默忽略，误用成本被放大。
- **影响面**：info（不影响已记录的正确用法）。与 F2 同一处代码，建议一并修：`--help` 打印用法（复用 `:318` 那段文本 + 参数表）后 exit 0，且不打开设备。

---

## 8. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `node scripts/verify-camera-presence.ts --seconds 8 --db <TEMP>` | **exit 0 / verdict PASS**：207 帧、24.9 fps、`face_backend yunet`、`detect_ms_mean 6.46`、`frames_with_evidence 0`、`transitions 0`、`startup_events 1`、`contract_problems []`、`privacy{全 false, local_only true}`、`world_state{value absent, confidence 0.85, ttlSeconds 60, stale false}` |
| 同一命令 `--seconds 20`（意外触发一次，`--help` 不存在所致，见 F6） | exit 0：**570 帧 / 28.1 fps**，与 t3 自述一致（这份记录我已知会被 doc 引用，未覆盖任何文档） |
| `node scripts/verify-camera-presence.ts --self-test --db <TEMP>` | **exit 0**；3 次真实转换 + 1 条启动记录；事件与真库 12:04 那 4 条**逐字相同** → F3 的确认性复现 |
| `node scripts/verify-camera-presence.ts --require-transition --seconds 3 --db <TEMP>` | **exit 1**（只有启动记录 → 判 FAIL）→ `--require-transition` 语义正确 |
| `node scripts/verify-camera-presence.ts --require-transition --bogus-flag --seconds 3 --db <TEMP>` | exit 1（**仅因无转换**；`--bogus-flag` 被静默忽略，无任何提示）→ F2 |
| `node scripts/verify-camera-presence.ts --help` | **不打印帮助，直接跑真实摄像头 20 s** → F6 |
| `node --test "tests/perception/**/*.test.ts"` | **10 / 10 pass，exit 0** |
| `python -m unittest discover -s tests/perception -t tests/perception` | **Ran 39 tests OK** |
| `npm test` | **125 / 125 pass，0 fail，exit 0** |
| `npm run check:docs` | 34 份 markdown、0 问题、**exit 0** |
| 读真库 `data/perception/field-test.sqlite`（node:sqlite 只读） | `events` 6 行全为 `presence.changed`/`schema_version 1`；`world_state` 1 行（`present`/0.75/60.0），`updated_at` 与最后事件 `timestamp` 逐字相同；`schema_migrations` (1,001)(2,002) |
| **read_image(`data/recon/camera-frame-DSHOW-0.png`)** | 640×480，画面是「天花板 + 空调 + 衣柜」，**没有人** → 证实「摄像头朝天」前提与「0 误报」结论成立 |
| `Get-FileHash data/models/face_detection_yunet_2023mar.onnx -Algorithm SHA256` | `8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4`，232,589 B → F5 的补充 |
| 全服务 import/AST 自查 + `git ls-files "*.png" "*.jpg" "*.avi" "*.onnx" "*.sqlite"` | 无网络客户端、无写图路径；被 git 跟踪的图像/模型/库文件 **0 个** |

**未做的**：我没有复现「无摄像头 → exit 2」（需要制造设备占用，会打断现场可用状态）；采用了 verifier 的 `--camera-index 9` 记录 + 我读到的 `camera.py:104-150` / `run.py:325-331` 代码路径作为证据。这一条仍属「代码 + 他人实测」，未由我独立复现，如实标注。

**合规提示**：为确认 F3 我运行了 `--self-test`，但**用了隔离库**（`%TEMP%`），没有向 `data/perception/field-test.sqlite` 再写合成事件；不过 `--help` 不存在导致我意外触发了两次真实摄像头运行（8 s + 20 s），它们往真库各写了 1 条启动记录（`reason=camera_started`，无人画面，属真实运行）。我读到的真库当前状态：`events` 共 6 行，其中 4 条为 12:04 的合成事件（F3 的清理建议）。所有我创建的临时文件（`data/review-t8-*.mjs`、`data/t8-*.txt`、`%TEMP%\t8-*.sqlite`）已删除；`git status` 里属于我的只有本文件。

---

## 9. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | t3 八条验收标准 | **8 条全部真正满足**（第 6、7 条附 F1/F2/F5/F6，均不推翻条款成立） |
| 2 | 契约复用（重点） | **证实**：未新增事件类型、未改 schema、漂移测试未动、Python 用磁盘上同一份 schema 自校、TS 侧再复核，真库 payload 仅两个键 |
| 3 | 隐私与外传（重点） | **通过**：服务内无网络客户端、无写图路径（AST 扫描在跑）、`data/` 全忽略且无图像被跟踪；**唯一弱点是测试断言的范围比自称的窄**（F1） |
| 4 | 防抖参数（重点） | **通过**：15/45/3000/1500 与代码一致，理由可指到实测或明确取舍；行为有 39 项用例钉住（F4 只是文档把取舍写进了实测段） |
| 5 | 复核 verifier | **可信、克制**；它是靠真实抓帧 + 真库 + 独立复跑得出结论的，未把未测写成通过；漏检一处（self-test 合成事件进真库） |
| 6 | 铁律与依赖 | **通过**：无 torch/GPU、无高风险能力、无模型私有推理、未跨里程碑 |
| 7 | 文档诚实性 | 基本诚实（未完成项、外部图许可都如实）；F1/F4/F5/F6 四处措辞或证据范围需修 |
| 8 | 环境门禁 | 我自己复跑：`npm test` 125/125、`check:docs` exit 0、Python 39/39、perception node 10/10、真实摄像头 PASS |

**总判定：needs_revision**。修掉 **F1**（隐私断言的盲区或注释）与 **F2**（未知 flag 静默 PASS，会让「真人检出」这条唯一的人肉验收假通过）之后，t3 产物我判 **pass**。F3（合成事件与被冒充的现场事实）虽不影响功能，但**建议一并修**，因为它是这个库里唯一一处「读起来像真的、实际没发生过」的数据；F4/F5/F6 是文档与入口的小修。
