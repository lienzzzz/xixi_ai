# V0.1 基线（改造前）：文本、语音与门禁现状

最后更新：2026-09-30

本文是 pack `xixi_v02_refactor_pack/docs/02_IMPLEMENTATION_STEPS.md` 的 **Phase 0** 产物：
在动「真人感」之前，先把 V0.1 **到底是什么样**记录下来，供后面逐项做前后对比。
**不美化、不删数据**：难看的地方（工具调用标记被当成回复、英文推理泄漏进回复、20 轮里反复
以同一句话收尾、同一天再跑就变红的两条时钟相关用例）都照实写进来——
这些正是改造要解决的或必须绕开的，删掉它们这份基线就没有价值。

**先说五个最重要的发现**（细节与原始输出见对应章节）：

1. `npm test` 在 23:22 是 **245/245 绿**，但 **23:43 再跑就是 243/245**——两条控制台用例依赖
   墙上时钟（静默时段 23:30–07:30），与代码无关。见 §1.3（这条会直接影响「npm test 全绿」的验收）。
2. 文本一侧：**提问率 50%（10 轮）/ 52.6%（20 轮）**、**9/19 轮用满 3 段**、
   最大回复 177 字（硬上限 = 3 段 × 60 字 = 180），客套词表命中 0，但有可复现的**同一句收尾模板**。见 §2.4。
3. 语音一侧：**首个可听总延迟 P50 6816 ms / P90 10952 ms**（n=16），其中
   **③「首 token → 首个音频」是上界**——V0.1 的 TTS 是非流式的。见 §3.1/§3.2。
4. 语音路径有两个既存缺陷：天气轮的回复正文就是 `<tool_call>` 标记（会被念出来，7/8 轮），
   以及一轮把**英文思维链**当回复说了出来。见 §4。
5. 语音的四个延迟全部来自夹具音频；**真实麦克风链路本轮未测**（本机麦克风自噪：播放窗只比静音窗高
   5.16 dB < 10 dB 判据）。见 §3.4。

- 基线修订号：`git rev-parse HEAD` = **882f745**（工作区干净，只有 pack 目录未跟踪）
- 采集日期：2026-09-30 23:2x–23:5x（本机时间，UTC+08:00）
- 机器：Windows 10.0.19045 / Intel i7-7700HQ / Node v24.21.0 / 语音 venv Python 3.12.10
- 模型：`mimo-v2.6-flash`（直连 `https://api.xiaomimimo.com/v1/chat/completions`）
- 密钥来源：仓库根的 `.env`（**不在本文与时序里出现任何密钥值**）

## 0. 怎么读这份文档

- 每个数字都标 **【实测】** 或 **【未测】**；**实测**必须能由本节给出的命令重跑出来。
- 「能重跑」优先于「有记录」：所有原始输出都落在 `docs/benchmarks/v01/` 下（随仓库提交），
  重跑命令读的就是这些文件；需要真实调用（花钱）的命令单独标注。
- 一次性产物（对话原文、语音 JSON）在 Git 忽略的 data/benchmarks/v01/ 下也留了一份，
  但它们换机器即失；**引用时请引用 `docs/benchmarks/v01/` 里的副本**。
- 本文所有语音数字都来自**夹具音频**，不是真实麦克风；真实麦克风路径**未测**，原因见 §3.4。

### 原始输出清单

| 文件 | 内容 |
|---|---|
| `docs/benchmarks/v01/raw-npm-test-tail.txt` | `npm test` 末 14 行（含 ℹ 汇总） |
| `docs/benchmarks/v01/raw-npm-test-quiet-hours.txt` | 23:43 同一天再跑的 243/245 红灯原文（§1.3） |
| `docs/benchmarks/v01/raw-npm-test-under-utc.txt` | `TZ=UTC` 下全量 244/245（唯一失败是 `+08:00` 用例，§1.3） |
| `docs/benchmarks/v01/raw-test-console-under-utc.txt` | `TZ=UTC` 下 console 测试 66/66 绿（诊断，§1.3） |
| `docs/benchmarks/v01/raw-worldstate-ttl-under-utc.txt` | `TZ=UTC` 下世界状态 TTL 用例因 `+08:00` 字面量失败（§1.3） |
| `docs/benchmarks/v01/raw-check-docs.txt` | `npm run check:docs` 全文 |
| `docs/benchmarks/v01/raw-chat-fake-10turns.txt` | 离线替身 10 轮原文 |
| `docs/benchmarks/v01/raw-chat-real-10turns.txt` | 真实（MiMo）10 轮原文 |
| `docs/benchmarks/v01/raw-chat-real-20turns.txt` | 真实（MiMo）20 轮原文 |
| `docs/benchmarks/v01/raw-text-metrics-fake-10turns.txt` | 离线 10 轮指标输出 |
| `docs/benchmarks/v01/raw-text-metrics-real-10turns.txt` | 真实 10 轮指标输出 |
| `docs/benchmarks/v01/raw-text-metrics-real-20turns.txt` | 真实 20 轮指标输出 |
| `docs/benchmarks/v01/input-chat-10turns.txt` | 10 轮文本基线的 10 行用户输入（逐行一轮） |
| `docs/benchmarks/v01/input-chat-20turns.txt` | 20 轮文本基线的 20 行用户输入 |
| `docs/benchmarks/v01/expected-fixture-texts.json` | 5 条音频夹具里说的那句话（抄自夹具生成器），供 ASR 相似度复算 |
| `docs/benchmarks/v01/raw-voice-turn-single.txt` | 单轮语音闭环原始 JSON（首字/ASR/TTS 分段耗时） |
| `docs/benchmarks/v01/raw-voice-batchA.txt` ～ `raw-voice-batchD.txt` | 4 批 × 5 夹具的真实语音闭环原始 JSON |
| `docs/benchmarks/v01/raw-voice-metrics-4batches.txt` | 上面 4 批的 P50/P90 汇总输出 |
| `docs/benchmarks/v01/raw-vad-only.json` | 只跑 VAD（不花钱）的端点延迟与耗时 |

