import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CliDshTransport, parseDshJsonLines, resolveDshBinJs } from '@xixi/brain-dsh';
import { BrainError, type DshTurnRequest } from '@xixi/brain-adapter';

const SAMPLE = [
  '{"type":"session","sessionId":"session-abc","cwd":"E:\\\\worker2"}',
  'dsh: some diagnostic that is not JSON',
  '{"type":"status","phase":"turn_start","turn":1}',
  '{"type":"tool_call","callId":"call_1","tool":"xixi_get_current_time","input":{}}',
  '{"type":"tool_result","callId":"call_1","status":"completed","result":"2026-09-29T15:11:16.676Z"}',
  '{"type":"final","text":"2026-09-29T15:11:16.676Z"}',
  '',
].join('\n');

test('dsh --json output is parsed without guessing at unknown events', () => {
  const parsed = parseDshJsonLines(SAMPLE);
  assert.equal(parsed.sessionId, 'session-abc');
  assert.equal(parsed.finalText, '2026-09-29T15:11:16.676Z');
  assert.deepEqual(parsed.toolCalls, [{ tool: 'xixi_get_current_time', callId: 'call_1' }]);
  assert.equal(parsed.errorMessage, null);
  assert.deepEqual(parsed.eventTypes, ['session', 'status', 'tool_call', 'tool_result', 'final']);
  assert.equal(parsed.raw.length, 5, 'non-JSON diagnostics must not become events');
});

test('a harness error event is surfaced as the failure reason', () => {
  const parsed = parseDshJsonLines(
    ['{"type":"session","sessionId":"session-x"}', '{"type":"error","message":"MISSING_CREDENTIAL: no credential"}', '{"type":"final","text":""}'].join(
      '\n',
    ),
  );
  assert.equal(parsed.errorMessage, 'MISSING_CREDENTIAL: no credential');
  assert.equal(parsed.finalText, '');
});

test('the composed harness task carries identity, personality, timezone and working memory', () => {
  const request: DshTurnRequest = {
    kind: 'turn',
    requestId: 'req_1',
    sessionId: 'sess_1',
    resumeBrainSessionId: null,
    text: '明天天气怎么样？',
    // No pre-composed task: this request is what `composeTask` is about to build one from.
    task: null,
    context: {
      identityName: '西西',
      personality: { proactivity: 0.55, warmth: 0.8 },
      timezone: 'Asia/Shanghai',
      workingMemory: [
        { role: 'user', text: '昨天说到去镇上' },
        { role: 'assistant', text: '记得' },
      ],
    },
  };
  const task = CliDshTransport.composeTask(request);
  assert.ok(task.includes('身份：西西'));
  assert.ok(task.includes('proactivity=0.55'));
  assert.ok(task.includes('Asia/Shanghai'));
  assert.ok(task.includes('用户：昨天说到去镇上'));
  assert.ok(task.includes('西西：记得'));
  assert.ok(task.endsWith('明天天气怎么样？'));
});

test('an explicitly wrong harness path fails with a typed error instead of spawning nothing', () => {
  assert.throws(
    () => resolveDshBinJs(join(dirname(process.execPath), 'definitely-not-here', 'bin.js')),
    (error: unknown) => error instanceof BrainError && error.code === 'TRANSPORT_FAILED',
  );
});

test('a missing harness cwd is refused at construction time', () => {
  const binJs = resolveDshBinJs();
  assert.ok(existsSync(binJs), 'the installed dsh entry point should be discoverable for local verification');
  assert.throws(
    () => new CliDshTransport({ dshHome: 'E:\\worker2\\.dsh', profile: 'xixi', cwd: 'E:\\definitely-missing-dir' }),
    (error: unknown) => error instanceof BrainError && error.code === 'TRANSPORT_FAILED',
  );
});
