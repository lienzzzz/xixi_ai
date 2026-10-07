# Linux 移植与环境勘测（2026-10-07）

> 最后更新：2026-10-07
> 权威来源：本文件是**本机实测原始记录**（docs/recon 层）。所有数字都来自本机命令输出。
> 环境：**Ubuntu 24.04.3 LTS on WSL2**（`Linux 5.15.153.1-microsoft-standard-WSL2`，x86_64），
> 仓库检出在 `/home/u24/projects/xixi_ai`（原来的开发机是 Windows，路径 `E:\worker2`）。
> 约束遵守情况：只用 CPU 依赖；没有引入常驻服务；除 `.venvs/`、`node_modules/`、`data/` 与文档外没有写别的地方。

**这份文件为什么存在**：仓库里所有「本机环境事实」（`AGENTS.md` §4、`docs/README.md` §0、`README.md` 的快速开始）
都是**Windows 机器**的记录，命令是 PowerShell、Python 解释器路径写死 `.venvs/<name>/Scripts/python.exe`。
换到 Linux 之后，这些路径**一条都不存在**，而**没有任何测试会因此变红**——这恰恰是最危险的地方：
`npm test` 看起来是绿的，实际上有 4 条 Python 用例被静默 skip 掉。本文件记录这次移植实际做了什么、
在代码里挖出哪些**平台假设缺陷**、以及**哪些事情在这台机器上根本验不了**。

---

## 1. 环境矩阵（实测）

| 项 | 本机实际 | 仓库原先记录的（Windows） |
|---|---|---|
| 操作系统 | Ubuntu 24.04.3 LTS / WSL2 内核 5.15.153.1 | Windows 10.0.19045 |
| Node | `v24.14.1` | `v24.21.0`（`engines.node` = `>=24.0.0`，两者都满足） |
| npm | `11.11.0` | — |
| Python | `/usr/bin/python3.12` = **3.12.3** | 用户级 Python **3.12.10** |
| 系统 Python | `python3` = 3.13.11（**不用**，与 Windows 侧的 3.14 同理：语音依赖不支持） | 系统 3.14.7（不用） |
| `.venvs/voice-pipecat` | pipecat-ai **1.12.0**、onnxruntime **1.24.4**、numpy **2.5.3**、soundfile 0.13.1、soxr 1.0.0、loguru 0.7.3、pillow 12.3.0 | pipecat-ai 1.12.0、onnxruntime 1.24.4、pillow 12.3 |
| `.venvs/cv4` | opencv-python-headless **4.14.0.94**、numpy **2.5.3**、onnxruntime **1.30.0** | 逐项相同（opencv 4.14.0.94 / numpy 2.5.3） |
| DSH（全局） | **0.2.0-rc.2**（勘测当时与仓库钉的 0.1.7-rc.2 **不匹配**，见 §4；**当晚已把仓库升到 0.2.0-rc.2 完成对齐**） | 0.1.7-rc.2 |
| 磁盘 | 920G 可用 | — |

**pipecat 版本与 Windows 侧逐字一致（1.12.0）**，这不是巧合：`pipecat-ai[silero]` 在 Linux 上同样**不拉 torch**
（只用 onnxruntime + pillow），所以两边依赖面相同。

### 1.1 建这两个 venv 的实测命令

```bash
# 系统自带 python3.12；WSL 里不要用 miniconda 的 3.13
uv venv --python /usr/bin/python3.12 --seed .venvs/cv4
.venvs/cv4/bin/python3 /tmp/get-pip.py --no-cache-dir          # Debian 的 venv 不带 pip（ensurepip 也没有）
.venvs/cv4/bin/python3 -m pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    "opencv-python-headless<5" numpy onnxruntime

uv venv --python /usr/bin/python3.12 --seed .venvs/voice-pipecat
.venvs/voice-pipecat/bin/python3 /tmp/get-pip.py --no-cache-dir
.venvs/voice-pipecat/bin/python3 -m pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
    "pipecat-ai[silero]>=1.10,<2" numpy soundfile soxr loguru
```