## 1. 测试基线【实测】

### 1.1 `npm test`

```powershell
npm test
```

实测（2026-09-30 23:22 左右，一次运行；下面是 `npm test` 的末 14 行原文，
`EXIT` 与 `WALL_SECONDS` 是外层包装脚本对同一次运行记的）：

```text
ℹ tests 245
ℹ suites 0
ℹ pass 245
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19870.3004
EXIT=0
WALL_SECONDS=20.66
```

- **项数：245**（`tests 245`，`pass 245`，`fail 0`）
- **测试框架自报耗时：19870.3 ms**；**进程外实测墙钟：20.66 s**
- **exit：0**
- 末 14 行原文见 `docs/benchmarks/v01/raw-npm-test-tail.txt`；整份日志按 AGENTS.md §9 的
  「提交信息里的实测值必须来自同一次运行」要求保留在 `$env:TEMP/xixi-npm-test-baseline.txt`
  （临时文件，不进仓库；需要完整日志请用上面的命令重跑）。

### 1.2 `npm run check:docs`

```powershell
npm run check:docs
```

实测输出（全文见 `docs/benchmarks/v01/raw-check-docs.txt`）：

```text
检查了 81 份 markdown
  失效链接 0｜不存在的文件引用 0｜缺少新鲜度标记 0

check:docs OK：链接、文件引用与新鲜度标记都一致
EXIT=0
```

- **81 份 markdown、0 问题、exit 0**。新增本文后这个数字会 +1，属正常漂移。

### 1.3 ⚠️ 同一天再跑就红了：两个**与墙上时钟有关**的既存测试（重要）

**事实**：§1.1 的 245/245 是在 **23:22（本地 +08:00）** 跑的；同一天 **23:43** 再跑同一份代码
（`git diff HEAD` 为空，工作区只有本文与两个新脚本），得到 **243 pass / 2 fail / exit 1**：

```text
ℹ tests 245
ℹ pass 243
ℹ fail 2
✖ the console serves the proactive card, its state, and obeys the switch over HTTP
    AssertionError: + actual 'QUIET_HOURS'  - expected 'PASSED'   （tests/console/proactive-console.test.ts:334）
✖ the trial page shows segments in order, labels the source, and carries the same knobs
    AssertionError: + actual 'QUIET_HOURS'  - expected 'PASSED'   （tests/console/proactive-console.test.ts:411）
EXIT=1
```

原文见 `docs/benchmarks/v01/raw-npm-test-quiet-hours.txt`。**机制已定位**：这两用例走现场测试
控制台的真实时段判定，而出厂配置的硬门禁 `quiet_hours` 是 **23:30–07:30**
（`config/xixi.example.yaml`，本机没有私有的 config/xixi.yaml），断言却假定门禁会 `PASSED`。
23:22 在窗口外 → 绿；23:43 在窗口内 → 红。**与代码无关，是测试对墙上时钟的隐含依赖。**

诊断实验（**不是修复方案**）：`$env:TZ='UTC'` 让 Node 本地时间变成 15:44（在静默窗口外）后：

```powershell
$env:TZ='UTC'; npm run test:console
# ℹ tests 66 / pass 66 / fail 0 / EXIT=0   （原文 docs/benchmarks/v01/raw-test-console-under-utc.txt）
$env:TZ='UTC'; node --test tests/perception/world-state-projection.test.ts
# EXIT=1：'staleAfter = updated_at + ttl' 期望 '2026-09-30T10:01:00.000+08:00'，
#         实际 '2026-09-30T02:01:00.000+00:00'
#（原文 docs/benchmarks/v01/raw-worldstate-ttl-under-utc.txt）
```

即这套测试有**两个互相独立的时钟假设**：控制台用例假设「现在不在 23:30–07:30 之间」，
世界状态用例假设「本机时区是 +08:00」（它把 `+08:00` 字面量钉在断言里）。
所以 `TZ=UTC` 只能证明前者的成因，不能当绕行手段。

