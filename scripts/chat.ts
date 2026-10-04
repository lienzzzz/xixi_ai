/**
 * Talk to Xixi from the terminal.
 *
 * This is the runnable demo the objective asks for: real multi-turn conversation
 * with continuity, personality and silence, plus per-turn latency numbers.
 *
 * Addressing (until M2 has a wake word): the same rule as the trial page — a line
 * typed while the FSM is IDLE counts as calling her, and while a session is open
 * the FSM treats the line as a continuation. A follow-up-window timeout returns
 * the session to IDLE, so the next line is accepted again instead of being
 * rejected for the rest of the process.
 *
 * Usage:
 *   node scripts/chat.ts                     # direct MiMo (realtime path)
 *   node scripts/chat.ts --fake              # offline deterministic adapter
 *   node scripts/chat.ts --dsh               # through the DSH harness (slower)
 *   node scripts/chat.ts --personality verbosity=0.1,talkativeness=0.2
 *   node scripts/chat.ts --personality=verbosity=0.1
 *   node scripts/chat.ts --print-wiring   # 离线：打印这条入口交给模型的工具链，然后退出
 *   echo "西西，明天天气怎么样？`n那后天呢？" | node scripts/chat.ts
 *
 * `--personality` is an administrative baseline override (the M3 seam), applied
 * before the engine is built, so the banner and the follow-up window show the
 * overridden values and the very next prompt carries them.
 *
 * Commands inside the session: /state /prompt /quiet /resume /exit
 */
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, type BrainAdapter, type ToolCallRecord, type ToolRegistry } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { ConversationEngine } from '@xixi/conversation';
import { openXixiStore, PERSONALITY_PROPERTIES, personalityProperty, resolveCanonicalDataDir, type XixiConfig } from '@xixi/domain';
import { WeatherClient, type MimoClient } from '@xixi/model-adapters';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, readDotEnv } from './lib/harness.ts';
// V0.3 P0-A: the shared tool chain moved to `@xixi/runtime`; `scripts/field-test.ts` still
// re-exports it for anyone that has not migrated yet (this entry has — it no longer imports
// the console script at all). See pack `04_RUNTIME_CONSOLIDATION.md` §1 Step A.
import { CONVERSATION_SCOPE, buildToolChain, createTurnExtraction } from '@xixi/runtime';

export interface PersonalityArgsResult {
  /**
   * Validated `property → value` pairs (later wins on duplicates).
   *
   * Empty whenever `problems` is non-empty: the result is all-or-nothing, so a
   * caller cannot apply the valid half of a typo'd override by accident.
   */
  readonly values: Record<string, number>;
  /** Human-readable problems; any entry means nothing may be applied. */
  readonly problems: readonly string[];
}

const PERSONALITY_NAMES = PERSONALITY_PROPERTIES.map((property) => property.name).join('、');

/**
 * Parse `--personality`.
 *
 * Both forms the usage line documents must work, and the old parser supported
 * neither:
 *   `--personality a=1,b=2`   (separate token — the value used to be dropped)
 *   `--personality=a=1,b=2`   (was split on the first `=`, yielding `a`)
 * Values are validated here rather than left to the store, so a typo produces a
 * readable sentence instead of a stack trace or a silent no-op. Nothing is
 * applied when any problem is found: a half-applied personality is worse than a
 * refusal, because the user would have no way to tell which knobs moved.
 */
export function parsePersonalityArgs(argv: readonly string[]): PersonalityArgsResult {
  const problems: string[] = [];
  const specifications: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--personality') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        problems.push('`--personality` 后面缺少设置；例如 `--personality verbosity=0.1,talkativeness=0.2`。');
        continue;
      }
      specifications.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--personality=')) {
      specifications.push(argument.slice('--personality='.length));
    }
  }

  const values: Record<string, number> = {};
  for (const item of specifications.flatMap((specification) => specification.split(','))) {
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      problems.push('人格设置里出现了空项（多余的逗号，或 `--personality=` 后面没写东西）。');
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      problems.push(`人格设置「${trimmed}」缺少「=」，应写成 \`属性=数值\`，例如 \`verbosity=0.1\`。`);
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const definition = personalityProperty(name);
    if (definition === undefined) {
      problems.push(`未知的人格属性「${name}」；可用属性：${PERSONALITY_NAMES}。`);
      continue;
    }
    if (rawValue.length === 0) {
      problems.push(`人格属性「${name}」的值为空；应填 ${definition.min}~${definition.max} 之间的数字。`);
      continue;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      problems.push(`人格属性「${name}」的值「${rawValue}」不是数字。`);
      continue;
    }
    if (value < definition.min || value > definition.max) {
      problems.push(
        `人格属性「${name}」的值 ${value} 超出允许范围 [${definition.min}, ${definition.max}]（${definition.description}）。`,
      );
      continue;
    }
    values[name] = value;
  }

  return { values: problems.length > 0 ? {} : values, problems };
}

