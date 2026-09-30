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
 *   echo "西西，明天天气怎么样？`n那后天呢？" | node scripts/chat.ts
 *
 * Commands inside the session: /state /prompt /quiet /resume /exit
 */
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { DshBrainAdapter, FakeBrainAdapter, MimoBrainAdapter, defaultTools, type BrainAdapter } from '@xixi/brain-adapter';
import { CliDshTransport } from '@xixi/brain-dsh';
import { ConversationEngine } from '@xixi/conversation';
import { openXixiStore } from '@xixi/domain';

import { DSH_HOME, DSH_PROFILE, REPO_ROOT, harnessEnv, loadConfig, readDotEnv } from './lib/harness.ts';

const args = process.argv.slice(2);
const useFake = args.includes('--fake');
const useDsh = args.includes('--dsh');
const personalityOverride = args
  .filter((argument) => argument.startsWith('--personality=') || argument === '--personality')
  .flatMap((argument) => (argument.includes('=') ? [argument.split('=')[1]] : []))
  .flatMap((value) => value.split(','))
  .map((pair) => pair.split('='))
  .filter((pair) => pair.length === 2);

// The direct adapter reads the key from the environment or .env (§20.4: never from source).
for (const [key, value] of Object.entries(readDotEnv())) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const config = loadConfig();
const store = openXixiStore({ dataDir: join(REPO_ROOT, 'data', 'chat') });
const session = store.latestSession() ?? store.createSession();
store.seedSelfProfile(config.personality.base);
if (personalityOverride.length > 0) {
  // Explicitly an administrative override, not learned adjustment (M3).
  const wanted = Object.fromEntries(personalityOverride.map(([name, value]) => [name, Number(value)]));
  store.overrideSelfProfile(wanted, 'cli:override');
  console.log(`人格已按命令行覆盖：${JSON.stringify(wanted)}`);
}

function buildAdapter(): BrainAdapter {
  if (useFake) return new FakeBrainAdapter();
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
  const tools = defaultTools({ defaultPlace: config.identity.place ?? '' });
  return new MimoBrainAdapter({
    maxCompletionTokens: 400,
    tools,
    timezone: config.identity.timezone,
    onToolCall: (record) => process.stderr.write(`[tool] ${record.name} ${record.ok ? 'ok' : `failed: ${record.error}`}\n`),
  });
}

const adapter = buildAdapter();
const engine = new ConversationEngine({ adapter, store, config, turnTimeoutMs: 60_000 });

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

  const streaming: string[] = [];
  process.stdout.write('西西: ');
  try {
    // Same rule as the trial page (`scripts/serve-chat.ts`): the terminal has no
    // wake word yet (M2), so a line typed while the session is idle counts as
    // calling her — a follow-up-window timeout returns the FSM to IDLE, and the
    // next line must be accepted again. While a session is open, `addressed` is
    // ignored by the FSM (continuation), so mirroring the page is enough.
    const addressed = engine.state === 'IDLE';
    const turn = await engine.respond(
      { sessionId: session.sessionId, text, addressed },
      {
        onTextChunk: (chunk) => {
          process.stdout.write(chunk);
          streaming.push(chunk);
        },
      },
    );
    const timing = `[${turn.action} ${turn.latencyMs}ms${turn.firstTokenMs === null ? '' : ` 首字${turn.firstTokenMs}ms`} state=${turn.state} linger=${engine.lingerMs}ms 人格=${engine.silenceTolerance}]`;
    if (!turn.accepted) {
      // Say what this means instead of just refusing.
      console.log(`未接受（${turn.reason}）：西西正处在安静模式，用 /resume 恢复。`);
    } else if (turn.action === 'SILENCE') {
      console.log(`（沉默）${timing}`);
    } else {
      console.log(streaming.length === 0 ? `${turn.text ?? ''}\n${timing}` : `\n${timing}`);
    }
  } catch (error) {
    console.log(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log('');
}

for await (const line of rl) {
  await handle(line);
}
store.recordHealth('chat', 'ok', 'session ended');
store.close();