顺带一个有用的结论：`TZ=UTC` 下**全量**跑是 **244/245**（唯一失败就是那条 `+08:00` 用例，
原文 `docs/benchmarks/v01/raw-npm-test-under-utc.txt`），说明本文新增的两个基准脚本
没有影响任何既有测试。

**对改造与验收的直接影响**（写给 t4/t5）：

- 「`npm test` 全绿」这条完成标准**在本地时间 23:30–07:30 之间不可达**，除非先修这两处
  测试或把门禁参数注入进去；在窗口外跑则与 §1.1 一致（245/245）。
- 判读红灯第一步仍然是看 `git diff HEAD` 是否为空、以及失败用例名是否为上面两个；
  若失败原因码是 `QUIET_HOURS`，**先看表**，不要当成「本团队引入的回归」。
- 本次基线**不做**这两处测试的修改（不在 P0 范围内）；这是 V0.1 的既存事实，如实记录。

## 2. 文本对话基线

### 2.1 真实 10 轮（MiMo，真实调用，花钱）【实测】

```powershell
# 真实调用：走 .env 里的 MIMO_API_KEY（会话写到独立 data 目录，避免污染日常会话）
$env:XIXI_CHAT_DATA_DIR = "$PWD\data\benchmarks\v01\real-store"
cmd /c "node scripts\chat.ts < docs\benchmarks\v01\input-chat-10turns.txt > data\benchmarks\v01\chat-real-raw.txt 2>&1"
```

输入就是 `docs/benchmarks/v01/input-chat-10turns.txt` 的 10 行（每行一轮）：

```text
西西，在吗？
今天下午我想去镇上办点事，顺便看看老李家。
明天天气怎么样？
你说，人老了是不是就爱回忆从前？
我记得你说过会记住我说的事，那你还记得我爱吃什么吗？
有点累了，不太想说话。
算了还是说说吧，你觉得我该养只猫吗？
你今天心情怎么样？
帮我记住，下周三要去医院复查。
好，那我先睡了，晚安。
```

实测：**exit 0，墙钟 46.53 s**，会话 `sess_1acddcdb-ef28-48bd-b6cf-1418337232ba`。
适配器自报 `mimo-direct / mimo-v2.6-flash / mode=live`。原文（完整复制自
`docs/benchmarks/v01/raw-chat-real-10turns.txt`）：

```text
西西（mimo-direct / mimo-v2.6-flash）已就绪。
会话 sess_1acddcdb-ef28-48bd-b6cf-1418337232ba，已有 0 轮；人格 {"curiosity":0.4,"emotional_expressiveness":0.45,"formality":0.15,"humor":0.3,"playfulness":0.2,"proactivity":0.85,"talkativeness":0.75,"verbosity":0.7,"warmth":0.8}
跟进窗口 36000ms（由人格 silence_tolerance=0.7 缩放）；IDLE 时直接说话即为叫醒，会话开了就按继续处理。输入 /exit 结束。


西西：在的在的，这么晚还没睡呀？都快十一点半了，有啥事就说，我听着呢。
[SPEAK 3450ms 首字2358ms state=LINGERING linger=36000ms 人格=0.7]


西西：明天就是国庆了，镇上估计人多，早点去好些。老李家最近咋样了？你跟他们也有阵子没见了吧，顺便瞅瞅也挺好，回来跟我说说。
[SPEAK 4856ms 首字3053ms state=LINGERING linger=36000ms 人格=0.7]

[tool] xixi_get_weather ok

西西【第 1/2 段】：明天成都这边阴天，19到24度，不冷不热的，挺舒服。基本不会下雨，出门办事不用带伞。
（停 450ms 再说下一段…）
西西【第 2/2 段】：你要是下午去镇上，这个天气正好，逛老李家也方便。
[SPEAK 13851ms 首字12027ms state=LINGERING linger=36000ms 人格=0.7 分2段/间隔450ms]


西西【第 1/2 段】：嗯，我觉得是这样。人上了年纪，经历的事都成了一笔一笔的账，闲下来就爱翻出来看看，想想年轻时候的人和事，心里踏实。
（停 450ms 再说下一段…）
西西【第 2/2 段】：你今晚是不是想起什么来了？说来听听，我也好奇你以前的日子。
[SPEAK 4901ms 首字2296ms state=LINGERING linger=36000ms 人格=0.7 分2段/间隔450ms]


西西：这个我得说实话，你之前没跟我提过爱吃什么，我记不得了。你告诉我呗，我这回肯定记牢，下次你来镇上我都能提醒你捎点回来。
[SPEAK 3192ms 首字1763ms state=LINGERING linger=36000ms 人格=0.7]


西西：那就不说，歇着。快十一点半了，早点睡，明天下午还要跑镇上呢。
[SPEAK 3323ms 首字2512ms state=LINGERING linger=36000ms 人格=0.7]


西西【第 1/2 段】：养猫挺好的，猫不像狗那么黏人，你累了它就自己找个角落趴着，不吵你。家里有只猫，开门回家有个动静，屋子也显得有点活气。
（停 450ms 再说下一段…）
西西【第 2/2 段】：不过要真养，我建议你领养一只，别挑太小的奶猫，头几个月晚上得操心。你要是怕孤单又嫌狗闹，猫真是个合适的选择。
[SPEAK 4190ms 首字737ms state=LINGERING linger=36000ms 人格=0.7 分2段/间隔450ms]


西西【第 1/3 段】：我挺好的，看你大半夜不睡觉跟我聊猫，心情还不错。
（停 450ms 再说下一段…）
西西【第 2/3 段】：倒是你，本来都说累了，一聊起来又精神了——是不是猫这事在你心里转了一阵子了？
（停 450ms 再说下一段…）
西西【第 3/3 段】：要真想养，明天去镇上可以先去领养的地方看看，不带回来也无妨。
[SPEAK 4030ms 首字633ms state=LINGERING linger=36000ms 人格=0.7 分3段/间隔450ms]


西西：记下了，下周三去医院复查。要我到时候提醒你吗？顺便问一句，是上午还是下午？有些复查得空腹，前一晚就得准备。
[SPEAK 2369ms 首字1138ms state=LINGERING linger=36000ms 人格=0.7]


西西：晚安，睡个好觉。下周三复查的事我记着，上午还是下午你明天想起来了告诉我一声就行。
[SPEAK 1841ms 首字1268ms state=LINGERING linger=36000ms 人格=0.7]
```

