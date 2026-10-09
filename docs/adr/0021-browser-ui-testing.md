# ADR-0021：浏览器侧防线分两档（零依赖快档进默认门禁，真实 Chromium 深档单独一条命令）

- 状态：已采纳（2026-10-10，D0.3；落笔于 t23）
- 相关：铁律 11（每步先有可重复自动测试再往前走）、铁律 12（新增依赖必须写理由——本文件即是）、
  [ADR-0006](0006-runtime-and-dependency-choices.md)（运行时与依赖选择）、
  [`AGENTS.md` §9.9](../../AGENTS.md)（默认门禁要保持可用于迭代的速度）、
  [`AGENTS.md` §10.3](../../AGENTS.md)（静默 skip 比红更危险）、
  [`../progress.md` §13.1 缺陷 2](../progress.md)（这次要防的缺陷：少一层反斜杠 → 模板求值成真换行 →
  整块 `<script>` 解析期就死 → 一个监听器都没挂上）

## 背景

试用页曾出现「麦克风、打字、所有按钮全不动」：页面内联脚本里那处转义**少写了一层反斜杠**，
源码要发出「反斜杠 + n」两个字符，在 TypeScript 模板字符串里必须写两层，写成一层时**模板求值阶段
就把它变成了真换行**，于是发到浏览器的代码在**解析阶段**抛 `SyntaxError`，`<script>` 整块不执行——
一个监听器都没挂上。同一时刻 `/api/turn` 与 `/api/voice` 后端都是好的。

而当时**没有任何测试执行过页面的 JS**：`tests/console/*` 二十来个文件全是对生成文本做正则断言，
全库没有 jsdom、playwright、puppeteer。把发出的脚本抽出来 `node --check` 能看见
`SyntaxError: Invalid or unexpected token`，但那条命令是人事后手工跑的，不是门禁。

结论：仓库缺的**不是「更多页面文本断言」，而是一条能看见「这段代码能不能被浏览器执行」的防线**。
同时它不能再变成第二个「写了就必须跑、但跑起来很慢」的门禁负担：默认门禁的定位是「可用于迭代」。

### 覆盖缺口（第一版防线自己留的，2026-10-10 补上）

第一版快档只编译**内联** `<script>`，于是它有两个盲区，两者都不是「同一件事的放大」，风险等级也不同：

- **试用页根本没有被检查到**——为防这个缺陷而建的防线**恰恰没有盖住出事的那个页面**。
  这是最值得补的一条：`PAGE` 是 TypeScript 模板，跟事故现场是同一个机制（`scripts/serve-chat.ts`）。
- **`apps/demo-ui/app.js` 是外链静态文件**，任何内联抽取都看不见它；`tests/console/serve-chat-demo-route.test.ts`
  只断言状态码 / `content-type` / 长度 / 一个子串，`check:types` 又只看 `.ts`。它的暴露面是**普通的
  语法错误与手误**（写坏一个花括号、截断一行），**不是**控制台那次「模板求值吃掉一层转义」的机制——
  静态文件不经模板求值，那条机制在这儿不会重演。把它纳入的理由是「代码写坏了要有人管」，不是「它会以同样的方式坏掉」。

## 决定

### 1. 两条防线，各自的分工与代价写死在命令名里

```text
快档（零依赖、离线、进 npm test）        tests/ui/smoke/page-script.test.ts   → npm run test:ui:smoke
深档（真实 Chromium、单独一条命令）      tests/ui/e2e/page-behavior.test.ts   → npm run test:ui
浏览器二进制的获取                       —                                    → npm run test:ui:install
共享的判定与驱动代码                     tests/ui/lib/harness.ts
```

- **快档**：把页面**真正发出的**每个内联 `<script>`，以及它用 `<script src="…">` 从仓库里加载的每个本地
  脚本文件，抽出来用 `node:vm` 的 `Script` **只编译不执行**（与浏览器解析器的拒绝一致），并交叉核对
  「脚本按字面量找的每个元素 id 在页面里真实存在」。页面来源按各自真实出处取，**不是手抄一份 markup**
  （抄一份就等于测副本）：控制台页 `buildFieldPage()`、试用页 `scripts/serve-chat.ts` 的 `PAGE`、
  `apps/demo-ui/index.html` + 它的外链 `app.js`。零新依赖、不联网、不需要浏览器。
- **深档**：起**真的**控制台服务（`createFieldServer`，临时库、`--offline`、无密钥），用真实 Chromium
  打开 `GET /`，断言：页面 200、标题是控制台、`#p-listen` 由 `/api/field/state` 的真实往返填出来、
  **零 `pageerror`**、零失败请求、零 `console.error`；再点关键控件，断言它们**真的执行了处理器**
  （页内 `addEventListener` 计数探针 + DOM 结果 + 真实 `/api/*` 往返）——刷新设备读数渲染出服务端数据、
  「今天安静点」把状态推到 `SUSPENDED`、「新会话」重置日志、打一句字回车后渲染出一轮对话。
