# ADR-0006：运行时与依赖选择

- 状态：已接受（2026-09-29）
- 相关：ADR-0001、[`package.json`](../../package.json)、[`packages/domain/src/config.ts`](../../packages/domain/src/config.ts)、
  [`plugins/xixi-tools/index.js`](../../plugins/xixi-tools/index.js)、`docs/testing.md`
- 上游依据：`AGENTS.md` 铁律 12（新增依赖必须写明理由）、第 3 节（机器不稳）、第 4 节（环境事实）；《方案》§42、§47.1

## Context

目标机器是一台**偶发蓝屏的旧笔记本**，长任务必须能从断电处恢复（`AGENTS.md` 第 3 节）。
每多一个工具链环节，就多一个崩在半路、需要人工清理的状态。
环境实测（2026-09-29，本机复核）：

| 事实 | 值 |
|---|---|
| Node | v24.21.0，原生类型擦除，可直接 `node x.ts` |
| `node:sqlite` 内置模块 | 可用；`process.versions.sqlite` = **3.53.4**，含 JSON1 |
| Docker / mosquitto / ffmpeg | **都没有**（ADR-0004） |
| Python | 只有 3.14.7（Pipecat / LiveKit Agents 需要 3.10–3.12，属 M1 前置） |

因此 M0 的依赖选择不是「哪个生态最好」，而是「哪个能在崩溃后一条命令回到可用状态」。

## Decision

### 1. Node 24 原生 TypeScript，无构建步骤

`.ts` 由 Node 直接执行（类型擦除），仓库里**没有 `tsconfig.json`**，也没有 `build` / `dist` 目录。
`package.json` 的 `engines.node` 为 `>=24.0.0`，各 workspace 的 `exports` 直接指向源码：
`"@xixi/domain": "./src/index.ts"`。测试用内置 `node:test` 直接跑 `.ts`（见 `docs/testing.md`）。

### 2. `node:sqlite`（SQLite 3.53.4）作为存储

`packages/domain` 是唯一 `import { DatabaseSync } from 'node:sqlite'` 的包。
打开时设置 `PRAGMA journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`；
写操作一律走 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`（`XixiStore.#transaction`）。
数据库放 `data/`（已 gitignore），测试用系统临时目录（`mkdtempSync`）。
《方案》§47.1 本来就选 SQLite + WAL：单机、方便复制、容易 inspect、不需要运维。

### 3. `js-yaml@5.4.2` 是唯一的运行时依赖

理由（铁律 12）：**方案 §42 规定的配置格式就是 YAML**（`config/xixi.example.yaml`），
而 Node 没有内置 YAML 解析器。它是 `packages/domain` 的依赖，
在 [`loadXixiConfig` / `parseXixiConfig`](../../packages/domain/src/config.ts) 里使用，
并且与 DSH 自己使用的解析器是同一个。

`.env` 读取刻意**不**引入 `dotenv`：`scripts/lib/harness.ts` 的 `readDotEnv()` / `harnessEnv()`
用十几行解析「一个密钥 + 两个代理开关」，值从不打印。

### 4. `@deepseek-ai/dsh-tools@0.1.7-rc.2` 作为固定的 devDependency

它只是为了让 [`plugins/xixi-tools/index.js`](../../plugins/xixi-tools/index.js) 的
`import { defineTool } from '@deepseek-ai/dsh-tools'` 在仓库内可解析。
同一版本号也写在 `plugins/xixi-tools/package.json` 的 `peerDependencies`（并标 `optional`），
与 ADR-0001 固定的 DSH 版本严格一致。

### 5. 明确声明的后果：**目前没有 `tsc --noEmit` 类型检查门**

仓库没有 `tsconfig.json`，`npm test` 只做运行时校验，**类型错误只会在运行时暴露**。
这不是疏忽，而是本项目当前接受的已知缺口；补齐时机是 M1 之前，且需要先评估
TypeScript 7 与本仓库「相对导入必须带 `.ts` 扩展名」这一约定如何共存
（`docs/progress.md` 第 6 节与第 4 节第 4 条）。

## Alternatives

| 方案 | 为什么没选 |
|---|---|
| `tsc` / `tsup` / `esbuild` 预编译到 `dist/` | 多一份生成物与一个可能崩在半路的构建状态；本机易崩，源码直跑更可恢复 |
| `tsx` / `ts-node` 作为运行器 | 引入运行时依赖与自己的缓存目录，而 Node 24 已内置类型擦除，收益为零 |
| `better-sqlite3` 或 `sqlite3` | 需要原生编译；`node:sqlite` 内置且本机为 3.53.4 含 JSON1，够用且零安装风险 |
| `zod` / `ajv` 做事件校验 | 见下：契约只需要一个封闭的关键字集合，自写子集校验器能**fail-closed**，第三方校验器默认是宽容的 |
| `dotenv` | 两行逻辑能解决的事，不值得多一个依赖；且需要控制「值绝不进日志」的行为 |
| `yaml` 包替代 `js-yaml` | 计价相同则沿用 DSH 已用的解析器，减少语义差异（例如重复键、类型推断的行为差异） |

**关于校验器**：`packages/contracts/src/schema-validator.ts` 只实现
`SUPPORTED_KEYWORDS` 里列出的 18 个关键字，遇到别的关键字直接抛
`ContractError('UNSUPPORTED_SCHEMA_KEYWORD')`，并在加载 schema 时用 `assertEnforceable` 检查。
这是一次有意的取舍：宁可**在启动时响亮失败**，也不允许「写了但没被强制执行」的约束悄悄溜进契约
（《方案》§51 的 schema compatibility 检查正是这个意思）。

## Consequences

- **零构建**：`npm install` 之后 `npm test` / `npm run demo:m0:*` 可直接运行；
  崩溃后的恢复步骤就是 `npm install` → `install-dsh-profile.ts` → `npm test`（`docs/progress.md` 第 7 节）。
- **零原生编译**：不需要 Python/node-gyp/VS 构建工具链——本机 Python 只有 3.14，装 node-gyp 生态风险高。
- **类型安全是缺口，不是保证**：重构时没有编译期保护；缓解手段是 `node:test` 覆盖与
  `npm test` 的漂移检查（注册表/enum/actor 列表、schema 关键字白名单、迁移 checksum）。
  补上 `tsc --noEmit` 之前，代码评审必须额外留意类型层面的改动。
- **依赖面极小**：生产依赖只有 `js-yaml`。任何新增依赖都要先写进本 ADR 的理由（铁律 12）。
- **版本对齐风险**：`@deepseek-ai/dsh-tools` 必须与全局 DSH 保持同一个 RC 版本；
  升级 DSH 时若不同步升级它，工具插件可能加载失败——`install-dsh-profile.ts` 的 `verifyBoot()`
  会在 `--dump-config` 里检查 `dsh-llm-pi-ai` / `xixi-tools` / `openai-completions` / `mimo-v2.6-flash`
  四个标志，把这个风险变成安装期的响亮失败。