### 2.2 真实 20 轮（MiMo，真实调用，花钱）【实测】

团队完成标准里有「20 轮连续对话不复述上文」，所以额外录了一份同长度的 20 轮基线，
让 t4 的 20 轮验收有同口径的对比物（输入是 `docs/benchmarks/v01/input-chat-20turns.txt`，
全文 20 行；前 10 行与 §2.1 相同，后 10 行加了血压/随礼/膝盖这些连续话题与一次回忆确认）：

```powershell
$env:XIXI_CHAT_DATA_DIR = "$PWD\data\benchmarks\v01\real20-store"
cmd /c "node scripts\chat.ts < docs\benchmarks\v01\input-chat-20turns.txt > data\benchmarks\v01\chat-real20-raw.txt 2>&1"
```

实测：**exit 0，墙钟 159.87 s**，会话 `sess_8d13817d-9dd2-4e84-90c9-70986a08d791`，20 轮里
**19 轮开口、1 轮沉默**（第 7 轮「有点累了，不太想说话。」→ `SILENCE`）。
全文见 `docs/benchmarks/v01/raw-chat-real-20turns.txt`，节选三段（分别对应第 12、17、19 轮；
每段前是**用户说了什么**）：

```text
[第 12 轮] 用户：我最近血压有点高，吃的方面要注意些什么？
西西【第 1/3 段】：血压高这事，吃的方面最要紧的就是少盐，咸菜、腊味、酱料这些都得收着点，外卖和加工食品里的隐形盐也多。
（停 450ms 再说下一段…）
西西【第 2/3 段】：另外浓茶咖啡别喝太猛，酒也少来，晚上要是睡不好血压也容易往上窜。
…
[SPEAK 11086ms 首字5435ms … 分3段/间隔450ms]

[第 17 轮] 用户：你还记得我刚说我年轻时候干啥的吗？
西西：记得呀，你年轻时在厂里干过钳工，手艺活儿。怎么了，想再唠唠那时候的事？
[SPEAK 6895ms 首字5848ms state=LINGERING linger=36000ms 人格=0.7]

[第 19 轮] 用户：有什么办法能缓解一下吗？
西西【第 3/3 段】：要是这些法子都不管用，或者膝盖肿了、走路打软，那还是得去看大夫，别拖着。好了，量完血压就睡吧，都快十二点了。
[SPEAK 11727ms 首字6407ms … 分3段/间隔450ms]
```

（第 17 轮「你还记得我刚说我年轻时候干啥的吗？」→ 正确答出「厂里干过钳工」，
说明**当前提示词确实把历史带进去了**；改造提示词时这一点不能丢。）

### 2.3 离线替身 10 轮（不花钱）【实测】

```powershell
$env:XIXI_CHAT_DATA_DIR = "$PWD\data\benchmarks\v01\fake-store"
cmd /c "node scripts\chat.ts --fake < docs\benchmarks\v01\input-chat-10turns.txt > data\benchmarks\v01\chat-fake-raw.txt 2>&1"
```

实测：exit 0，墙钟 **0.48 s**。原文见 `docs/benchmarks/v01/raw-chat-fake-10turns.txt`。

**必须说清楚**：`--fake` 用的是 `FakeBrainAdapter`，它对每一句的回复就是
`模拟回复：<用户原话>`（`packages/brain-adapter/src/fake.ts` 的 `DEFAULT_REPLY`）。
它**不是对话行为的基线**，只证明「管线能跑、分段能跑、日志能落库」。
上表里它 60% 的提问率是回声造成的假象，不要引用。真正能当行为基线用的是 §2.1/§2.2。

### 2.4 指标【实测】

