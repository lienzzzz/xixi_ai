# 复审：台账来源标记与「可能/确实」两段的证据链（t109）

> 最后更新：2026-09-30
> 评审人：reviewer（第二双眼睛，独立于 t101 的原始发现与本轮 t109 的订正）
> 评审对象：`bbf2476`「t109 完成：在场台账自带来源标记 + 把无法证实的断言拆成「可能」与「确实」两半」（`perception_edge/run.py`、`scripts/verify-camera-presence.ts`、`docs/design/perception.md`，共 +79 / −17）
> 复核方式：**两条路径各实跑一次**（都写到我自己的临时库，避免污染共用台账）+ **独立清点四个库的 `mode=` 标记**（不采信脚本自报）+ 文档逐句对原文 + 复现「逐字吻合」+ 门禁
> 时序：判读时 HEAD `d4fab2a`；工作区在途是别人的 `packages/conversation/src/{engine,index,prompt}.ts` 与 `scripts/field-test.ts`（与本次复核对象无关）

---

## 1. 结论

**verdict：needs_revision（1 条 low finding：F1 —— §8.2 那两条「复核命令」按文档原样在 PowerShell 里跑不起来；其余每一条我都独立验过并成立）**

一句话：**t109 的标记确实让台账自带来源**——我跑真机一次（`--seconds 3 --min-fps 1 --db <临时库>`）：1 条事件，`mode=camera`，`unmarked_events=0`；跑 `--self-test --db <临时库>`：4 条事件，**全部** `mode=synthetic`，`unmarked_events=0`（脚本自报与我用 `node:sqlite` 独立清点的结果一致）。**「确实」那一半也逐字复现成功**：`--self-test` 跑出来就是 `mode=synthetic … frames=47 motion_ratio=0.1480 … reason=present_confirmed`、`… frames=181 motion_ratio=0.0000 … reason=absent_confirmed`、`… frames=286 motion_ratio=0.0318 … reason=present_confirmed`——文档引的 `0.0318` 与 `frames=286` **一字不差**。**「可能是」那一半的措辞也对**（把「无法证实」写成了「可能 + 台账里没有标记能证明」）。唯一要修的是 **F1**：§8.2 给的两条复核命令里用了 `\"` 转义，而它们所在代码块标的是 ```` ```powershell ````——`\"` 在 PowerShell 里不是转义（AGENTS §9.8 专门记过这个坑），原样粘贴会得到 Python 的 `SyntaxError`；我另写了一条**实测可用**的替代（§5）。

| 任务验收条款 | 我的判定 | 依据 |
|---|---|---|
| 1 真机跑一次与 `--self-test` 跑一次，确认两条路径的 `mode` 标记分别为 camera / synthetic 且 `unmarked_events` 为 0；确认 §8.2「可能」「确实」两段的证据链分别成立（后者逐字吻合要能复现） | **成立（另发现 F1：文档两条复核命令跑不了）** | §2（两条路径）、§3（逐字复现）、§4（「可能」半逐句核）、§5（F1 + 可用替代） |
| 2 自己跑一次 npm test 与 npm run check:docs 并贴结果；结论落 `docs/review/` | **满足** | §6：`npm test` **235/235 pass / 0 fail / exit 0**；`check:docs` **74 份 / 0 问题 / exit 0** |

---

## 2. 两条路径的 `mode` 标记（我的独立清点，不是照抄脚本自报）

| 我跑的 | 脚本自报 `source_modes` | 我用 `node:sqlite` 独立清点 |
|---|---|---|
| `node scripts/verify-camera-presence.ts --seconds 3 --min-fps 1 --db %TEMP%\t110-camera.sqlite` | `expected: "camera"`、`from_events: ["camera"]`、**`unmarked_events: 0`** | `presence.changed = 1` 条，`{"camera":1}`，`unmarked_events=0`；原文 `mode=camera state=absent startup frames=0 motion_ratio=0.0000 faces=0 gate=motion+face reason=camera_started` |
| `node scripts/verify-camera-presence.ts --self-test --db %TEMP%\t110-synthetic.sqlite` | `expected: "synthetic"`、`from_events: ["synthetic"]`、**`unmarked_events: 0`** | `presence.changed = 4` 条，`{"synthetic":4}`，`unmarked_events=0`（四行原文见 §3） |

- 我特意用 `--db` 指向**临时库**，所以共用台账一条未加（§9）。自检模式用显式 `--db` 时脚本会打印「合成事件不是关于房间的证据」的警告——这是既定行为，不是问题。
- 顺带一条判读经验（不是 t109 的缺陷）：真机 `--seconds 2` 那次会因为「整个运行期没有运动证据」给 `verdict: FAIL`（我当时坐着不动）；同一台机器跑 `--seconds 3` 就是 `problems: []`、exit 0。所以短跑 FAIL 先看 `frames_with_signal` / `blank_frames_skipped`，别当成标记功能坏了。