三条**踩过的坑**（都不是仓库的问题，是这台机器的）：

1. `npm install` 与 `uv` 都用不了默认缓存目录——`~/.npm`、`~/.cache/uv` 里有 **root 属主的文件**（`EACCES`）。
   本机**没有 sudo**（`sudo: The "no new privileges" flag is set`），所以正解是换私有缓存：
   `npm install --cache /tmp/npm-xixi-cache`、`UV_CACHE_DIR=/tmp/uv-seed`。
2. `uv pip install` 在本机**必然失败**：它把下载产物 `rename` 进缓存时拿到
   `Invalid cross-device link (os error 18)`——换 `UV_CACHE_DIR` 到 `/tmp` 或工作区、加
   `UV_LINK_MODE=copy`、`--no-cache` 都一样。**结论：本机装包用 pip，不要用 uv 的安装路径**
   （`uv venv` 本身是好的）。
3. `docopt==0.6.2`（pipecat 的传递依赖）在 **pip 的构建隔离**里构建失败（隔离环境拿不到 setuptools）。
   绕法：先把 sdist 拉下来本地出一个 wheel，再装整棵依赖树——
   `pip install --no-cache-dir <本地 docopt wheel>` 然后再装 pipecat。
   （`--no-build-isolation` 单独用**不够**，错误相同。）

---

## 2. 移植在代码里挖出的四个缺陷（全部已修）

四条都是**同一类**：代码/测试把「Windows 的形态」当成了「唯一的形态」。它们都不会在 Windows 上变红，
所以在原机器上永远发现不了。

### 2.1 `scripts/voice-turn.ts` 用「含冒号」判断绝对路径 → POSIX 绝对路径被拼到仓库根后面

```ts
// 修前（两处，`--compare` 的产物路径与 `--wav`）
const absolute = file.includes(':') || file.startsWith('.') ? file : join(REPO_ROOT, file);
```

`/tmp/xixi-….wav` 不含冒号，于是被当成相对路径 → 变成 `<repo>/tmp/xixi-….wav` → `ENOENT`。
**修法**：`isAbsolute(file) ? file : resolve(REPO_ROOT, file)`（`node:path` 的 `isAbsolute` 两个平台都对）。

症状有多误导：`tests/console/entry-after-turn.test.ts` 与 `tests/console/entry-notices.test.ts` 都红，
报的是「voice-turn.ts 要正常退出」+ 一个**看起来像临时目录没建好**的 `ENOENT`，
而真正的原因在 300 行之外的路径判定。**修完这两条立刻转绿。**

### 2.2 五个入口 + 一个测试文件把 venv 解释器写死成 `Scripts/python.exe`

`scripts/voice-turn.ts`、`scripts/serve-chat.ts`、`scripts/verify-voice-noise.ts`、`scripts/voice-bargein.ts`、
`scripts/voice-device-check.ts`、`scripts/field-test.ts`（`DEFAULT_PYTHON` / `PROBE_PYTHON` / `AUDIO_PYTHON`）
都用 `join(REPO_ROOT, '.venvs', '<name>', 'Scripts', 'python.exe')`。

在 Linux 上这个路径不存在，而 `spawn` 的报错是 `spawn /…/.venvs/voice-pipecat/Scripts/python.exe ENOENT`
——**看起来像「没装 venv」，其实 venv 就在 `bin/python3`**。

**修法**：在 `scripts/lib/harness.ts` 里加**一个**解析器（`resolvePython` / `pythonCandidates` /
`pythonCandidateHint`），候选顺序＝显式参数 → 环境变量（`XIXI_PYTHON` 等，**保持原语义**）→
存在的 venv（`Scripts/python.exe`、`bin/python3`、`bin/python`）→ PATH 上的 `python3`/`python`。
六个入口全部改成调它，**不再各写一份**。

