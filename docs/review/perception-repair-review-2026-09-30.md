# 评审（round 2）：摄像头在场检测修复（t26，对 t8 findings F1–F6 与披露项）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t8 评审者与 t26 实现者）
> 日期：2026-09-30
> 评审对象：t26「repair-round-2」（修 t8 评审的 F1 `data/` 隐私覆盖口径、F2/F6 未知 flag 与缺 `--help`、F3 self-test 污染现场库、F4 取舍/实测混写、F5 模型缺指纹），含它主动披露的 changedPaths 之外的一处编辑
> 唯一写入路径：本文件
> 权威来源（本评审实际跑过/读过的）：`tests/perception/camera-presence.test.ts`、`scripts/verify-camera-presence.ts`、`services/perception-edge/perception_edge/detector.py`、`docs/design/perception.md`、`docs/recon/camera-detector-choice-2026-09-30.md`、`data/perception/{field-test,self-test}.sqlite`（只读），以及**我自己跑的 5 条命令**（见 §6）
> 上一轮血缘：本任务复核的 findings 由我在 t8 评审里提出（`docs/review/perception-implementation-review-2026-09-30.md`）

---

## 1. 结论

**verdict：pass（无 blocking finding；另有 2 条「观测」记录在 §4，不改变判定）**

一句话：**t26 的六处修复我逐条独立验证成立**——`--require-transiton` 拼错时中文报错并 **exit 1**；`--help` **exit 0 且不写库**（`field-test.sqlite` 的 `LastWriteTimeUtc` 前后一致）；`--self-test` 现在默认写 `data/perception/self-test.sqlite`，跑完**现场库 mtime 未变**；现场库 `field-test.sqlite` 的 `presence.changed` **6 条全部是真实来源（`reason=camera_started`）、合成事件 0 条**（我按 payload 逐行判来源，不是按数量猜）；`self-test.sqlite` 独立持有 3 条启动 + 6 条合成转换；两个库里 `world_state.updated_at` 都**逐字等于该库最后一条事件的 timestamp**（说明清掉合成记录后投影是按「最后一条事件→投影」重建的）；模型指纹我**自己重算**：`232,589 B` + `SHA-256 = 8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4`，与 `detector.py`、`perception.md §3.4`、勘测 §8.1 三处**逐字一致**；`npm test` **139/139（0 skipped）**、`check:docs` **exit 0** 都是我自己跑的。

t26 主动披露的那处越界编辑（`docs/recon/camera-detector-choice-2026-09-30.md`）我逐处核对：**三处内容正确、指纹一致**；按任务约定，**captain 决定保留该编辑、不要求回滚**，我在此明确记录（§3.4）。

| 维度 | 判定 |
|---|---|
| F1（`data/` 隐私覆盖口径） | **真正修好**：`data/` 现在是「文件名集合前后比较」，且新增用例**证明该比较会真正触发**（我实跑这两条用例都通过） |
| F2/F6（未知 flag / `--help`） | **真正修好**：`--require-transiton` → 中文报错 + 用法 + **exit 1**；`--help` → **exit 0**、**DB mtime 未变** |
| F3（self-test 污染现场库） | **真正修好**：默认走独立自检库；现场库 0 条合成；显式 `--db` 时打印中文警告（我实测）；投影与最后一条事件时间戳一致 |
| F4（取舍/实测混写） | **真正修好**：`detector.py` 的 `DetectionConfig` 注释明确分成 `MEASURED` 与 `DESIGN TRADEOFF`，并写明 0.66% 与 0.5% 是两个量 |
| F5（模型缺指纹） | **真正修好**：三处写入同一 SHA-256 与大小，且我本地重算一致 |
| 披露的越界编辑 | **内容正确**：勘测 §0 速览第 3 行、§1 候选表、§8.1 指纹表（含复现与「换模型必须同步」）三处；**captain 决定保留** |
| 门禁（我自己跑） | `npm test` 139/139（0 skipped）、`check:docs` exit 0 |
| 范围纪律 | 除那一处已披露并获准保留的编辑外，未越界；未新增依赖、未改契约与迁移 |

---

## 2. 逐条核对 t26 的修复（对我 t8 findings）