---

## 3. §8.2「确实」那一半：逐字复现成功

文档（`bbf2476` §8.2 第 288–293 行）说：t92 删除的那 4 条里 `motion_ratio=0.148` / `0.0318` 这组数值**确实**来自合成场景，可复现的出处是 `--self-test` 自己的台账，其中 `0.0318` 与 `frames=286` **逐字吻合**。

我这次实跑 `--self-test`（写临时库）得到的四条事件原文：

```
mode=synthetic state=absent  startup frames=0   motion_ratio=0.0000 faces=0 gate=motion+face reason=camera_started
mode=synthetic state=present        frames=47  motion_ratio=0.1480 faces=0 gate=motion+face reason=present_confirmed
mode=synthetic state=absent         frames=181 motion_ratio=0.0000 faces=0 gate=motion+face reason=absent_confirmed
mode=synthetic state=present        frames=286 motion_ratio=0.0318 faces=0 gate=motion+face reason=present_confirmed
```

- **`frames=286 motion_ratio=0.0318 … reason=present_confirmed` 与文档引的逐字相同** ✓；`frames=181 motion_ratio=0.0000 … reason=absent_confirmed` 也相同 ✓；`0.1480` 这一组（文档写作 `0.148`）也在 ✓。
- 历史自检库（`data/perception/self-test.sqlite`）里同样的两条批次（19:28 与 19:30）各含这四行，数值一致 → **可复现、不是一次性巧合** ✓。
- 所以「t92 删掉的那组数值确实来自合成场景」这句**有实测出处**；文档也同时注明「当时那 4 行本身同样没有标记，只是现在有了可复现的出处」，口径正确 ✓。

---

## 4. §8.2「可能是」那一半：核心成立，支撑句有一处已不可核（观测 O1）

文档（第 285–287 行）把早先那句「3 条 `present_confirmed` 是合成场景留下的」订正成：那 3 行**没有** `mode=` 标记 → **无法证实**；可证的说法只是「时间戳与 `--self-test` 那批运行吻合、数值落在合成场景范围内」→ **可能是**合成场景留下的，**台账里没有标记能证明**。

- **核心判断成立** ✓：我在 t101/t107 两次都独立查过那 3 行（18:22:19 / 18:22:37 / 18:23:02），它们确实**没有** `mode=` 标记（那时字段里还没有这个标记），只有 `source=perception.laptop_camera`（真实/合成共用的默认值）→ 归因只能写「可能」，文档的措辞正确。
- **支撑句现在不可核**（O1）：那 3 行**已经不在台账里了**。我这次清点 `data/perception/field-test.sqlite` 只剩 **3 条**、时间戳 19:28:51 / 19:29:05 / 19:30:14、**全部 `mode=camera`**（即台账被清理/重跑过，符合文档自己在下一段给出的「要一条绝对干净的台账：删掉再跑一次」）。而「时间戳与 `--self-test` 那批吻合」这句本来也只是「接近」（那 3 行是 18:22–18:23，自检库当时第一批是 18:23:45），现在既宽松又无处可查。建议补半句：「（那 3 行此后已随台账清理消失，本条只作历史订正；要核现状请跑下面的复核命令）」。

---

## 5. F1（low）：§8.2 的两条复核命令在 PowerShell 里跑不起来

**位置**（本次核对时；引用请用命令，行号会漂）：`docs/design/perception.md` §8.2 的两条 `python.exe -c …` 命令
`git grep -n "collections.Counter" -- docs/design/perception.md`、`git grep -n "order by sequence" -- docs/design/perception.md`

- 两条命令都在 ```` ```powershell ```` 代码块里（第 313 行的围栏已确认是 `powershell`），而命令里各有 **2 处 `\"`**（例如 `c.execute(\"select payload_json from events …\")`）。
- **PowerShell 不用反斜杠转义引号**（AGENTS §9.8 记录过这个坑）：`\"` 里的 `"` 会**提前结束外层双引号字符串**，剩下的片段被当命令语法解析。我把文档里那条 t109 命令**逐字**写进 `.ps1` 再用 `powershell -NoProfile -File` 跑，得到：

```
File "<string>", line 1
    … for (p,) in c.execute(" select payload_json from events where event_type=presence.changed\)];print(dict(m))
SyntaxError: unterminated string literal (detected at line 1)
```

  （同一现象在另一条「时间戳 + payload」命令上也复现。）
- **影响**：读者照抄会得到 Python 报错，而不是文档承诺的「按来源统计（真实/合成各多少行）」；这也是「文档里的命令必须真能跑」（AGENTS §9.6/§2）要挡住的那类问题。
- **requiredFix（我实测可用）**：让 Python 源码里**只用单引号**，外层仍用双引号，彻底不出现 `\"`。例如把 SQL 的引号消掉、改成在循环里筛：