`scripts/field-test.ts` 的 `resolvePerceptionPython` 早已支持 `bin/python3`，但**每个 venv 都先试
`Scripts/python.exe`**——每次都要为不存在的路径付一次 `existsSync`，且错误提示里给出的仍是 Windows 命令。
现已改成 `pythonCandidates(name)` 并让报错同时给出两个平台的建 venv 命令。

### 2.3 `apps/brain-dsh/src/transport.ts` 只认 Windows 的 npm 全局布局

```ts
// 修前：只试一个候选
const candidate = join(dirname(shim.trim()), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
```

npm 的全局包在 POSIX 上放在 **`<prefix>/lib/node_modules/`**（本机：`which dsh` = `/home/u24/.npm-global/bin/dsh`，
实体在 `/home/u24/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`）。少一层 `lib/`，
于是 `tests/unit/transport.test.ts` 的「a missing harness cwd is refused at construction time」红，
**`node scripts/install-dsh-profile.ts` 也直接抛** `cannot find the dsh entry point next to …`
（那是 M0 自证的第一步）。

**修法**：两个候选都试（`<shimDir>/node_modules/…` 与 `<shimDir>/../lib/node_modules/…`），
错误信息列出**试过的每一条路径**。同一份实现被 `scripts/install-dsh-profile.ts` 复用（它原来有一份
**只认 Windows** 的拷贝——这正是两边会漂移的原因），`parent` 方向的 import（`scripts/` → `apps/`）
与 `scripts/ebal-*.ts` 引用 `packages/` 同源，没有新增反向依赖。

### 2.4 两条感知用例把「T0 勘测留下的图片」当成前提（在干净检出上必红）

`tests/perception/camera-presence.test.ts` 断言 `data/` 里**至少有 4 张** T0 勘测的图片
（`data/models/*.jpg`、`data/recon/camera-frame-*.png`）。`data/` 在 `.gitignore` 里，
所以**任何干净检出都没有这些文件**，两条用例必然红：

```
AssertionError: data/ 的既有图片集看起来不对（0 个）：若确实被清理过，请更新这条下界的说明
AssertionError: data/ 里应当仍有 T0 勘测留下的图片
```

**修法（保留断言意图，去掉机器依赖）**：
* 「隐私边界」那条的本职是「跑检测不新增图片」——`added` 为空是**无条件**断言的；对基线的下界改成
  「要么 0（全新检出），要么 ≥4（原机器）」，其它数字才报错；
* 「watching 规则本身会不会响」那条改成本职优先：`newImageNames` 的正反例**无条件**断言，
  对真实 `data/` 的下界改成「**有资产时**才要求 ≥4」。

### 2.5 一条用例是**定时炸弹**（依赖墙上时间）

`tests/console/proactive-read-must-not-write.test.ts` 把用户那句话钉在 `2026-10-02 08:00`，
而话题的 `expireAt` = 「明天下午」+ `followup_window_h`（出厂 **48 小时**）。
于是**写上它的第 3 天起**，`reconcile` 会先把话题判成 `exhausted`，最后一条断言
（「刚提取出来是候选」）永远红：

```
AssertionError: 刚提取出来是候选，还没问过
+ actual   - expected
+ 'exhausted'
- 'candidate'
```

**修法**：给 `FieldServerOptions` 加 `now?: () => Date`（与 `TopicEngine` 已有的 `clock` 同一形态，
`vadOverride` / `adapterOverride` 的先例），`TopicEngine`、`readOpenThreads`、演练的 `now` 与演练后的
`reconcile` 都读它；**不传时默认 `new Date()`，生产行为一字不变**。用例传 `SPOKEN_AT + 1 小时`，
判定从此与跑测试的日期无关。

