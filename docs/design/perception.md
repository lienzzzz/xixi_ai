# 感知边（perception-edge）：摄像头在场检测 M6

> 最后更新：2026-09-30
> 权威来源：`services/perception-edge/perception_edge/**.py`、`packages/domain/src/{store,migrations/002_world_state.sql}`、
> `scripts/verify-camera-presence.ts`、`tests/perception/**`。实测数字另见
> [`../recon/camera-detector-choice-2026-09-30.md`](../recon/camera-detector-choice-2026-09-30.md)；
> 若与代码不一致，以代码为准，并立即修正本文件。

范围：**M6 的最小可用版本**——西西知道「家里有没有人」，以及人什么时候出现/离开，全部在本机完成。
不做人脸识别（不回答「是谁」）、不录像、不多机位、不做语义理解。

## 1. 当前实现状态（区分「已实现」与「接口已留」）

| 能力 | 状态 |
|---|---|
| 从默认摄像头周期抓帧 | **已实现**（DSHOW 后端，640×480@30 级） |
| 本地判定有人/无人（帧差动 + 人脸确认） | **已实现** |
| 状态变化写成 `presence.changed` 事件 | **已实现**（复用已发布的 v1 契约，未新增事件类型） |
| WorldState-lite 当前在场投影（value/source/updated_at/confidence/TTL） | **已实现** |
| 防抖（短暂遮挡 / 单帧误检不翻转） | **已实现**（参数与理由见 §4） |
| 连续视频不上云 | **由构造保证**（无网络客户端；有测试断言） |
| 按需语义分析（截图交多模态模型） | **刻意未实现**：只留接口 `SemanticAnalysisHook`，调用即抛错 |
| 真人站在镜头前的检出自测 | **未完成**：摄像头朝天，需要人参与，见 §8 |

## 2. 数据流（一条线，没有旁路）

```text
默认摄像头 (CAP_DSHOW, 640x480)
   │  逐帧，只在内存里
   ▼
帧差动门（320x240 灰度，阈值 6 灰阶 + 运动像素 ≥0.5%）───┐
   │                                                      │ 每帧
   └─ 每 10 帧一次：YuNet 人脸确认（227 KB onnx）─────────┤
                                                          ▼
                                          PresenceDebouncer（双阈值滞回 + 最短证据时长）
                                                          │ 只在状态翻转时
                                                          ▼
                                    presence.changed 事件（xixi.event.v1，v1 payload）
                                                    │
                        ┌───────────────────────────┴───────────────────────────┐
                        ▼                                                       ▼
              events 表（历史，唯一事实来源）                    world_state 表（当前投影，可重建）
```

**为什么历史只有一份**：`presence.changed` 事件是事实，`world_state` 是它的当前投影。
投影永远可以由日志重建（`XixiStore.rebuildWorldStateFromEvents()`，有测试证明），
所以不存在「两份真相」。这与 [`domain-model.md`](domain-model.md) §5 的取舍一致。

## 3. 检测：两层证据，一个判定

### 3.1 帧差动（廉价门，每帧）

- 抓到的 BGR 帧先降到 **320×240 灰度**再比较（海森：640×480 上做 `absdiff` 要贵 4 倍，降采样不损判定）。
- 判据是**两个条件同时满足**：单像素差 > **6 灰阶** 且 变化像素占比 ≥ **0.5%**。
  - 6 灰阶来自 T0 实测：静态场景平均绝对差 0.8 灰阶、p99 = 5.0，阈值必须高于噪声底；
  - 0.5% 占比是为了挡住「全画面 1 个灰阶的缓慢漂移」（自动曝光会整幅变一点点）。
- 实测：空场景与高斯噪声场景 `motion_ratio = 0.0`；人走动时 0.0089–0.087。

### 3.2 人脸确认（每 10 帧一次）

- 后端优先级：`cv2.FaceDetectorYN`（YuNet，227 KB，score 阈值 0.6）→ Haar 正面脸 → 无。
  显式降级：`summary.face_backend` 会写 `yunet` / `haar_frontalface` / `none`，
  后端抛异常时该帧按「没有人脸」处理（**检测器故障不能变成「有人」**，有测试）。
- 只每 10 帧跑一次：人脸在 640×480 上要 29.3 ms（CPU），每帧跑会把 30 fps 预算吃满；
  0.3 s 跑一次足够，因为防抖层本来就需要连续 15 帧（≈0.5 s）证据。
- 人脸是**增强证据**不是必要条件：背对镜头的人没有脸，但会动。