工具（本次新增，供 P0/P1 前后同口径对比）：

```powershell
node scripts/benchmarks/v01-text-metrics.ts docs/benchmarks/v01/raw-chat-real-10turns.txt
node scripts/benchmarks/v01-text-metrics.ts docs/benchmarks/v01/raw-chat-real-20turns.txt
# 加 --json 得到结构化结果（含逐轮回复原文与逐轮字符/段数）：
node scripts/benchmarks/v01-text-metrics.ts docs/benchmarks/v01/raw-chat-real-20turns.txt --json
```

实测输出（`docs/benchmarks/v01/raw-text-metrics-real-20turns.txt`）：

```text
轮数：20（开口 19，沉默 1）
每轮字符数：45 / 69 / 101 / 96 / 101 / 87 / 108 / 93 / 91 / 117 / 156 / 177 / 95 / 107 / 107 / 35 / 118 / 137 / 37（P50 101，均值 98.8，最大 177）
每轮段数：1 / 2 / 2 / 2 / 2 / 2 / 3 / 3 / 2 / 3 / 3 / 3 / 2 / 3 / 3 / 1 / 3 / 3 / 1（{"1段":3,"2段":7,"3段":9}）
含问号的轮数：10/19（开口轮）= 52.6%
客套模板命中：无
跨轮重复句子（>=6 字）：无
与上一轮回复的最长公共子串（字，逐轮）：- / 2 / 3 / 10 / 2 / 3 / 0 / 0 / 3 / 2 / 6 / 4 / 6 / 2 / 2 / 6 / 2 / 1 / 3 / 2
与上一轮回复最长公共子串 >=8 字的轮：第4轮（10字）
跨轮重复短语（6 字窗口，出现在 >=3 轮）：「了，量完血压」@12,16,19
```

汇总对照表（全部【实测】）：

| 指标 | 真实 10 轮 | 真实 20 轮 | 离线替身 10 轮 |
|---|---:|---:|---:|
| 轮数（开口/沉默） | 10（10/0） | 20（19/1） | 10（10/0） |
| 每轮字符数 P50 | 58 | 101 | 18 |
| 每轮字符数 最大 | 112 | 177 | 31 |
| 段数分布 | 1段×6、2段×3、3段×1 | 1段×3、2段×7、3段×9 | 1段×10 |
| 提问率（含「？」的开口轮） | 5/10 = 50.0% | 10/19 = 52.6% | 6/10 = 60.0%（回声假象） |
| 客套模板命中（听起来/看起来/我理解/首先/总之…10 条） | 0 | 0 | 0 |
| 跨轮重复句子（≥6 字，逐字相同） | 0 | 0 | 0 |
| 与上一轮回复公共子串 ≥8 字的轮 | 0 | 1（第 4 轮，10 字） | 0 |

**指标口径与已知局限（写在前面，免得后来者误读）**：
- 这两个脚本是**一次性基线仪器**（P1 的正式指标工具应另起一套并自带单元测试）。它们的数字
  本次都**对着 20 轮原文人工核过**：沉默轮 1 个、3 段轮 9 个、第 4 轮公共子串 10 字、
  第 12/16/19 轮的收尾短语——脚本输出与人工计数一致。
- 「提问率」按**含「？」的开口轮**算；沉默轮不进分母（否则沉默多的一侧会被算成「提问率低」）。
- 逐字比对抓不到**换句话说的复述**。20 轮里第 12/16/19 轮都出现了
  「（差不多该）量完血压就睡了」这类**同一句收尾的变体**（6 字窗「了，量完血压」出现在 3 轮），
  人工看还更多（第 13 轮「量完这回就放下胳膊睡觉去」、第 18 轮「量完赶紧躺下」）——
  **这是 V0.1 真实的模板化痕迹，靠逐字比对漏掉，靠 6 字窗口抓到一部分**。
- 第 4 轮与上一轮公共子串 10 字：第 3、4 轮都在报「19到24度」的天气，属**内容复述**，不是逐字复读。
- 「客套模板命中 0」只说明那 10 条词表没出现，**不等于没有客服感**：
  20 轮里 9/19 轮用满 3 段、14/19 轮在 100 字上下且结构（先答→再补→再叮嘱/反问）高度一致，
  这正是「像客服」的形态学证据，而它**不是**词表能抓的东西。

### 2.5 长度上限的现状（改造要动的那条硬上限）【实测】

`config/xixi.example.yaml`（构造函数按 scripts/lib/harness.ts 的 `configPath()` 规则优先读私有的
config/xixi.yaml；本机没有那份私有文件，所以生效的就是示例文件）：

```yaml
reply:
  max_segments: 3                # 硬上限 3
  segment_max_chars: 60          # 硬上限 60（汉字）
  gap_ms: 450                    # 段间停顿，允许范围 [250, 1200]
```

```powershell
node -e "const y=require('fs').readFileSync('config/xixi.example.yaml','utf8');console.log(y.split(/\r?\n/).filter((l,i,a)=>l.includes('reply:')||/max_segments|segment_max_chars|gap_ms/.test(l)).join('\n'))"
```