- **两条命令不合并**：默认门禁不许出现任何需要下载浏览器才能跑的用例；深档也不许为了让门禁变绿而
  降级成静默 skip——缺浏览器时它**报缺并以非零退出**，错误里直接给出获取命令。

### 2. 依赖选择：只加 `playwright` 这个**库**，不加第二个测试运行器

- 依赖是 **`playwright`（devDependency，`1.64.0` 精确钉版）**，用法是它的库 API（`chromium.launch()`），
  不是 `@playwright/test`：仓库的测试运行器仍然是 Node 内置的 `node:test`，深档的用例文件就是普通的
  `*.test.ts`，`npm run test:ui` 仍是 `node --test`。**不引入第二条测试运行器与第二套断言风格**。
- 精确钉版而非 `^`：Playwright 的浏览器修订号跟包版本绑定（本机取到的是
  `chromium_headless_shell-1248` / `156.0.8078.4`），浮动版本会让「同一份 lock 在不同时间拿到不同浏览器」。
- 浏览器**不进版本库**，按需获取一次：

  ```powershell
  npm run test:ui:install     # = playwright install chromium --only-shell
  ```

  默认落进 Playwright 自己的用户缓存（POSIX `~/.cache/ms-playwright`，Windows
  `%USERPROFILE%\AppData\Local\ms-playwright`）；`~/.cache` 不可写或在容器/沙箱里时，用
  `PLAYWRIGHT_BROWSERS_PATH=<仓库>/data/ms-playwright` 落到仓库内（`data/` 已 gitignore）。
  harness 的解析顺序是：`XIXI_UI_BROWSER_PATH`（指向本机已有 Chrome，不下载）→ `PLAYWRIGHT_BROWSERS_PATH`
  → 仓库内 `data/ms-playwright` → Playwright 默认缓存。

### 3. 为什么不是其它几条路（评估过的备选）

| 备选 | 为什么没选 |
|---|---|
| **继续只有文本断言**（现状） | 已实测看不见这次的缺陷：整块脚本解析失败时，页面文本一字不差，断言全绿 |
| **jsdom / happy-dom 进快档** | ① 快档要求**零新依赖**，且不需要 DOM：抽脚本 + 编译 + 核 id 全是纯文本分析；② jsdom 没有布局、没有 `fetch` 流式（`/api/voice` 的 NDJSON）、没有 `getUserMedia`/`Audio`/摄像头预览，深档要断言的行为它一半够不到；③ 它有自己的 HTML 解析器，jsdom 绿 ≠ 浏览器能跑，会把「防线」变成「另一种文本断言」 |
| **手写 CDP 驱动**（Node 内建 WebSocket 直连 DevTools 协议，零依赖） | 要自己实现启动参数、等待导航、逐帧求值、错误事件与超时回收，量级是上百行且没有维护者；省下的 19 MB JS 换来的是一段只有本仓库懂的脆弱代码 |
| **puppeteer** | 默认在 `npm install` 的 postinstall 里下载 Chrome——那会让**默认门禁/`npm ci` 变成需要浏览器下载**，与本 ADR 的第 1 条决定直接冲突；Playwright 的包**没有 postinstall**（实测），下载只发生在显式命令里 |
| **`playwright-core` + 系统 Chrome** | 不提供获取路径（要用户自己装 Chrome 并保持版本合适），作为**主路径**不成立；它保留为 `XIXI_UI_BROWSER_PATH` 这条逃生口 |
| **把深档也塞进 `npm test`** | 默认门禁要么变慢、要么有人把它改成静默 skip，两条都踩 AGENTS §9.9/§10.3；实测深档一次约 1.1s（本机 2 项用例）——**是**可以塞进去，但那会把「本机需要 278 MB 浏览器」变成「跑 `npm test` 的前置条件」，这是分档真正的理由 |

## 后果

### 代价（实测数字，2026-10-10 本机 Linux/WSL2）

| 项 | 实测 |
|---|---|
| `npm i -D playwright@1.64.0` | **+2 个包**、node_modules **+19 MB**（`playwright` 5.0 MB + `playwright-core` 14 MB）、约 1 s；**无 postinstall**，不下载浏览器 |
| `npm run test:ui:install`（`--only-shell`） | 11–16 s、**278 MB**（headless shell 273 MB + ffmpeg 5.1 MB），落到 `data/ms-playwright` |
| 同上不带 `--only-shell` | 37 s、**681 MB**（多出完整 Chromium 403 MB；本档只用无头运行，默认不取） |
| 深档一次运行 | 本机 2 项用例约 **1.1 s**（启动浏览器 + 真服务 + 四次交互）；快档 7 项约 **0.4 s**（含三个页面与外链脚本），进默认门禁 |

- **默认门禁仍然不需要浏览器**（这是分档的全部意义）：`npm ci` 只装 19 MB JS，`npm test` 只跑快档。
- **本仓库今天没有 CI**：门禁是人在一台机器上手动跑的，`AGENTS.md` §4 只规定了「先 `check:types` 再 `npm test`」的顺序。
  所以「CI 里没有浏览器」不是配置问题，而是事实：**深档在 CI 上不存在**，它是本机/验收时才跑的一条命令。
  谁要把它接进流水线，必须同时解决「下载 278 MB」与「缓存浏览器」两件事。