### 3.3 判定与置信度

| 情况 | 判定 | 事件 confidence |
|---|---|---|
| 运动 + 人脸 | 有人 | **0.9** |
| 只有运动（人脸没跑到或没检到） | 有人 | **0.75** |
| 连续无证据 + 过了释放宽限 | 无人 | **0.85** |

置信度含义是「这条事实有多可信」（[`../event-contracts.md`](../event-contracts.md)），
不是「西西觉得多重要」。

### 3.4 检测器选型的实测与理由

完整表格（模型来源/大小/是否需下载/单帧耗时/CPU 占用）在
[`../recon/camera-detector-choice-2026-09-30.md`](../recon/camera-detector-choice-2026-09-30.md)。摘要：

- **YuNet** 227 KB、需下载（`data/models/face_detection_yunet_2023mar.onnx`，仓库不跟踪）、
  640×480 中位 **29.28 ms**、CPU 单核当量 **604.8%**（整机 75.6%）；
  模型指纹（**换模型必须同步更新本行与勘测报告**）：
  **232,589 B，SHA-256 = `8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4`**
  （复现：`Get-FileHash data/models/face_detection_yunet_2023mar.onnx -Algorithm SHA256`）；
- **Haar** 930 KB、OpenCV 自带、18.64 ms 但正对照召回明显弱（自拍照 640×480 只中 5 张脸，YuNet 中 46 张）；
- **HOG 行人不用**：空场景同一参数下报 0–2 个「人」、107.6 ms/帧；
- **没有引入 torch**：基准里 `torch_installed=false`，并且有测试用 AST 扫描禁止
  `torch` / `requests` / `socket` / `httpx` 等 import 进入本服务。

## 4. 防抖：参数、理由、以及「允许什么」

实现：`perception_edge/debounce.py` 的 `PresenceDebouncer`。参数都是构造参数，可调、可测。

| 参数 | 默认 | 单位换算 | 理由 |
|---|---|---|---|
| `present_confirm_frames` | **15** | ≈0.5 s @30 fps | 进门/抬头这类真实动作至少持续半秒；一帧的误检（椒盐噪声、灯光跳变）过不了 |
| `absent_confirm_frames` | **45** | ≈1.5 s @30 fps | 「离开」比「到来」需要更多证据：漏一次问候的代价小，误判「家里没人」会让西西对着空房间说话 |
| `release_grace_ms` | **3000** | 3 s | 最后一次证据之后至少再等 3 s 才允许宣布无人；短暂遮挡（手挡镜头、弯腰捡东西）不会翻转 |
| `minimum_evidence_ms` | **1500** | 1.5 s | 一段**连续**证据短于 1.5 s 一律不算「人」。这条挡住「达到帧数但总时长很短」的假阳性（例如 4 帧 / 100 ms） |
| `initial_state` | `absent` | — | 启动时把「无人」当初始状态，避免开机就播一次没人触发的问候 |

三条测试钉住的行为：

1. **单帧误检**：空场景插一帧 25% 椒盐噪声 → 只有启动那一条状态，**0 次转换**；
2. **短暂遮挡**：人走动 → 镜头被挡 0.5 s → 人继续走动 → 只产生 1 次「有人」，**没有**「有人→无人→有人」抖动；
3. **真实离开**：5 s 没有证据 → 恰好 1 次「无人」，持续安静不会重复发事件。

**允许什么（说清楚边界）**：镜头被真正挡住超过 3 s，就会产生一次「无人」事件——这是**正确的**，
因为那 3 秒里确实「看不见人」。重点是一次成对事件，不是事件抖动。

## 5. 事件：复用已发布的契约，不新增类型

`presence.changed` **v1 已经存在**（`packages/contracts/schemas/events/presence.changed.v1.json`，
payload `{present, source_detail}`，`additionalProperties: false`），所以本任务**没有新增事件类型、
没有改 schema、没有动漂移测试**。检测细节写进信封既有字段：

- `source`：`perception.laptop_camera`（生产者名字）
- `confidence`：见 §3.3
- `payload.source_detail`：一行证据摘要（≤200 字符），例如
  `state=present frames=16 motion_ratio=0.0318 faces=1 gate=motion+face reason=present_confirmed`
- `timestamp`：`YYYY-MM-DDTHH:MM:SS.mmm±HH:MM` 本地墙上时间（契约拒绝 `Z`，见 [`domain-model.md`](domain-model.md) §2）