即：**一轮最多 3 段 × 60 字 = 180 字**。实测 20 轮的最大值 177 字、9/19 轮恰好 3 段 ——
上限不是「没碰到」，而是**经常贴着上限把话说满**；再加上每段必须成句、段间固定 450 ms，
于是「每轮 2–3 段、长度稳定、结构可预测」就成了 V0.1 的默认形态。

## 3. 语音延迟基线

### 3.1 测法与口径（先读这段，否则四个数字会被误读）

命令（真实调用：ASR + LLM + TTS 都花钱）：

```powershell
node scripts\voice-turn.ts --wav tests/audio-fixtures/direct-question.wav
```

脚本按《方案》§46.4 逐段记录（`scripts/voice-turn.ts` 的 `timings`）。四个延迟在 **V0.1** 的对应关系：

| 本文的四个延迟 | V0.1 字段 | V0.1 语义警告 |
|---|---|---|
| ① VAD end → ASR final | `timings.asrMs` | VAD 的端点保持（`speech.endpointDelayMs`）发生在「VAD 宣告结束」**之前**，单列，不折进① |
| ② ASR final → 首个模型 token | `timings.llmFirstChunkMs` | 含引擎组装与首个流式 chunk 的时间 |
| ③ 首 token → 首个音频 | `timings.ttsMs` | **V0.1 是非流式 TTS**：整段回复生成完才开始合成，所以这是**上界**，不是「首个音频」的真值 |
| ④ 首个可听总延迟 | `timings.e2eToFirstReplyAudioMs` | = `endpointDelayMs + asrMs + llmFirstChunkMs + ttsMs`（脚本 `note` 字段已声明含端点延迟） |

③ 的口径问题是 pack Phase 8（流式 TTS + ClauseChunker）要改掉的**结构性**问题，
不是调参能解决的：本次样本里首字最小 1150 ms 的那一轮，TTS 是 5567 ms；
而 TTS 最大 10771 ms 的那一轮（英文推理泄漏，见 §4），首字只有 3545 ms。
逐轮值见 `docs/benchmarks/v01/raw-voice-metrics-4batches.txt`。

### 3.2 真实语音闭环 × 4 批 × 5 夹具（n = 20 轮，其中 16 轮有音频输出）【实测】

```powershell
node scripts\voice-turn.ts `
  --wav tests/audio-fixtures/direct-question.wav `
  --wav tests/audio-fixtures/followup-turn.wav `
  --wav tests/audio-fixtures/longer-turn.wav `
  --wav tests/audio-fixtures/tv-dialogue.wav `
  --wav tests/audio-fixtures/backchannel.wav
# 连跑 4 遍，输出分别存为 docs/benchmarks/v01/raw-voice-batchA|B|C|D.txt（真实调用，会花钱）
# --expect 是夹具原文对照表，用来复算 ASR 相似度
node scripts\benchmarks\v01-voice-metrics.ts `
  docs/benchmarks/v01/raw-voice-batchA.txt docs/benchmarks/v01/raw-voice-batchB.txt `
  docs/benchmarks/v01/raw-voice-batchC.txt docs/benchmarks/v01/raw-voice-batchD.txt `
  --expect docs/benchmarks/v01/expected-fixture-texts.json
```

实测（`docs/benchmarks/v01/raw-voice-metrics-4batches.txt` 的同一份数字；**n 小，P90 是线性插值，
只能当同口径对比物，不要当 SLA**）：

| 指标 | n | P50 | P90 | 最小 | 最大 |
|---|---:|---:|---:|---:|---:|
| ① VAD end → ASR final（`asrMs`） | 16 | **569 ms** | **695 ms** | 314 ms | 755 ms |
| ② ASR final → 首 token（`llmFirstChunkMs`） | 16 | **2629 ms** | **4892 ms** | 1150 ms | 11190 ms |
| ③ 首 token → 首个音频（`ttsMs`，非流式，上界） | 16 | **2285.5 ms** | **4791.5 ms** | 1002 ms | 10771 ms |
| ④ 首个可听总延迟（`e2eToFirstReplyAudioMs`） | 16 | **6816 ms** | **10952 ms** | 3612 ms | 15484 ms |
| 参考：VAD 端点保持（`speech.endpointDelayMs`） | 16 | 512 ms | 600 ms | 480 ms | 600 ms |
| 参考：VAD 逐帧耗时（`vadProcessMs`） | 16 | 91.7 ms | 154.6 ms | 51.6 ms | 216 ms |
| 参考：整轮回复生成（`llmTotalMs`） | 16 | 3293.5 ms | 7158.5 ms | 1531 ms | 11485 ms |

20 轮里另 4 轮是 **`SILENCE`（backchannel.wav「嗯。」4/4 次 VAD 都没有检出语音段）**，
没有 TTS 也就没有③④，已在统计里记为「未测」而不是 0。
逐轮明细见原始文件；两个极端例子：

