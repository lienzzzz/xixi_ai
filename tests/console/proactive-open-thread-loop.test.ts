/**
 * 跨天的未完话题仍然会被追问（t1，第五轮）。
 *
 * 这条用例守的是**新的装配路径**：`ProactiveLoop` 可以直接拿一个 `TopicEngine`，由循环在每个 tick
 * 里「先对齐再取候选」（提取 → 认下已说出口的 → 按回答收口 → `followUps`），不必让每个调用方各写
 * 一遍 —— 现场测试控制台的 `readOpenThreads` 做的就是这件事，两处必须给出同一批候选。
 *
 * 为什么必须有用例：`open_loop_followup` 候选的**全部**跨天能力都来自「话题表是日志的投影」这件事。
 * 一旦装配写错（忘记 `reconcile`、拿错时钟、把 `followUps` 的候选排在 `limit` 之外），症状是
 * **安静地少说一句话**，日志里不会报错。
 *
 * 时间线（本地时区，与产线同口径）：
 *
 *   第 1 天 08:00  用户说「明天下午我要去社区医院拿药。」→ 提取出一条未完话题，`followAfter` 在
 *                   第 2 天 14:00（`TopicEngine` 的规则：时间词 + 意愿 + 动作三者齐备才记）。
 *   第 2 天 14:00  到点：循环给出 `future_hook_due` / `open_loop_followup` 的追问候选并开口。
 *   第 1 天的 08:00  反例：同一份数据，但时钟停在问之前的第 1 天 —— 不许提前问。
 *
 * Run: `npm run test:console`（也在 `npm test` 里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEvent, toOffsetIso } from '@xixi/contracts';
import { TopicEngine, parseProactiveSettings } from '@xixi/conversation';
import { openXixiStore } from '@xixi/domain';

import { ProactiveLoop } from '../../scripts/field-test.ts';

const HOUSEHOLD_LINE = '明天下午我要去社区医院拿药。';
const SPOKEN_AT = new Date(2026, 9, 2, 8, 0, 0);
const DUE_AT = new Date(2026, 9, 3, 14, 0, 0);

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'xixi-open-thread-loop-'));
  const store = openXixiStore({ dataDir: root });
  const session = store.createSession();
  /**
   * 直接把这一轮写进事件日志，而不是走 `store.recordTurn`：那条路会推进会话状态机（`recordTurn` 是
   * 「一轮对话」的写入点），而本用例要考的是**在对话没开着**的时候，第 1 天说出口的未完话题会不会在
   * 第 2 天被追问。跑在整个测试集里时，别的用例已经在同一个进程里动过状态机，只有自己写事件才可复现
   * （单独跑这条用例时两种写法都过，正是那种「合起来才红」的假阴性）。
   */
  store.appendEvent(
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
  return { root, store, session };
}

function loopAt(at: Date, store: ReturnType<typeof openXixiStore>, sessionId: string): ProactiveLoop {
  return new ProactiveLoop({
    store,
    readSettings: () =>
      parseProactiveSettings({
        enabled: true,
        base_cooldown_min: 0,
        max_per_6h: 10,
        max_per_day: 10,
        quiet_hours: { start: '23:30', end: '07:30' },
      }),
    readState: () => 'IDLE',
    readInFlightTurn: () => false,
    readProactivity: () => 0.85,
    // No presence reading: the only candidate that may speak here is the open thread, so a delivery
    // cannot be credited to 「有人到家」.
    readPresence: async () => null,
    readLastUserTurnAt: () => SPOKEN_AT,
    readSessionId: () => sessionId,
    /** 被测的装配：循环自己持有 `TopicEngine`（等价于控制台的 `readOpenThreads` 先对齐再取）。 */
    topicEngine: new TopicEngine({ store }),
    now: () => at,
    log: () => {},
  });
}

test('a thread said on day 1 is asked about on day 2 after its followAfter (t1)', async () => {
  const { root, store, session } = freshStore();
  try {
    const loop = loopAt(DUE_AT, store, session.sessionId);
    let delivered: { trigger: string; initiativeKind: string } | null = null;
    for (let tick = 0; tick < 30 && delivered === null; tick += 1) {
      const entry = await loop.tickOnce();
      if (entry !== null && entry.reasonCode === 'PASSED') {
        delivered = { trigger: entry.trigger, initiativeKind: entry.initiativeKind };
      }
    }
    assert.notEqual(delivered, null, '第 2 天到点后应当追问第 1 天说过的这件事');
    const outcome = delivered as unknown as { trigger: string; initiativeKind: string };
    assert.equal(outcome.initiativeKind, 'open_loop_followup', '它必须是「接着没聊完的事」，不是泛泛的搭话');
    assert.equal(outcome.trigger, 'future_hook_due', '未完话题走的是时间钩子这条候选路径');

    // 话题本身也随之被标成「已经问过了」——下一步（用户回答）才有东西可以收口。
    const reconciled = new TopicEngine({ store }).reconcile(DUE_AT);
    assert.ok(
      [...reconciled.offered, ...reconciled.created].length >= 1 || store.openThreads({ limit: 10 }).some((thread) => thread.status === 'offered'),
      '追问之后话题必须记成 offered，否则每次 tick 都会再问一遍',
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same facts do not produce a follow-up before its followAfter (t1)', async () => {
  const { root, store, session } = freshStore();
  try {
    // 第 1 天 10:00 —— 那句话是 08:00 说的，`followAfter` 指向第二天下午，现在还不该问。
    const loop = loopAt(new Date(2026, 9, 2, 10, 0, 0), store, session.sessionId);
    for (let tick = 0; tick < 10; tick += 1) {
      const entry = await loop.tickOnce();
      assert.notEqual(entry?.initiativeKind, 'open_loop_followup', `还没到点就追问了：${entry?.reasonCode ?? 'null'}`);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