Python 侧不能「以为自己对」：`perception_edge/contracts.py` 用**磁盘上的同一份 schema 文件**
校验自己构造的事件（实现了契约实际用到的那一小撮 JSON Schema 关键字，遇到没实现的关键字直接报错），
TypeScript 侧再用权威的 `validateEvent()` 复核一遍（`tests/perception/camera-presence.test.ts`）。
图像与逐帧特征**不写事件**：日志只存事实，不存传感器流。

启动时额外发一条「初始状态」（`source_detail` 里 `reason=camera_started`），好处是投影从第一秒就存在，
读取方永远能看到 value + updated_at + TTL；代价是多一条事件。验收脚本会把「启动记录」与
「真实转换」分开计数，避免用启动记录冒充检出。

## 6. WorldState-lite：迁移、语义、TTL

迁移 [`002_world_state.sql`](../../packages/domain/src/migrations/002_world_state.sql)（新增，不改 001）：

| 列 | 含义（对应《方案》§5.3） |
|---|---|
| `key` | `presence.home`（点分命名空间；表结构不特化，将来可加别的键） |
| `schema_version` | 1（铁律 10：持久记录都带版本） |
| `value` | `'present'` / `'absent'`（存文本，因为将来的状态值不都是布尔） |
| `source` | 生产者，如 `perception.laptop_camera` |
| `updated_at` | 本地墙上时间，与事件时间戳**同一个值** |
| `confidence` | 0–1 |
| `ttl_seconds` | **§5.3 的 TTL / stale_after**：默认 **60 s** |

读取方用 `XixiStore.worldState('presence.home')`，得到
`{key, value, source, updatedAt, confidence, ttlSeconds, stale, staleAfter, present}`：

- `staleAfter = updatedAt + ttlSeconds`；`stale = now >= staleAfter`。
- `stale = true` 表示这个值**不再是「现在」**，消费方必须当作「不知道」，不得拿 30 分钟前的视觉结果当现在。
- 60 s 是相对生产者选的：运行中的检测循环每次状态翻转都刷新它，健康时永远在窗口内；
  循环死掉 60 s 后自动变 stale——这正是这套 TTL 要暴露的故障。

**历史仍然只有事件日志**：`world_state` 只有一行（每个 key），
`XixiStore.rebuildWorldStateFromEvents()` 能用日志重建它（有测试：删掉投影行 → 重建 → 值和时间戳一致）。

**写入路径是一个事务**：`recordPresenceChanged()`（TypeScript）与
`EventEmitter.emit()`（Python `--append`）都把「追加事件」和「更新投影」放在同一个事务里，
所以不会出现「日志里有到达事件、投影还是 absent」。Python 侧只做 INSERT，**不建表、不迁移**：
库里没有 `events` 或 `world_state` 表时它会**跳过写库并说明原因**，而不是半写。

## 7. 隐私边界：连续视频不出本机

| 保证 | 怎么做到的（可核查） |
|---|---|
| 没有网络客户端 | 服务里没有 `requests`/`httpx`/`socket`/`aiohttp`/`websockets` 的 import（测试用 AST 扫描断言） |
| 画面不落盘 | 帧只在内存中存活一次 `detect()` 调用；测试断言服务目录与测试目录里没有图片/视频文件 |
| 事件不含图像 | payload 只有 `{present, source_detail}`；`source_detail` 是一行文字摘要 |
| 语义分析没有偷偷调用 | `SemanticAnalysisHook.on_presence_changed()` 默认什么都不做；打开 `enabled` 会**抛错**；`capture_snapshot()` 直接抛 `SemanticAnalysisNotImplemented` |
| 每次运行自报边界 | `summary.privacy` = `{video_uploaded: false, stills_uploaded: 0, frames_written_to_disk: 0, network_clients: 0, local_only: true}` |

「截图交多模态模型」的接口留在 `services/perception-edge/perception_edge/semantic.py`，
并在文件头写清了将来实现必须遵守的五条（按需触发、单帧、可审计、结果带 TTL、默认关闭）。
本任务**不实现调用**，这是刻意的：一旦有调用路径，就有「不小心把视频传出去」的可能。

## 8. 验收：离线测试、真实摄像头、以及必须由人完成的一步

### 8.1 离线（每次 `npm test` 都跑）

```powershell
npm test                                     # 含 tests/perception/camera-presence.test.ts（驱动下面的 Python 套件）
E:\worker2\.venvs\cv4\Scripts\python.exe -m unittest discover -s tests/perception -t tests/perception -v
```