```text
followup-turn.wav | action=SPEAK | endpoint=512ms | asr=349ms  | ttft=11190ms | tts=1002ms  | e2e=13053ms
longer-turn.wav   | action=SPEAK | endpoint=512ms | asr=656ms  | ttft=3545ms  | tts=10771ms | e2e=15484ms
```

**与既有文档的差异（如实记录）**：`docs/design/voice.md` §5 记的是
「ASR 0.34–0.73 s、LLM 首字 1.7–2.3 s、TTS 1.0–2.0 s、端到端首条回复音频 3.6–5.5 s」。
本次同口径实测的 ① 与 ASR 区间一致、②③ 上限更高、④ P50 6.8 s / P90 11.0 s **超出**旧的
3.6–5.5 s。差异来源（本次原始数据内可见）：本次 20 轮里多数轮次回复更长（2–3 段，
`llmTotalMs` 最大 11.5 s），且非流式 TTS 要等整段文本（`ttsMs` 最大 10.8 s）；
并非脚本或口径改动。**改造后的对比请与本节数字比，不要与旧文档比。**

ASR 转写（4 批完全一致，说明 ASR 侧稳定，抖动都在 LLM/TTS）：

| 夹具 | 夹具原文 | 4/4 次转写 | 字符相似度 |
|---|---|---|---:|
| direct-question | 西西，明天天气怎么样？ | 明天天气怎么样？ | 0.778 |
| followup-turn | 对了，还有个事想问你。 | 有个事想问你。 | 0.667 |
| longer-turn | 我明天下午去镇上办点事，可能要到晚上才回来。 | 今天下午去镇上办点事，可能要到晚上才回来。 | 0.900 |
| tv-dialogue | 明天天气怎么样？ | 今天天气怎么样？ | 0.857 |

（相似度用仓库共享实现 `scripts/lib/similarity.ts` 的 `characterSimilarity`，由
`scripts/benchmarks/v01-voice-metrics.ts --expect docs/benchmarks/v01/expected-fixture-texts.json`
逐条复算；低分来自被称为「西西」的呼语与「对了/还」这类口语虚词被吃掉，不是识别错误。）

### 3.3 只跑 VAD（不花钱，可重复）【实测】

```powershell
cd services\voice-edge
E:\worker2\.venvs\voice-pipecat\Scripts\python.exe -m voice_edge.segment ..\..\tests\audio-fixtures\direct-question.wav
```

实测（5 条夹具汇总，原文 `docs/benchmarks/v01/raw-vad-only.json`）：

| 夹具 | 语音段数 | `endpointDelayMs` | `processMs` | `loadMs` |
|---|---:|---:|---:|---:|
| direct-question | 1 | 600.0 | 68.2 | 279.2 |
| followup-turn | 1 | 512.0 | 118.0 | 333.5 |
| longer-turn | 1 | 512.0 | 154.2 | 201.5 |
| tv-dialogue | 1 | 480.0 | 55.6 | 217.8 |
| backchannel | 0 | 未测 | 48.7 | 317.3 |

两点如实说明：① 端点延迟与语音内容有关（480–600 ms），4 批真实运行里同一条夹具的端点延迟
**完全一致**；② 每轮还要付一次 Python 解释器冷启动（当前是「一段音频一个一次性进程」，
见 `docs/design/voice.md` §5），`loadMs` 200–334 ms 是冷启动成本的一部分。

### 3.4 未测 / 测不了的部分（本机条件限制，如实说明）

| 项目 | 状态 | 原因与依据 |
|---|---|---|
| 真实麦克风→扬声器闭环下的四个延迟 | **【未测】** | 本机麦克风自噪偏高：2026-09-30 现场实测噪声底 −42.26 dBFS（勘测实测 −30.86 dBFS），播放窗比静音窗只高 **5.16 dB**（判据要求 ≥10 dB），失败原因是「本机麦克风自噪」，不是扬声器。见 `docs/recon/field-test-report-2026-09-30.md` |
| 扬声器真正静音的打断延迟（§33 P50 < 500 ms） | **【未测】** | 只能设备测试；离线只能测判定层。见 `docs/design/voice.md` §4/§6 |
| 噪声条件下的端到端延迟 | **【未测】（本轮）** | 本轮只跑干净夹具。噪声档的端点延迟恶化数字是**既有实测**（6 dB SNR 档 1056/1376/1472/1088 ms、0 dB 档 followup-turn 无 VAD 事件），出处 `docs/design/voice.md` §6，本次未复测 |
| 常驻语音服务的延迟（无 Python 冷启动） | **【未测】** | 尚未实现 |

**结论**：本节的四个延迟是「夹具音频进、真实 ASR/LLM/TTS 出」的数字，
**不含真实麦克风拾音链路**。真实麦克风一旦上机，④ 还要加上拾音灵敏度与自噪带来的影响，
**不能假设仍是 6.8 s**。

## 4. 语音/文本路径上已经存在的缺陷（V0.1 原样记录）

这两条是本次采集**顺手抓到的真实缺陷**，不属于 P0/P1 的改造范围，但后面做前后对比时
必须知道它们已经在基线里，否则改造后被当成「新引入的问题」：