| 我 t8 的 finding | t26 的修法 | 我的独立核对 | 判定 |
|---|---|---|---|
| **F1**：隐私断言注释说「`data/` … asserted in the privacy test」，但 `WATCHED_IMAGE_DIRS` 只含服务目录与测试目录，`data/` 从未被扫描 | 新增 `walkImageFiles`（递归，含子目录）/`imageNameSet`/`newImageNames`；在 Python 子进程**之前**取基线、**之后**比较；注释改写为「服务目录与测试目录断言无图；`data/` 只比较，因为 T0 留下历史抓帧」 | 读 `tests/perception/camera-presence.test.ts:32-67`（注释与三个 helper）与 `:220-256`（隐私用例）：`:225` 取基线 → `:227` 跑 Python → `:244` 用 `newImageNames` 断言「无新增」→ `:252` 还断言基线 `>= 4`（防止基线为空导致断言永不 fire）。**我实跑该用例 → 通过**；`data/` 现有 5 个图片（models 3 + recon 2），比较是**真在跑**的 | **真正修好** |
| 同上：「是否有一条用例证明该比较会真正触发」 | 新增 `test('the data/ watching rule detects a newly written image')` | 读 `:258-268`：分别断言「一样的集合 → 无新增」「多一个 `fresh-capture.png` → 报它」「移动文件（同名不同路径）→ 不报」；**我实跑 → 通过**。这不是空断言 | **真正修好** |
| **F2/F6**：未知 flag 被静默忽略；`--help` 不存在（会直接开摄像头跑 20 s） | 新增参数白名单 + `parseArgs`；未知参数中文报错 + 用法 + exit 1；`--help` 在任何 Python 探测/开库之前处理；USAGE 单一定义 | 实跑 `node scripts/verify-camera-presence.ts --require-transiton` → **exit 1**，stderr 首行「参数错误：无法识别的参数「--require-transiton」。」并打印完整用法（含「退出码：…1 失败（含未知参数）」）。实跑 `--help` → **exit 0**，输出以「摄像头在场检测验收（M6）/ 用法：」开头；**`field-test.sqlite` 的 `LastWriteTimeUtc` 前后一致**（未写库）；用法文本里明写「`--help` 打印本用法后退出（不打开摄像头、不写库）」 | **真正修好** |
| **F3**：`--self-test` 的合成事件写进现场共用库、库内无法区分 | 新增 `data/perception/self-test.sqlite` 作为 `--self-test` 默认库；显式 `--db` 时打印中文警告；stdout/summary 新增 `db`/`db_choice`/`db_note` | 实跑 `--self-test`（不给 `--db`）→ **exit 0**，`db` 指向 `self-test.sqlite`，而**现场库 `field-test.sqlite` 的 `LastWriteTimeUtc` 未变**。实跑 `--self-test --db <临时库>` → stderr 打出「注意：你显式指定了 --db …，所以自检的合成事件会写进这个库，而不是默认的自检库 …」+ 文件名，JSON 里 `db_note` 也写明「它的 presence 事件不是关于房间的证据，消费方不要把自检库当成现场台账」 | **真正修好** |
| **F3 附带**：真库里的合成事件要清掉、投影要正确重建 | t26 称真库原有 **3 条**合成（验收文字写的 4 条中第 4 条只在投影历史里），删除后重建 `world_state` | 我逐行 dump `field-test.sqlite`：`presence.changed` **6 条，全部含 `reason=camera_started`，合成 0 条**；`world_state = {value: absent, confidence: 0.85, ttl 60}`，且 **`updated_at` 逐字等于该库最后一条事件 timestamp**。对照 `self-test.sqlite`：9 条（3 启动 + 6 合成），其 `world_state.updated_at` 也逐字等于它自己最后一条事件。→ 合成记录确实已从现场库移除，投影按「最后一条事件」重建正确 | **真正修好** |
| **F4**：perception.md 把「0.5% 占比」这条设计取舍写在「实测」段 | `detector.py` 的 `DetectionConfig` 注释拆两段 | 读 `detector.py:48-70`：`MEASURED — a static scene produced mean absolute difference 0.8 grey levels, p99 5.0, with 0.66% of pixels above 5 grey levels (T0 recon)` 与 `DESIGN TRADEOFF — the 0.5% "share of changed pixels" rule is *chosen*, not measured … 0.66% is a *different* quantity` 明确分开，并写明「服务实测：空场景/高斯噪声 0.0，人走动 0.0089–0.087」 | **真正修好** |
| **F5**：模型有来源 URL、没有指纹 | 把 `232,589 B` 与 `SHA-256` 写进 `perception.md §3.4` 与 `load_yunet_model_path()` 注释（含复现命令与「换模型要同步文档并重跑 bench」） | 读 `detector.py:197-206`（size / sha256 / 复现命令 / 「update the SHA-256 in both documents and re-run bench」）与 `docs/design/perception.md:87-88`。**我自己重算**：`Get-FileHash data/models/face_detection_yunet_2023mar.onnx -Algorithm SHA256` → `8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4`，`(Get-Item).Length` → `232589`；三处文档逐字一致 | **真正修好** |