- 深档比快档慢、并且**依赖一个不在版本库里的二进制**——所以它永远不进默认门禁；
  快档则会在门禁里长期运行（0.4 s 的量级，可以接受）。

### 已知边界（写清楚，免得下次误以为它管了）

1. **快档抓不到运行时行为**：按钮的 handler 里访问不存在的属性、`null.addEventListener`、
   异步分支没跑、状态没渲染——这些只有深档能看见。快档的判据只有两条：
   *脚本能不能解析*、*按字面量找的 id 在不在页面里*。
2. **快档看不见「间接引用」**：`document.getElementById(PX.ids.save)` 这种经变量的查找不做静态推断。
   被识别的间接形态有四种：`getElementById('x')`、`querySelector('#x')`、共享面板发出的
   `PX.ids = {"save":"px-save",…}` 映射，以及**被识别出来的 id 助手**——比如控制台的
   `function el(id) { return document.getElementById(id); }` 与 demo 页的
   `const $ = (id) => document.getElementById(id)`。助手的判定故意很窄（函数体**就是**一次
   `document.getElementById`）；放宽到「函数体里提到过 `getElementById`」会把控制台的
   `pxVal('cooldown')` / `pxStatus('正在走九道门禁…')` 当成 id 查找——实测过，那是假红。
3. **模块脚本被明确拒绝而不是默默跳过**：`<script type="module">` 会得到一条「本档只编译经典内联脚本，
   要换模块请先扩展 `compilePageScripts()`」的红，而不是一个绿的空断言；
   今天三个页面都是单文件经典内联脚本，所以这条分支还没被真实用到。
4. **`<script src>` 的三种形态**：仓库内的相对路径会被读进来编译；**相对路径但仓库里没有这个文件**
   （或页面没声明资源目录）会**报红**；URL / `data:` / 绝对路径会被登记进 `notCompiled`，
   而用例断言这份登记是**空的**——也就是说，今天没有任何脚本引用可以偷偷绕过解析检查。
5. **覆盖范围（2026-10-10 实际状况）**：**快档**覆盖三个页面——现场测试控制台 `GET /`、试用页 `GET /`
   （`scripts/serve-chat.ts` 的 `PAGE`，即那次「所有按钮点了没反应」事故发生的页面）、以及
   `apps/demo-ui/index.html` 与它的外链 `app.js`。**深档仍只覆盖控制台的 `GET /`**：试用页与 demo 页的
   *运行时行为*今天没有自动防线（`/demo/` 的浏览器取证是一次性的，见 [`../progress.md` §14](../progress.md)）。
   两个页面若要接深档，是各自任务里的一件事。
6. **跨页共享片段不再有豁免（2026-10-10 收口；原文是这一档最初落地时的时点记录）**：
   *时点记录*：试用页把控制台的主动性面板脚本（`proactivePanelScript('/api')`）与浏览器播放规则
   （`XIXI_PLAYBACK_JS`）**逐字**嵌进自己的 `<script>`，而那段面板脚本里有为控制台写的硬编码 id
   （`px-cam-problem*`、`turns`、`presence-text`、`px-live-*`）。当时的处置是：解析检查照旧覆盖每一个字节，
   id 检查把这段交给控制台，并给「声明过的片段」加了一条响亮的守卫（逐字定位不到就报红）。
   *现状*：根因已修（t31）——`scripts/field-test.ts` 的 `proactivePanelScript()` 默认只发**页面无关的核心**，
   控制台独有的那几张卡只在调用方传 `{ consoleCards: true }` 时随页面发出，核心用
   `PX.hooks.appendConversation` 把「主动开口的那一句」交给它；于是试用页不再有那 30 条死分支，也不再
   每秒拉一次它没有的 `GET /api/live`（真浏览器里那是每秒一条 404 `console.error`）。
   **豁免机制（`PageUnderTest.sharedFragments`）连同它的夹具一起删掉了**：今天三个页面都按自己发出的字节
   过检——没有豁免可开，也就没有下一条「用声明压红」的漂移。防回退的两条判据在
   `tests/ui/smoke/page-script.test.ts`：改坏共享片段的语法仍必须红（整段字节都被编译），
   共享片段里写一个本页没有的 id 仍必须红（豁免没了，但检查的牙还在）。
7. **深档不测硬件**：它跑在 `--offline`、无密钥、临时库上，设备读数用桩；麦克风/扬声器/摄像头仍由
   `node scripts/field-test.ts --acceptance` 手工跑（见 [`../testing.md`](../testing.md) §6）。
8. **深档断言的是「页面这一侧」**：它不覆盖模型/语音质量，也不替代 `tests/console/*` 已有的大量文本与
   接口断言——那些仍然管它们各自的事，本 ADR 只是补上「真的执行过页面 JS」这一层。