解释器选择是**显式探测**（`XIXI_PERCEPTION_PYTHON` → `.venvs/cv4` → `.venvs/field-probe`），
一个都没有时测试**失败并给出安装命令**，不会静默跳过。

覆盖的边角（`tests/perception/test_presence.py`，39 个用例）：

| 组 | 覆盖 |
|---|---|
| 场景自检 | 空场景无运动、人走动有运动、高斯噪声不是运动 |
| 运动门 | 1 灰阶全局变化不算运动、40 灰阶算；椒盐噪声帧只在它的两次转换上是「运动」 |
| 人脸确认 | 空场景/噪声 0 张脸；人脸检测按 `face_every_n_frames` 跳帧；后端抛错不算「有人」 |
| 防抖 | 1 帧不翻转、3 帧 + 100 ms 才翻转、<1.5 s 的证据算噪声、短证据、短遮挡不成对、长遮挡正好一次、释放宽限 |
| 场景端到端 | 到达/离开 2 次转换、空房间 0 次转换、一次转换一条事件、启动记录只有一条 |
| 契约 | 自建事件通过磁盘 schema、payload 不能加字段、`source_detail` 200 上限、confidence 范围 |
| 写库 | 缺库/缺表跳过并说明、缺 002 迁移拒绝写入、写成功后事件与投影都在 |
| 隐私 | 无网络 import、无语义分析调用、运行后没有图片文件 |

### 8.2 真实摄像头（会占用摄像头，**不会**上传任何画面）

```powershell
node scripts/verify-camera-presence.ts --seconds 15
# 自检路径（生成帧，不需要真人；写入**专用自检库**，不会混进真实摄像头台账）
node scripts/verify-camera-presence.ts --self-test
# 真人实测（需要人参与）
node scripts/verify-camera-presence.ts --seconds 40 --require-transition
# 用法（只打印，不开摄像头、不写库）
node scripts/verify-camera-presence.ts --help
```

- **两个库，别写混**（`--db <path>` 可显式覆盖，覆盖时会打印警告）：
  - 真实摄像头 → `data/perception/field-test.sqlite`（现场测试台账）；
  - `--self-test` → `data/perception/self-test.sqlite`（合成帧的自检库，默认单独一个文件）。
  这样「哪个库是真实房间的历史」靠文件名就能回答，不用去读 payload。自检运行会在 stdout 与
  `summary.db_choice` / `summary.db_note` 里写明这次写的是哪个库。
- **参数白名单**：只接受 `--seconds`、`--db`、`--camera-index`、`--self-test`、`--scenario`、
  `--require-transition`、`--require-event`（旧名）、`--min-fps`、`--help`。其它参数（例如把
  `--require-transition` 拼错成 `--require-transiton`）会**打印中文错误 + 用法列表并 exit 1**，
  不再静默按默认设置继续跑——静默继续是最坏的结果，因为它看起来像成功了。
- 输出：事件（含 event_id/payload）、过渡轨迹、处理帧率、抓帧耗时分布、检测耗时、
  最终 `world_state`（含 `stale`）、以及 `privacy` 与 `semantic_analysis` 的自报状态。
- 退出码：`0` 通过（含 `--help`）；`2` **没有可用摄像头**（明确失败，打印可能原因与排查动作）；
  `3` 缺模型或解释器；`1` 其它失败（含未知参数、`--require-transition` 未满足）。
- `--require-transition`：整个运行期没有**真实状态转换**（只有启动记录）就判失败——
  这是「人真的站在镜头前」那一步用的。

**台账现状（实测，可复核）**：`data/perception/field-test.sqlite` 里现在只有 **5 条
`reason=camera_started`** 记录，全部来自真实摄像头的空场景运行，**没有任何合成事件**。
历史上曾有 4 条合成事件（早期版本 `--self-test` 还写同一个库：2 条
`reason=present_confirmed`（`motion_ratio=0.148` / `0.0318`，无人脸证据）+ 1 条
`reason=absent_confirmed`，时间戳 `2026-09-30T12:04:1x`），它们已在本次补正中**逐条删除**，
并按「最后一条事件 → 投影」重建了 `world_state`，日志与投影重新一致。

复核命令（不需要 Python 之外的依赖）：

```powershell
E:\worker2\.venvs\cv4\Scripts\python.exe -c "import sqlite3,json;c=sqlite3.connect('data/perception/field-test.sqlite');print(c.execute(\"select timestamp,payload_json from events where event_type='presence.changed' order by sequence\").fetchall())"
```

