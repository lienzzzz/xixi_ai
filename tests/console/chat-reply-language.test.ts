/**
 * t14 / T5-F3: the text CLI's reply filter has to be told the **deployment language**.
 *
 * The engine already gates the final text with `config.identity.language`, but the streaming hold
 * *inside* the adapter is a second, independent gate — and the CLI was the one live entry that never
 * passed the language, so the adapter fell back to its own hard-coded `zh-CN`. Measured here without a
 * provider: a reply whose deltas carry English reasoning plus a Chinese line must reach the terminal
 * as the Chinese line only, and the entry must read the language from the config rather than from the
 * adapter's default (the second test pins that; the first one drives the real CLI).
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectTurn } from '@xixi/brain-adapter';
import { MimoClient } from '@xixi/model-adapters';

import { buildChatToolChain, buildDirectAdapter } from '../../scripts/chat.ts';
import { REPO_ROOT, loadConfig } from '../../scripts/lib/harness.ts';

const SPAWN_TIMEOUT_MS = 60_000;

/**
 * The defect's own shape (`docs/benchmarks/v01-baseline.md` §4): the model reasons in English and
 * then says the real line in Chinese. The English part is what must never reach a mouth or the TUI.
 */
const LEAKED_REPLY =
  'The user is repeating their earlier message, so I should respond naturally as a family member would. 我在的，刚收拾完厨房。';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One SSE completion, split into deltas so the streaming hold really runs. */
function sseBody(text: string, size = 24): string {
  const deltas: string[] = [];
  for (let index = 0; index < text.length; index += size) deltas.push(text.slice(index, index + size));
  return [...deltas.map((delta) => `data: ${JSON.stringify({ model: 'stub-model', choices: [{ delta: { content: delta } }] })}\n\n`), 'data: [DONE]\n\n'].join('');
}

/** One SSE round that asks for a tool instead of answering — the shape a real provider sends. */
function sseToolCall(name: string): string {
  return [
    `data: ${JSON.stringify({ model: 'stub-model', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: '{}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ model: 'stub-model', choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

/**
 * A local stand-in for the provider, so the CLI can be driven end to end without a key or a network
 * call. `MIMO_BASE_URL` is what points `MimoClient` here.
 *
 * The first request asks for a tool; once the request body carries the tool result, the second one
 * answers with `text`. That two-round script is what makes the CLI's *real* adapter path observable:
 * the tool can only have run through the registry the CLI built, and the `[tool] …` log the CLI
 * attaches to that registry is its receipt.
 */
async function withStubProvider(options: { tool: string; text: string }, body: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(raw.includes('"role":"tool"') ? sseBody(options.text) : sseToolCall(options.tool));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await body(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** `fetchImpl` instead of a socket: the same streaming path, one process, no port. */
function stubClient(text: string): MimoClient {
  const encoder = new TextEncoder();
  const fetchImpl = (async () => {
    const body = (async function* (): AsyncGenerator<Uint8Array> {
      yield encoder.encode(sseBody(text));
    })();
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
  return new MimoClient({ baseUrl: 'http://stub.invalid/v1', apiKey: 'offline-stub-key', fetchImpl });
}

test('英文推理不进 TUI：文字 CLI 对着真实适配器跑一条被污染的回复', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  const root = tempDir('xixi-t2-tui-');
  try {
    // The fixture is what it claims to be: without this the "no English in the output" assertion
    // below could be satisfied by a reply that never contained English in the first place.
    assert.match(LEAKED_REPLY, /The user is repeating/, '夹具本身带着英文推理');

    let out = '';
    let status: number | null = null;
    await withStubProvider({ tool: 'xixi_get_current_time', text: LEAKED_REPLY }, async (baseUrl) => {
      const child = spawn(process.execPath, ['scripts/chat.ts'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          XIXI_CHAT_DATA_DIR: root,
          MIMO_BASE_URL: baseUrl,
          MIMO_API_KEY: 'offline-stub-key',
          // The stub is on 127.0.0.1; a proxy from the ambient environment would break that.
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          NODE_USE_ENV_PROXY: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stdin.write('你在吗\n');
      child.stdin.end();
      status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    });

    assert.equal(status, 0, `chat.ts 应当 exit 0：\n${out}`);
    // T5-F1, on the branch the CLI really runs (not `--fake`): the tool ran through the registry this
    // entry built, and the log line is the receipt for *that* object — a second, private registry
    // would execute the tool too but could not print it here.
    assert.match(out, /\[tool\] xixi_get_current_time ok/, '第一轮的 provider 工具调用必须由 CLI 自己的注册表执行');
    assert.match(out, /西西：我在的，刚收拾完厨房/, '中文那半句必须原样进 TUI');
    assert.doesNotMatch(out, /The user is repeating/, '英文推理不得进 TUI');
    assert.doesNotMatch(out, /respond naturally/, '英文推理不得进 TUI');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('回复过滤读的是部署语言，不是适配器写死的中文默认值', { timeout: SPAWN_TIMEOUT_MS }, async () => {
  // A reply that the Chinese rule removes (a long Han-free tail) but that a deployment which speaks
  // English must deliver untouched: the two halves together are what makes this discriminating.
  // If the CLI kept ignoring the config, both adapters would filter as `zh-CN` and the second
  // assertion would fail.
  const reply = '我在的，你回来了就好。Good to know you got back home late tonight, I will note that and ask again tomorrow.';

  const config = loadConfig();
  const chineseDeployment = buildDirectAdapter({ config, toolChain: buildChatToolChain('mimo', config), client: stubClient(reply) });
  const chineseTurn = await collectTurn(await chineseDeployment.handleUserTurn({ sessionId: 'sess_t2_language_zh', text: '你在吗' }));
  assert.match(chineseTurn.result.text ?? '', /我在的/, '中文部署保留中文');
  assert.doesNotMatch(chineseTurn.result.text ?? '', /Good to know/, '中文部署把长英文串当推理丢掉');

  const englishConfig = { ...config, identity: { ...config.identity, language: 'en-US' } };
  const englishDeployment = buildDirectAdapter({
    config: englishConfig,
    toolChain: buildChatToolChain('mimo', englishConfig),
    client: stubClient(reply),
  });
  const englishTurn = await collectTurn(await englishDeployment.handleUserTurn({ sessionId: 'sess_t2_language_en', text: 'are you there' }));
  assert.match(englishTurn.result.text ?? '', /Good to know/, '英文部署不该被中文规则改写');
});