/** How the CLI talks to the model: a scripted stand-in, the DSH harness, or a direct MiMo call. */
export type ChatMode = 'fake' | 'dsh' | 'mimo';

/**
 * The weather source `--fake` uses.
 *
 * `npm run chat -- --fake` is documented as a **completely offline** demo (AGENTS §7), and that
 * promise has to survive the tools being wired in: without this, a question about the weather would
 * reach the real provider from a run that is supposed to touch nothing. The payload is the same
 * fields a live lookup returns — code, temperatures, precipitation probability — so the tool derives
 * the same summary, range and umbrella advice from it as it would from the network.
 */
function offlineWeatherSource(): WeatherClient {
  const reply = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fetchImpl = (async (input: string | URL | Request) =>
    String(input).includes('geocoding')
      ? reply({ results: [{ name: '成都', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', admin1: '四川省' }] })
      : reply({
          timezone: 'Asia/Shanghai',
          daily: {
            time: ['2026-10-01', '2026-10-02', '2026-10-03'],
            weather_code: [61, 3, 0],
            temperature_2m_max: [24.4, 25.1, 27.8],
            temperature_2m_min: [18.2, 19.0, 20.1],
            precipitation_probability_max: [80, 8, 0],
          },
        })) as unknown as typeof fetch;
  return new WeatherClient({ fetchImpl });
}

/**
 * The one tool chain this entry talks through (pack Phase 2, extended in t14/T5-F1).
 *
 * It is the console's own `buildToolChain`, not a CLI-local copy of the built-in set: the registry,
 * the permission policy and the round cap are therefore the same objects the field-test console and
 * the trial page use, and a new tool joins every entry at once. `--fake` gets an in-memory weather
 * source so the offline demo stays offline; every other mode keeps the real one.
 */
export function buildChatToolChain(mode: ChatMode, config: XixiConfig, onToolCall?: (record: ToolCallRecord) => void): ToolRegistry {
  return buildToolChain(config, {
    ...(onToolCall === undefined ? {} : { onToolCall }),
    ...(mode === 'fake' ? { weatherClient: offlineWeatherSource() } : {}),
  });
}

export interface ChatDirectAdapterOptions {
  readonly config: XixiConfig;
  readonly toolChain: ToolRegistry;
  /** Injected by a test; the CLI lets the adapter build its client from the environment. */
  readonly client?: MimoClient;
}

/**
 * The direct-MiMo adapter with this entry's exact wiring — exported so an offline test can drive the
 * real thing instead of a lookalike.
 *
 * Two t14 fixes live here. T5-F1: the adapter is handed the shared *registry* (not a bare
 * `defaultTools` list), so this CLI gets the same four built-ins, the same permissions and the same
 * four-round cap as the console. T5-F3: the reply-hygiene filter is told the **deployment language**
 * from the config; the adapter's own default is a hard-coded `zh-CN`, and a deployment that speaks
 * something else must not silently inherit that assumption.
 */
export function buildDirectAdapter(options: ChatDirectAdapterOptions): MimoBrainAdapter {
  return new MimoBrainAdapter({
    ...(options.client === undefined ? {} : { client: options.client }),
    maxCompletionTokens: 400,
    registry: options.toolChain,
    scope: CONVERSATION_SCOPE,
    timezone: options.config.identity.timezone,
    language: options.config.identity.language,
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const useFake = argv.includes('--fake');
  const useDsh = argv.includes('--dsh');
  const { values: personalityOverride, problems } = parsePersonalityArgs(argv);

  if (problems.length > 0) {
    console.error('[参数错误] 人格覆盖没有生效：');
    for (const problem of problems) console.error(` - ${problem}`);
    console.error('用法：node scripts/chat.ts [--fake] [--dsh] [--personality 属性=数值,...]');
    process.exitCode = 2;
    return;
  }

  // The direct adapter reads the key from the environment or .env (§20.4: never from source).
  for (const [key, value] of Object.entries(readDotEnv())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const config = loadConfig();
  const mode: ChatMode = useFake ? 'fake' : useDsh ? 'dsh' : 'mimo';

  // The offline wiring report (t14): what this entry hands the model, with no model call and no
  // store. The chain comes from the same builder `buildAdapter` uses, so it cannot drift from it.
  if (argv.includes('--print-wiring')) {
    const chain = buildChatToolChain(mode, config);
    console.log(
      JSON.stringify({
        entry: 'chat',
        language: config.identity.language,
        maxToolRounds: chain.maxToolRounds,
        tools: chain.listForAgent(CONVERSATION_SCOPE).map((tool) => tool.name),
        permissions: Object.fromEntries(chain.names().map((name) => [name, chain.check(name, CONVERSATION_SCOPE).verdict])),
      }),
    );
    return;
  }

  /**
   * V0.3 P0-B: the household canonical store by default (`XIXI_DATA_DIR`, else `data/xixi`), so the
   * CLI, the trial page, the console and the perception ingest all read and write **one** Xixi.
   * `XIXI_CHAT_DATA_DIR` is still honoured (tests and parallel instances), but it now sits *below*
   * the household switch — see `resolveCanonicalDataDir` for the precedence table.
   */
  const store = openXixiStore({ dataDir: resolveCanonicalDataDir({ legacyEnv: 'XIXI_CHAT_DATA_DIR', cwd: REPO_ROOT }) });
  const session = store.latestSession() ?? store.createSession();
  store.seedSelfProfile(config.personality.base);
  if (Object.keys(personalityOverride).length > 0) {
    // Explicitly an administrative override, not learned adjustment (M3).
    // The engine is built after this point, so the follow-up window and the next
    // prompt both see the overridden values.
    store.overrideSelfProfile(personalityOverride, 'cli:override');
    const applied = Object.entries(personalityOverride)
      .map(([name, value]) => `${name}=${value}`)
      .join(', ');
    console.log(`人格已按命令行覆盖：${applied}`);
    console.log(`生效人格（已写入 self_profile，重启后仍是它）：${JSON.stringify(store.selfProfile())}`);
  }

  function buildAdapter(): BrainAdapter {
    // One chain for the REPL's text turns, built by the console's own factory (t14/T5-F1): the
    // `--fake` branch runs the real loop over the real registry, so "offline" exercises the tool
    // path instead of skipping it, and `--dsh` is untouched because the harness owns its tools.
    const toolChain = buildChatToolChain(mode, config, (record) =>
      process.stderr.write(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}\n`),
    );
    if (useFake) return new FakeBrainAdapter({ registry: toolChain, scope: CONVERSATION_SCOPE });
    if (useDsh) {
      const transport = new CliDshTransport({
        dshHome: DSH_HOME,
        profile: DSH_PROFILE,
        cwd: REPO_ROOT,
        env: harnessEnv(),
        timeoutMs: 240_000,
        onDiagnostic: (line) => process.stderr.write(`[dsh] ${line}\n`),
      });
      return new DshBrainAdapter({ transport, store });
    }
    return buildDirectAdapter({ config, toolChain });
  }

  const adapter = buildAdapter();
  /**
   * V0.3 P1-b：这个入口以前**没有**接过 `afterTurn` —— 命令行里聊过的事不进记忆，
   * 而试用页会（同一个西西因此表现不一致）。装配与另外两个入口共用同一份工厂：
   * `afterTurn` 只入队不 await，`drain()` 在关库之前把排队与在飞的活跑完。
   */
  const extraction = createTurnExtraction({ store, config });
  const engine = new ConversationEngine({
    adapter,
    store,
    config,
    turnTimeoutMs: 60_000,
    afterTurn: extraction.afterTurn,
  });

  console.log(`西西（${adapter.describe().provider} / ${adapter.describe().model}）已就绪。`);
  console.log(`会话 ${session.sessionId}，已有 ${session.turnCount} 轮；人格 ${JSON.stringify(store.selfProfile())}`);
  console.log(
    `跟进窗口 ${engine.lingerMs}ms（由人格 silence_tolerance=${engine.silenceTolerance} 缩放）；` +
      'IDLE 时直接说话即为叫醒，会话开了就按继续处理。输入 /exit 结束。\n',
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });

  async function handle(line: string): Promise<void> {
    const text = line.trim();
    if (text.length === 0) return;
    if (text === '/exit') {
      rl.close();
      return;
    }
    if (text === '/state') {
      console.log(`state=${engine.state} ${JSON.stringify(engine.snapshot())}\n`);
      return;
    }
    if (text === '/prompt') {
      const prompt = engine.buildPrompt({ sessionId: session.sessionId, text: '(预览)' });
      console.log(`--- system ---\n${prompt.system}\n--- user ---\n${prompt.user}\n`);
      return;
    }
    if (text === '/quiet') {
      engine.quiet();
      console.log('已进入安静模式（/resume 恢复）。\n');
      return;
    }
    if (text === '/resume') {
      engine.resume();
      console.log('已恢复。\n');
      return;
    }

    try {
      // Same rule as the trial page (`scripts/serve-chat.ts`): the terminal has no
      // wake word yet (M2), so a line typed while the session is idle counts as
      // calling her — a follow-up-window timeout returns the FSM to IDLE, and the
      // next line must be accepted again. While a session is open, `addressed` is
      // ignored by the FSM (continuation), so mirroring the page is enough.
      const addressed = engine.state === 'IDLE';
      /**
       * Say the reply the way ADR-0010 means it to be said: **segment by segment**, with the
       * real pause between them, instead of one wall of text. `onSegment` and `onTextChunk`
       * are mutually exclusive by design (the engine stops handing out raw deltas once the
       * playback seam is supplied), so the printing happens here and the summary below stays
       * quiet — otherwise every reply would appear twice.
       */
      const played: string[] = [];
      /**
       * preflight ⑧: 引擎的 `onNotice` 是「这一轮为什么什么也没说 / 被剔掉了什么」的唯一出口
       * （试用页与控制台早就订阅了，这个终端入口以前没有：`ARTIFACT_ONLY_REPLY`（整句被清洗掉）
       * 与 `MODEL_SILENCE`（模型自己不说）在这里看起来一模一样）。先收集，这一轮说完再打。
       */
      const notices: { readonly code: string; readonly detail: string }[] = [];
      const turn = await engine.respond(
        { sessionId: session.sessionId, text, addressed },
        {
          onSegment: async (segment) => {
            const label = segment.total > 1 ? `【第 ${segment.index + 1}/${segment.total} 段】` : '';
            process.stdout.write(`\n西西${label}：${segment.text}`);
            played.push(segment.text);
            if (segment.gapMsAfter !== null && segment.index + 1 < segment.total) {
              process.stdout.write(`\n（停 ${segment.gapMsAfter}ms 再说下一段…）`);
              await delay(segment.gapMsAfter);
            }
          },
          onNotice: (notice) => void notices.push({ code: notice.code, detail: notice.detail }),
        },
      );
      const timing = `[${turn.action} ${turn.latencyMs}ms${turn.firstTokenMs === null ? '' : ` 首字${turn.firstTokenMs}ms`} state=${turn.state} linger=${engine.lingerMs}ms 人格=${engine.silenceTolerance}${turn.segments.length > 1 ? ` 分${turn.segments.length}段/间隔${turn.segmentGapMs}ms` : ''}]`;
      if (!turn.accepted) {
        // Say what this means instead of just refusing.
        console.log(`未接受（${turn.reason}）：西西正处在安静模式，用 /resume 恢复。`);
      } else if (turn.action === 'SILENCE') {
        console.log(`（沉默）${timing}`);
      } else if (played.length > 0) {
        console.log(`\n${timing}`);
      } else {
        console.log(`${turn.text ?? ''}\n${timing}`);
      }
      // 沉默的原因 / 被剔掉的内容（preflight ⑧）：一行一条，带 code，便于对照文档里的原因码。
      for (const notice of notices) console.log(`[提示 ${notice.code}] ${notice.detail}`);
    } catch (error) {
      console.log(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log('');
  }

  for await (const line of rl) {
    await handle(line);
  }
  store.recordHealth('chat', 'ok', 'session ended');
  // 关库之前先把后台提取跑完（t9 F3 的同一纪律：数据丢失不能是无声的）。
  await extraction.drain();
  store.close();
}

// Guarded so tests can import `parsePersonalityArgs` without opening the store,
// reading `.env` or starting a REPL (`import.meta.main` is true only for the
// entry module).
if (import.meta.main) {
  await main();
}