**这条纪律值得单列**（与 `AGENTS.md` §9.25 ③④ 同源，但形态是新的第三种）：
**种子数据带绝对日期 + 判定依赖 `Date.now()` = 定时炸弹**。不是「断言写得不对」，
而是「今天对、明天错」，而 CI 恰好在它变红之前都是绿的。

---

## 3. 被静默 skip 的四条用例（已重新跑起来）

`tests/unit/voice/frontend.test.ts` 把解释器写死成 Windows 路径，并用
`existsSync(PYTHON)` 决定 skip。在 Linux 上 → **4 条 Python 用例全部 skip**：

```
﹣ front-end DSP unit tests pass (python, services/voice-edge/tests) # voice-pipecat venv not present
﹣ the calibrate CLI recommends exactly the parameters the front end applies (F8)
﹣ without a calibration profile the front end falls back to the measured default cutoff
﹣ the voice-noise runner behaves correctly in offline mode (behaviour, real process)
```

**这比红更危险**：`npm test` 的末行是绿的，而「前端 DSP、校准 CLI、离线 runner」这几块**根本没被测**。
按 `AGENTS.md` §9.9 的原则（**不许靠删断言或把用例移出默认门禁换速度**），这里的方向是反过来的：
把 skip 变成真跑。

改完之后**其中一条真的红了**，而且红得有道理：F8 那条读
`data/recon/ambient-5s.wav`——又一个 gitignored 的 T0 勘测产物。
**修法**：用例自己用 Python 标准库（`wave`/`struct`/`math`/`random`，种子固定）生成 3 秒环境噪声 WAV 到临时目录
再喂给 `calibrate --wav`。被测契约是「校准 CLI 推荐的就是前端实际应用的」，需要的是**一段**环境录音，
不是那一份。

同时把 skip 条件从「文件存在」收紧成「**解释器能 `import numpy, voice_edge.frontend`**」：
解析器现在会回落到 PATH 上的 `python3`，一个缺依赖的系统解释器不能把 skip 变成 fail。

---

## 4. 这台机器上**验不了**的事（如实登记，不许写成已验）

| 项 | 为什么 | 怎么才能验 |
|---|---|---|
| **DSH 路径（M0 / `verify:provider` / `--dsh`）** | 全局 DSH 是 **0.2.0-rc.2**，而 `plugins/xixi-tools/package.json` 的 peerDependency 钉的是 **0.1.7-rc.2**。组合 profile 时 DSH 直接**跳过**这个 bundle：`Plugin dsh-xixi-tool@0.1.0 is incompatible with dsh 0.2.0-rc.2: peerDependencies {...}`，于是 `npm run install:profile` 的 `verifyBoot()` 报 `composed profile does not contain "xixi-tools"`。全局安装目录 `~/.npm-global` **归 root**，本机没有 sudo，所以换版本要用户自己来（`npm i -g @deepseek-ai/dsh@0.1.7-rc.2`，或把插件 peer 升到 0.2.0-rc.2）。 | 装与仓库一致的 DSH 版本后 `npm run install:profile` → `npm run verify:m0` |
| ↳ **已于 2026-10-07 关闭（同一晚）** | 用户指示「修复 `verify:provider`，适配当前版本」，选了**升仓库**这条路（不动全局、不开 `allow-version` 豁免）：插件 peer 与根 devDependency 一并升到 `0.2.0-rc.2`，`package-lock.json` 整份重新解析（0.2.0 把 11 个 `@deepseek-ai/dsh-*` 升格为 peer，旧 lock 会 ERESOLVE）。 | **已实测通过**：`install:profile` exit 0、`verify:provider` exit 0 且 `toolName: "xixi_get_current_time"`；同一次运行 `npm test` 720/720、`check:types` exit 0。过程与三条依赖解析岔路见 [`../progress.md`](../progress.md) §11 |
| **一切真实模型调用**（`chat` / `web` / `verify:*` / `eval:*` / `voice:turn` 真跑） | 本机**没有 `.env`**（`MIMO_API_KEY` 缺失，`.env` 在 `.gitignore` 里、不会随检出来） | 填 `.env` 后按 `README.md` 的命令跑 |
| **麦克风 / 扬声器 / 摄像头（真机采集）** | WSL2 默认不把音频与摄像头设备暴露给 Linux 侧；`sounddevice` 需要 PortAudio/ALSA 设备，`cv2.VideoCapture` 需要 `/dev/video*`。**离线自检本来就不碰硬件**，所以能跑；真采集不能。 | 在 Windows 侧跑（`npm run field-test`），或给 WSL 配 USB 设备直通 |
| **`field-test --self-test` 的两条 FAIL** | 30 项通过 / **2 项失败**，两条都是 Windows 专属读数：F7 的「输入采集增益」走 `pycaw`（Windows Core Audio），另一条同源。**这是环境缺失，不是回归**（离线自检在 Windows 上是 32/32）。 | 在 Windows 上跑同一条命令 |