如果要一条绝对干净的台账：删掉 `data/perception/field-test.sqlite` 再跑一次
`node scripts/verify-camera-presence.ts --seconds 15`（`data/` 是 gitignore 的本机目录）。
合成帧以后一律进 `data/perception/self-test.sqlite`，不会再混进这个库。

### 8.3 还没做的那一步（未完成项，明确标注）

**「真人站在镜头前能否被检出」尚未验证。** 当前摄像头朝天，画面里没有人；
本文件与勘测报告里的正对照要么是外部图片、要么是代码画的图，**不能当作真人实测**。

用户自测步骤（约 1 分钟）：

1. 坐到摄像头前，让画面里能看到人（上半身或脸）；
2. 运行 `node scripts/verify-camera-presence.ts --seconds 40 --require-transition`；
3. 期望看到：约 0.5 s 内出现一次 `present=true` 事件（confidence 0.75 或 0.9），
   帧率接近抓帧帧率，`world_state.present = true` 且 `stale = false`；
4. 走开 5 s 以上：期望出现一次 `present=false`，`stale = false`；
5. 把结果（脚本输出）贴回 `docs/progress.md`，并把本节的「未完成」改成实测事实。

## 9. 已知边界与不做的事

| 不做 | 原因 |
|---|---|
| 人脸识别（是谁） | 只回答「有没有人」；身份与高安全动作在 PoC 阶段不做（AGENTS.md 铁律 7） |
| 录像 / 存图 | 铁律 6：连续音视频不上云；本机也不存画面（`data/` 也不该积累人脸） |
| 常驻后台服务 | AGENTS.md §3：不要为实验引入常驻进程。当前是「一条命令跑一段」的模式 |
| 多机位 / 房间定位 | 属后续里程碑（方案 §4.1 的 Frigate/MQTT 路线） |
| MQTT 总线 | 本机没有 Docker，M0–M6 都是进程内直接落库（[`../adr/0004-in-process-event-bus-for-poc.md`](../adr/0004-in-process-event-bus-for-poc.md)） |
| M7 主动问候的接线 | 不在本任务范围：`presence.changed` 与 `world_state` 已经是消费方要的接口 |

**已知风险**：

1. 摄像头朝天/被挡住时，系统会如实报「无人」——这不是 bug，但会让上游以为家里没人；
   消费方应该同时看 `stale`（循环死掉 60 s 后自动 stale）。
2. 低光照下 YuNet 召回会下降；此时只剩运动证据（confidence 0.75）。
3. 帧差动对「大幅光照跳变」会判成运动；防抖层能挡住单次跳变，但持续闪烁会来回翻转。

## 10. 与其它模块的接口

- **读当前状态（推荐）**：`store.worldState('presence.home')`（`@xixi/domain`），
  字段 `{value, present, confidence, source, updatedAt, stale, staleAfter, ttlSeconds}`；
  `stale=true` 时必须显示「不知道」而不是旧值。
- **读历史**：`store.readEvents({type: 'presence.changed', limit: N})`，payload 是 `{present, source_detail}`。
- **写状态（唯一入口）**：`store.recordPresenceChanged({present, confidence, sourceDetail, ttlSeconds})`
  —— 事件 + 投影一个事务。其它进程不要直接写 `world_state` 表。
- **控制台**：`scripts/verify-camera-presence.ts` 是「一条命令跑通」的现场测试入口；
  界面聚合在 `scripts/field-test.ts`（由现场测试控制台任务负责）。

## 维护规则

统一规则见 [`README.md`](README.md#维护规则)。改本文件时对照：

| 改动 | 必须同步的本文件小节 |
|---|---|
| `perception_edge/detector.py` 的阈值 / 后端优先级 | §3（并更新 [`../recon/camera-detector-choice-2026-09-30.md`](../recon/camera-detector-choice-2026-09-30.md) 的新实测） |
| `perception_edge/debounce.py` 的参数默认值 | §4（参数要连理由一起改） |
| `packages/domain/src/migrations/002_world_state.sql` 的列/TTL | §6（并同步 [`domain-model.md`](domain-model.md) §5） |
| `presence.changed` 的 payload 形状 | **必须**新增 `v2` schema、升 `SCHEMA_VERSION`、更新漂移测试，并同步 §5 与 [`../event-contracts.md`](../event-contracts.md) |
| `perception_edge/semantic.py` 从 stub 变成实现 | §2、§7（必须写清触发条件、单帧大小、审计记录） |