1. **工具调用标记被当成回复正文（会被 TTS 念出来）**：`scripts/voice-turn.ts` 构造
   `MimoBrainAdapter` 时**没有传 tools**，于是模型在回复正文里输出
   `<tool_call><function=get_weather>…</function></tool_call>`。4 批共 8 个「天气」轮里
   **7 轮**命中（唯一例外是 batch A 的 direct-question，它回了一句「还没查到，等我这边结果出来
   再跟你说哈」）。原文见 `docs/benchmarks/v01/raw-voice-batchA.txt` 等。
   文本路径没有这个问题（`scripts/chat.ts` 传了 `defaultTools`，所以 `[tool] xixi_get_weather ok`
   是真正的工具调用，见 §2.1）。
2. **英文推理（思维链）泄漏成回复**：`raw-voice-batchB.txt` 的 longer-turn 轮，回复正文是
   一段英文自我推理，末尾才接中文台词：

   ```text
   The user is repeating their earlier message about going to town this afternoon and not being back until evening. But it's currently 23:30 at night - late night. … I should respond naturally as a family member would - maybe noting it's already late and asking if they got back okay.都这么晚了，还没到家？到家了就早点歇着。
   ```

   这不仅毁真人感，也踩了「不存模型私有推理」的意图（这里更糟：**直接念出来**）。
   该轮 `ttft=3545ms`、`tts=10771ms`（长文本导致 TTS 变慢，正是③上界被拉高的原因之一）。

## 5. 铁律相关的基线（改造不得削弱）

这三条在 V0.1 由**程序**判定，基线里用「现成的自动化断言」钉住；
P1 改提示词与长度策略时，以下命令必须仍然绿（本次实测全绿，见 §1；
**注意 §1.3 的时钟窗口**：23:30–07:30 之间跑会看到两条与铁律无关的红灯，先按表判读）：

| 铁律 | V0.1 的判定位置（程序，非模型） | 基线取证 |
|---|---|---|
| 硬门禁由程序判定、LLM 不能绕过 | `packages/conversation/src/proactive.ts` 的主动门禁（静默时段/冷却/额度/重复话题/对话冲突/阈值） | `npm test`（`tests/unit/core/proactive-gates.test.ts` 等），245/245 pass |
| 隐私路径不变：默认不留原始音频 | 配置 `memory.raw_audio_retention_days: 0`；只上传 VAD 检出的语音段 | `npm test`（「the shipped config means "keep no raw audio at all" (§20.1)」等用例） |
| 不许编造可核查事实仍要拦住 | 数字/预报类伪造检测 + 工具结果回填（`packages/conversation` 的伪造拦截面） | `npm test`（「a fabricated number never reaches the audio, the log or the caller」等用例） |

补充事实：`npm run check:docs`（81 份、exit 0）与 `npm test`（245、exit 0，窗口外）
是本次基线**唯一**的「全绿」声明来源；本节不引用任何未跑过的命令。

## 6. 复现/对比时怎么用这份基线

1. 改造前先固定修订号：本节所有数字对应 **882f745**；换修订号就重跑，别直接引用。
2. 文本对比（不花钱即可复算已有语料）：

   ```powershell
   node scripts/benchmarks/v01-text-metrics.ts docs/benchmarks/v01/raw-chat-real-20turns.txt
   ```

3. 语音对比（要花钱）：先跑 §3.2 的命令得到新 JSON，再用同一个
   `node scripts/benchmarks/v01-voice-metrics.ts --expect docs/benchmarks/v01/expected-fixture-texts.json`
   统计——**同一工具、同一口径**才可比。
4. 判定「改造有没有效果」时，先看 §2.4 的四个数：提问率（目标带宽 30–50%）、
   段数分布（是否不再每轮 2–3 段）、客套模板命中、跨轮重复短语；再看 §2.2 的 20 轮原文
   是否有换句话说的复述。
5. 本基线**不会**因为改造而更新（保留为历史快照）；改造后的数字写进新的基准文档。

## 7. 已知的口径缺口（留给 P1 的指标工作）

- 「复述上文」目前是 6 字窗口 + 逐字句子匹配，抓不到换句话说的复述（§2.4 有实例）。
  改造后需要有语义层面的判据（哪怕只是「同一话题/同一事实在同一次会话里被第二次主动重述」）。
- 「模板化」目前是 10 条固定词 + 结构观察。改造后建议把「先答→再补→再叮嘱/反问」这种
  三段式骨架变成可计数指标（例如同一收尾句式出现率）。
- 真实麦克风链路未上机，④ 的绝对值在设备侧还会变差（§3.4）；前后对比只在夹具口径内成立。
- **登记缺口（留给集成任务）**：新增的 `docs/benchmarks/` 目录与
  `docs/benchmarks/v01-baseline.md` 还没写进 `docs/README.md` §2 的权威性排序与 §3 的
  更新触发表；按该项目 §2/§3 的惯例应有对应条目（本任务不并行改共享文档，以免与他人冲突）。
