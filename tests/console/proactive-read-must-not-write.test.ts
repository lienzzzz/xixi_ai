/**
 * pack v03-preflight ②：`GET /api/field/proactive` 是个**读**接口，却会写库。
 *
 * 事实（pack §6 / handoff）：面板状态函数里顺手 `topicEngine.reconcile(at)` ——「先与日志对齐，再报告」。
 * 于是刷新一次页面就在写：提取话题、按回答收口、作废过期话题，而且与常驻考虑循环的 tick 并发跑同一张
 * 投影表。读接口不该写库。
 *
 * 断言分三步，缺一步都会变成空断言：
 *   1. GET 之后**话题表里一条也没有**（直接另开一个连接读库，不信响应里的自述）；
 *   2. 反空断言：同一份日志在**写路径**（POST 演练）之后真的会生出那条话题 —— 说明第 1 步的「空」
 *      是因为读没写，不是因为我种子数据本来就对不齐；
 *   3. 写路径对齐后，响应里的面板状态也看得见它（对齐没有被我顺手关掉）。
 *
 * Run: `npm run test:console`（也在 `npm test` 里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import { openXixiStore } from '@xixi/domain';

import { createFakeProbeRunner, createFieldServer } from '../../scripts/field-test.ts';

/** 时间词 + 意愿 + 动作齐备的一句话 —— `TopicEngine.reconcile` 会把它记成一条未完话题。 */
const HOUSEHOLD_LINE = '明天下午我要去社区医院拿药。';
const SPOKEN_AT = new Date(2026, 9, 2, 8, 0, 0);

const HTTP_TIMEOUT_MS = 30_000;

test('GET /api/field/proactive 不写库：刷新面板不会凭空生出一条未完话题（preflight ②）', { timeout: HTTP_TIMEOUT_MS * 2 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'xixi-read-only-proactive-'));
  // 先把「一句话」写进事件日志（不走 `recordTurn`：那会推进会话状态机，而本用例只关心日志里的那句话）。
  const seed = openXixiStore({ dataDir: root });
  const session = seed.createSession();
  seed.appendEvent(
    buildEvent({
      event_type: 'conversation.turn',
      source: 'test',
      actor: 'father',
      confidence: 1,
      session_id: session.sessionId,
      timestamp: toOffsetIso(SPOKEN_AT),
      payload: { session_id: session.sessionId, turn_index: 1, role: 'user', text: HOUSEHOLD_LINE, action: 'SPEAK' },
    }),
  );
  seed.close();

  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir: root,
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    log: () => {},
  });
  /** 另开一个连接读库：断言的对象是磁盘上的事实，不是响应里的自述。 */
  const inspect = (): { threads: number } => {
    const store = openXixiStore({ dataDir: root });
    try {
      return { threads: store.openThreads({ limit: 10 }).length };
    } finally {
      store.close();
    }
  };
  try {
    const state = (await (await fetch(`${handle.url}/api/field/proactive`)).json()) as Record<string, any>;
    assert.equal(state.ok, true, '状态接口要答得出话');
    assert.deepEqual(state.openThreads?.threads, [], '读接口报告的空话题表，必须真的是空的');
    assert.equal(inspect().threads, 0, '一次 GET 之后，话题表里不许多出任何一行（读接口不写库）');

    // 反空断言 + 写路径仍然对齐：POST 演练是**写**接口，对齐发生在那里。
    const drilled = (await (
      await fetch(`${handle.url}/api/field/proactive/drill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: 'presence_arrived' }),
      })
    ).json()) as Record<string, any>;
    assert.equal(drilled.ok, true, `演练要答得出话：${JSON.stringify(drilled).slice(0, 200)}`);
    assert.equal(inspect().threads, 1, '同一份日志在写路径上确实会生出一条未完话题（说明上一步的「空」不是种子数据的问题）');
    assert.equal(drilled.state?.openThreads?.threads?.length, 1, '写路径返回的面板状态里看得见它');
    assert.equal(drilled.state.openThreads.threads[0].status, 'candidate', '刚提取出来是候选，还没问过');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