```
E:\worker2\.venvs\cv4\Scripts\python.exe -c "import sqlite3,json,collections;c=sqlite3.connect('data/perception/field-test.sqlite');m=collections.Counter();[m.update([next((x.split('=',1)[1] for x in (json.loads(p)['source_detail'] or '').split() if x.startswith('mode=')), 'NO-MARKER')]) for (t,p) in c.execute('select event_type,payload_json from events') if t=='presence.changed'];print(dict(m))"
```

  我把它写进文件跑通，输出正是当前台账的 **`{'camera': 3}`** ✓（同一修法也能套用到那条「时间戳 + payload」的命令上）。

---

## 6. 门禁与观测

| 命令 | 判读前状态 | 结果 |
|---|---|---|
| `npm test` | HEAD `d4fab2a`；在途是 `packages/conversation/src/{engine,index,prompt}.ts` 与 `scripts/field-test.ts`（都不是 t109 的文件） | **235 tests / 235 pass / 0 fail / 0 skipped，exit 0** |
| `npm run check:docs` | 同上 | 检查了 **74 份 markdown**；失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0；**exit 0**（收入本报告后 75 份 / 0 问题 / exit 0） |

**观测（与 F1 一起附上）**

- **O1（低，见 §4）**：「可能是」那段依赖的那 3 行已不在台账里（现台账 3 条、全 `mode=camera`），建议补一句「此后已随台账清理消失，本条只作历史订正」。
- **O2（正面）**：「确实」那一半是可以**逐字复现**的（§3 的四行原文），而且这条复现不依赖被删掉的老行——它跑在自检库/临时库上，谁都能重跑。
- **O3（正面）**：`mode=` 标记两处都写（启动记录 + 状态转换，见 `run.py` 的 `frame_mode`），我两条路径各验一次，`unmarked_events` 都是 **0**；`source_detail` 长度也在契约的 200 上限内（我实测最长 111 字符，与 t109 自述一致）。
- **O4（信息）**：当前共用台账跑那条（修好后的）统计命令得到 `{'camera': 3}`——即**现在没有无标记的行**；文档把它们写成「旧行没有标记就不能给它安来源」的规则是对的，但读者别以为台账里现在还有无标记行。

---

## 7. 我跑过的命令与原始结果（可复现）

| 命令 | 结果 |
|---|---|
| `node scripts/verify-camera-presence.ts --self-test --db %TEMP%\t110-synthetic.sqlite` | exit 0；4 条事件全 `mode=synthetic`；`source_modes={expected:"synthetic", from_events:["synthetic"], unmarked_events:0}`；四条原文见 §3（含 `frames=286 motion_ratio=0.0318`） |
| `node scripts/verify-camera-presence.ts --seconds 3 --min-fps 1 --db %TEMP%\t110-camera.sqlite` | exit 0、`problems: []`；1 条事件 `mode=camera`；`source_modes={expected:"camera", …, unmarked_events:0}` |
| `node data/rev-tmp/t110-modes.mjs`（**我自写**：`node:sqlite` 清点四个库的 `mode=`/unmarked） | 临时库 camera 1/1、临时库 synthetic 4/4、共用台账 3/3 全 camera、自检库 8/8 全 synthetic，**unmarked 都是 0**（§2、§4） |
| `powershell -NoProfile -File <文档原样命令>.ps1`（**逐字**抄 t109 那条） | Python `SyntaxError: unterminated string literal` —— F1 的复现 |
| `powershell -NoProfile -File data/rev-tmp/t110-fixedcmd.ps1`（**我改写的版本**） | `{'camera': 3}` —— F1 的可用替代 |
| `node data/rev-tmp/t110-fence.mjs`（围栏与 `\"` 计数） | 两条命令都在 ```` ```powershell ```` 块里，各含 2 处 `\"` |
| `npm test` / `npm run check:docs` | 235/235 exit 0；74 份 0 问题 exit 0 |

---

## 8. 我做过的真实外部动作

**0 次 API 调用**。按验收明文要求**真机跑了一次**（`--seconds 3 --min-fps 1 --db %TEMP%\t110-camera.sqlite`）与 **`--self-test` 跑了一次**（同样写临时库）——共用台账 `data/perception/field-test.sqlite` **一条未加**；两次都只写进我自己的临时库（`%TEMP%\t110-camera.sqlite`、`%TEMP%\t110-synthetic.sqlite`，跑完可删）。**未写任何图像文件、未上传**（`privacy.frames_written_to_disk 0`）。**未改动任何他人的文件**；唯一写入产物是本文件；探针脚本留在 `data/rev-tmp/`（`t110-modes.mjs`、`t110-fence.mjs`、`t110-fixedcmd.ps1`，`data/` 已 gitignore，非交付物）。基线修订 `d4fab2a`（工作时 HEAD；被评交付点 `bbf2476`）。
