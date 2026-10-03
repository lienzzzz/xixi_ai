/**
 * pack v03-preflight ⑧：引擎的 `onNotice` 只被**试用页与控制台**订阅，两个命令行入口没订阅
 * （`scripts/chat.ts`、`scripts/voice-turn.ts`）。
 *
 * 症状是「说不清为什么」：整句回复被清洗掉（`ARTIFACT_ONLY_REPLY`）与模型自己决定不说
 * （`MODEL_SILENCE`）在终端里长得一模一样；被替换掉的无据事实、被 token 上限截断……也一样看不见。
 *
 * 两条断言都用**真进程**（离线 `--fake`，不花钱、不联网）：
 *   1. `scripts/chat.ts --fake`：喂一句会被清洗掉的话（`**你好**` 的 markdown 记号），
 *      断言 stdout 上出现 `[提示 REPLY_HYGIENE]`；
 *   2. `scripts/voice-turn.ts --fake`：让**这一轮真的触发一个 notice** —— 离线 ASR 的转写是
 *      `（离线模拟）+ wav 路径`，所以把夹具复制成 `湿度62.wav` 就能让引擎说出一句「只有查过才知道的
 *      具体事实」而无工具可依（`findUnbackedFactClaims` 的 `湿度 62` 规则），断言这轮的
 *      `notices[]` 里确实有 `UNBACKED_FACT_CLAIM`，并且回复被换成那句修复话术。
 *      （为什么不只是「字段存在」：字段存在证明不了引擎报过 notice；触发一次才算接线。）
 *
 * Run: `npm run test:console`（也在 `npm test` 里）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT } from '../../scripts/lib/harness.ts';

const CHILD_TIMEOUT_MS = 180_000;

/** 起一个真进程、喂一行 stdin、等它自己退出，返回它说过的所有话。 */
async function runChatWith(line: string): Promise<{ code: number | null; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-chat-notice-'));
  const child = spawn(process.execPath, ['scripts/chat.ts', '--fake'], {
    cwd: REPO_ROOT,
    env: { ...process.env, XIXI_CHAT_DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (output += chunk));
  child.stderr?.on('data', (chunk: string) => (output += chunk));
  child.stdin?.write(`${line}\n/exit\n`);
  child.stdin?.end();
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => resolve(exitCode));
      setTimeout(() => {
        child.kill();
        resolve(null);
      }, CHILD_TIMEOUT_MS).unref();
    });
    return { code, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
}

test('终端入口 chat.ts 把引擎的 notice 打出来（preflight ⑧）', { timeout: CHILD_TIMEOUT_MS }, async () => {
  // `**你好**` 是 markdown 记号：引擎的清洗闸门会把它剔掉，并通过 `onNotice` 报 `REPLY_HYGIENE`。
  const { code, output } = await runChatWith('**你好**');
  assert.equal(code, 0, `chat.ts 要正常退出：\n${output}`);
  assert.match(output, /\[提示 REPLY_HYGIENE\]/, `终端上必须看得见这条 notice：\n${output}`);
  assert.match(output, /markdown/, '并且说清剔掉了什么（清洗摘要来自引擎）');
  assert.doesNotMatch(output, /\*\*你好\*\*/, 'markdown 记号不许出现在她「说」的那一行里');
});

test('语音入口 voice-turn.ts 把这一轮的 notice 写进产物（preflight ⑧）', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-voice-notice-'));
  const out = join(dir, 'batch.txt');
  try {
    /**
     * 离线转写 = `（离线模拟）` + 这个路径，所以文件名里带一句「只有查过才知道的事实」就能触发
     * `UNBACKED_FACT_CLAIM`：没有工具跑过，而这句话里有可核查的具体数字（湿度 62）。
     * 夹具本身还是那份真实语音（VAD/ASR 走的是同一条离线路）。
     */
    const wav = join(dir, '湿度62.wav');
    copyFileSync(join(REPO_ROOT, 'tests', 'audio-fixtures', 'direct-question.wav'), wav);

    const child = spawn(process.execPath, ['scripts/voice-turn.ts', '--fake', '--wav', wav, '--out', out], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => (output += chunk));
    child.stderr?.on('data', (chunk: string) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => resolve(exitCode));
      setTimeout(() => {
        child.kill();
        resolve(null);
      }, CHILD_TIMEOUT_MS).unref();
    });
    assert.equal(code, 0, `voice-turn.ts 要正常退出：\n${output}`);

    const raw = readFileSync(out, 'utf8');
    const evidence = JSON.parse(raw.slice(raw.indexOf('{'))) as {
      turns: { notices?: readonly { code: string; detail: string }[]; reply: string | null; toolName: string | null }[];
    };
    const turn = evidence.turns[0];
    assert.ok(turn !== undefined, `产物里要有这一轮：\n${output}`);
    assert.equal(turn.toolName, null, '这一轮没有跑任何工具（否则就不是「无据事实」了）');
    const notices = turn.notices ?? [];
    assert.ok(notices.length > 0, `这一轮的 notices 不能是空的：${JSON.stringify(turn).slice(0, 300)}`);
    assert.equal(notices[0]?.code, 'UNBACKED_FACT_CLAIM', `notice 的 code 要指回产生它的原因：${JSON.stringify(notices)}`);
    assert.match(notices[0]?.detail ?? '', /湿度/, 'detail 要带上那段被拦下来的话');
    assert.doesNotMatch(turn.reply ?? '', /湿度/, '被拦下来的事实不许留在「她说的话」里');
    assert.match(output, /\[提示 UNBACKED_FACT_CLAIM\]/, `终端上也看得见：\n${output}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