---

## 3. 复核 t26 披露的、未进 changedPaths 的那处编辑

### 3.1 三处具体位置

| # | 位置 | 内容 | 我的核对 |
|---|---|---|---|
| 1 | `docs/recon/camera-detector-choice-2026-09-30.md:15`（§0 结论速览第 3 行） | YuNet「要」（`232,589 B = 227 KB，SHA-256 8F2383E4…52FA4`，见 §8.1） | 数值与实测一致；指向的 §8.1 真实存在 |
| 2 | 同文件 `:27`（§1 候选与排除理由，YuNet 行） | 「`face_detection_yunet_2023mar.onnx` 227 KB，SHA-256 `8F2383E4…52FA4`（见 §8.1）」 | 一致；缩写形式（`…52FA4`）在同一文件内可解析 |
| 3 | 同文件 `:150-167`（**新增 §8.1 模型指纹**） | 表格：路径 / 大小 `232,589 B` / SHA-256（完整值）/ 复现命令 `Get-FileHash …` / 下载地址（OpenCV Zoo）/ 校验命令；并写明「换了模型（哪怕是同名文件的新版本）**必须**同时更新这里的 SHA-256、`docs/design/perception.md` §3.4 与 `detector.py` 的 `load_yunet_model_path()` 注释，然后重跑基准」 | 与 `perception.md:87-88`、`detector.py:199-201` **逐字一致**；「同步义务」的措辞与代码注释里的说法一致 |

### 3.2 结论与处理

- **内容正确**：三处都是「补上同一个已实测指纹」，没有引入新数字；SHA-256 与大小**我本地重算一致**。
- **边界情况说明**：该文件是 `docs/recon/` 层的**带日期历史记录**，其自身维护规则是「新的实测写新文件、不要改写本文的数字」。t26 的改动**只增不删**（新增 §8.1、在已有行内追加指纹、没有改动任何历史数字），所以没有违反那条规则；但它仍然是一次「为满足别处文档要求而回改历史记录」的动作，值得留痕。
- **记录（按任务要求写明）**：**captain 决定保留该编辑、不要求回滚**。我据此不把它当作 finding；同时建议（不阻塞）在收尾时把这次编辑写进 `docs/progress.md` 的一次性说明，避免下一个人以为 `recon/` 层被无痕改动。

---

## 4. 观测（不构成 finding，不改变 pass）

### 4.1 `data/` 的比较是「文件名集合」——同名覆盖不会被发现

- **位置**：`tests/perception/camera-presence.test.ts:55-67`（`imageNameSet` 用 `split('/').pop()` 取名字）与 `:244`
- **事实**：现在断言的是「跑完之后**没有出现新的文件名**」。这对「检测器把画面写成新文件」是有效的（也是最该防的那种）；但若把画面**覆盖写到既有名字**（例如正好写成 `camera-frame-DSHOW-0.png`），名字集合不变 → 这条断言不会报。
- **为什么仍是 pass**：`services/perception-edge` 里**没有任何写图路径**（我 t8 评审已 grep + AST 扫描确认），所以今天这个盲区无法被触发；而且 t26 的修法已经把我指出的「`data/` 从未被扫描」补上，并且用 `>= 4` 的下界防止「基线为空导致永不 fire」。
- **可选加固（将来若有人给检测器加调试落图功能再做）**：基线存 `name → (mtimeMs, size)`，之后对既存文件也比较这两个值，或对基线文件算内容哈希。这样连「同名覆盖」也能发现。

### 4.2 现场库的 `presence.changed` 计数：t26 报告 5 条，我核到时是 6 条——差异来自之后一次真实运行

- **事实**：t26 报告「现 `field-test.sqlite` 的 5 条 `presence.changed` 全部 `reason=camera_started`、0 条合成」；我核到时是 **6 条**，逐行判来源后**同样全部是 `reason=camera_started`（合成 0 条）**，`world_state.updated_at = 2026-09-30T12:45:58.774+08:00` 等于最后一条事件时间戳。
- **解释**：`:45:58` 那次运行晚于 t26 的统计时刻（t8 之后我本人也在这台机器上跑过真机验收，它每次都会写一条启动记录）。**结论不变**：现场库今天 0 条合成、投影与最后一条事件一致——判据（「全部真实来源」）成立，只是**计数会随运行次数增长**，所以「N 条」这类数字不该被写死进文档（与 AGENTS.md §9.18 同一条教训）。
- **建议（不阻塞）**：若文档里要点名数量，写成「全部 `reason=camera_started`；数量随运行次数增长，不写死」的措辞。