**`scripts/verify-camera-presence.ts` 与 `--live` 的摄像头路径同样验不了**（没有 `/dev/video*`），
但 `tests/perception/` 的**离线**回归（Python unittest + 契约校验 + 投影语义）在本机是真跑的。

---

## 5. 移植后的门禁实测（2026-10-07，本机同一次运行）

```bash
npm run check:types     # exit 0
npm test                # ℹ tests 720 / pass 720 / fail 0 / skipped 0 / duration_ms 16116.7
npm run check:docs      # 检查了 109 份 markdown，失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0，exit 0
```

**与移植前的对比**（同一台机器、同一份检出，改动前）：

| | 移植前 | 移植后 |
|---|---|---|
| `check:types` | exit 0 | exit 0 |
| `npm test` | **715 项：pass 710 / fail 1 / skipped 4** | **720 项：pass 720 / fail 0 / skipped 0** |
| `check:docs` | 109 份，三个 0 | 109 份，三个 0 |

项数从 715 到 720 的差 = 4 条**从 skip 变真跑**的 Python 用例（§3）+ 1 条新加的
「两种 npm 全局布局都能定位 harness 入口」（§2.3）。

### 5.1 §2.3 那条新断言的红证（按 `AGENTS.md` §9.10 ⑤ 的纪律：还原用 `%TEMP%` 副本，不用 `git checkout`）

临时删掉 POSIX 候选那一行（**不改别的**）后重跑 `tests/unit/transport.test.ts`：

```
ℹ pass 4
ℹ fail 2          # 其中两条都带 code: 'TRANSPORT_FAILED'
```

按副本还原后 `sha256` 与实验前一致（`f456f04236f1d77a…`），`git diff --stat` 为 21 增 6 删。

---

## 6. 复现清单（照抄即可）

```bash
cd /home/u24/projects/xixi_ai

# 1) 依赖（缓存目录必须是私有的：~/.npm 与 ~/.cache/uv 里有 root 属主文件，本机无 sudo）
npm install --cache /tmp/npm-xixi-cache --no-audit --no-fund

# 2) 两个 Python venv（见 §1.1；uv 只用来建 venv，装包用 pip）

# 3) 三门禁
npm run check:types && npm test && npm run check:docs

# 4) 真 VAD（不花钱、不联网；需要 voice-pipecat venv）
cd services/voice-edge && /home/u24/projects/xixi_ai/.venvs/voice-pipecat/bin/python3 \
    -m voice_edge.segment /home/u24/projects/xixi_ai/tests/audio-fixtures/direct-question.wav
```

---

## 维护规则

同 [`docs/README.md`](../README.md) §5。本文的每条结论都带「命令 + 本机实测输出」；
**换机器后如果 `npm test` 的项数或 skip 数与 §5 不符，先查这里的平台假设，再改别的**。
Windows 侧的环境事实仍以 [`field-test-environment-2026-09-30.md`](field-test-environment-2026-09-30.md) 与本文件 §1 的对照表为准。