---

## 5. 我实际跑过的命令与结果（可核账）

| 命令 | 结果 |
|---|---|
| `node scripts/verify-camera-presence.ts --require-transiton` | **exit 1**；stderr「参数错误：无法识别的参数「--require-transiton」。」+ 完整中文用法（退出码说明含「1 失败（含未知参数）」）→ §2 F2/F6 |
| `node scripts/verify-camera-presence.ts --help` | **exit 0**；输出「摄像头在场检测验收（M6）/ 用法：…」；**`data/perception/field-test.sqlite` 的 `LastWriteTimeUtc` 前后一致**（未写库、未开库）→ §2 F2/F6 |
| 读 `data/perception/{field-test,self-test}.sqlite`（`node:sqlite` 只读，逐行 dump `presence.changed`） | field-test：**6 条全部 `reason=camera_started`、合成 0**；`world_state.updated_at` == 最后一条事件 timestamp。self-test：**9 条（3 启动 + 6 合成）**，同名时间戳关系同样成立 → §2 F3 |
| `node scripts/verify-camera-presence.ts --self-test`（不给 `--db`） | **exit 0**；`db` 指向 `data/perception/self-test.sqlite`；**现场库 mtime 未变** → §2 F3 |
| `node scripts/verify-camera-presence.ts --self-test --db <临时库>` | **exit 0**；stderr 中文警告「你显式指定了 --db …」；`db_note` 写明「消费方不要把自检库当成现场台账」→ §2 F3 |
| `Get-FileHash data/models/face_detection_yunet_2023mar.onnx -Algorithm SHA256` + `(Get-Item).Length` | `8F2383E4DD3CFBB4553EA8718107FC0423210DC964F9F4280604804ED2552FA4` / `232589` → 与三处文档逐字一致 → §2 F5 |
| `node --test "tests/perception/**/*.test.ts"` | **11 / 11 pass**，含 `the privacy boundary is enforced by the code, not only by the docs` 与 `the data/ watching rule detects a newly written image` → §2 F1 |
| `npm test` | **tests 139 / pass 139 / fail 0 / skipped 0 / exit 0** |
| `npm run check:docs` | **41 份 markdown；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；exit 0** |

**真实 API 调用：0 次**。**合规说明**：只读打开两个现场库；`--self-test --db` 用的是系统临时目录并在测后删除；未改动任何实现代码、测试或他人文档；`data/t27-*` 临时文件**已删除**。

---

## 6. 结论表

| # | 维度 | 判定 |
|---|---|---|
| 1 | F1 `data/` 隐私覆盖 + 「比较会触发」用例 | **真正修好**（我实跑两条用例通过；基线有下界断言防止永不 fire） |
| 2 | F2/F6 未知 flag / `--help` | **真正修好**（拼错 → exit 1 + 中文用法；`--help` → exit 0 且 DB mtime 未变） |
| 3 | F3 self-test 与现场库分离 + 合成清理 + 投影重建 | **真正修好**（默认写自检库；现场库 0 合成；两库 `world_state.updated_at` == 各自最后一条事件） |
| 4 | F4 实测 / 设计取舍分开 | **真正修好**（`MEASURED` vs `DESIGN TRADEOFF` 两段，0.66% 与 0.5% 明确为两个量） |
| 5 | F5 模型指纹 | **真正修好**（代码 + 两份文档三处一致，我本地重算相同） |
| 6 | 披露的 `docs/recon/...` 编辑 | **内容正确**；**captain 决定保留、不要求回滚**（已在本文件记录） |
| 7 | 门禁 | `npm test` 139/139（0 skipped）、`check:docs` exit 0（我自己跑） |
| 8 | 观测（不阻塞） | ① `data/` 比较是文件名集合，同名覆盖不会被发现（今天无法触发，已给可选加固）；② 现场库事件计数会随运行次数增长，文档不该写死数量 |

**总判定：pass**。t26 的六处修复**每一处都有我自己的实测/重算作为依据**，其中三条（未知参数、`--help` 无副作用、self-test 与现场库分离）是可执行行为、两条（现场库 0 合成、投影时间戳一致）是数据核对、一条（指纹）是本地重算。它主动披露的那处越界编辑内容正确、按 captain 决定保留。§4 的两条观测不影响判定，留给后续维护参考。
