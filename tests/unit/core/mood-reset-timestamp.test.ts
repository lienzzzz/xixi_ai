/**
 * pack v03-preflight ④：`store.resetMood(reason, at)` 的**时间戳归一**。
 *
 * 事实（第五轮 t7 独立复验实测）：`mood_history.created_at` 是字符串列，`moodHistory()` 按
 * `ORDER BY created_at DESC` 取行。生产路径写的是本地偏移（`toOffsetIso` → `+08:00`），
 * 但只要有人传一个 `Z` 写法（`Date#toISOString()`），同一张表里就混进了两种写法 ——
 * 字符串序与时刻序**不一致**：`…T14:00:00.000Z`（= 本地 22:00，更新的那一条）会排在
 * `…T21:00:00.000+08:00`（本地 21:00，更早的那一条）前面，`moodHistory()` 于是把「最新一条」报成了旧的那条。
 *
 * 这条用例用**确切的两个时刻**钉住序：老的那条 21:00，复位那条 22:00（写成 `Z`）。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { toOffsetIso } from '@xixi/contracts';
import { openXixiStore } from '@xixi/domain';

const EARLIER = new Date(2026, 9, 1, 21, 0, 0);
const LATER = new Date(2026, 9, 1, 22, 0, 0);

test('resetMood 收到 Z 写法时也归一成本地偏移：moodHistory 的字符串序 == 时刻序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-mood-zulu-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => LATER });
  try {
    store.recordMood({
      state: { valence: 0.2, energy: 0.3 },
      previous: { valence: 0.5, energy: 0.5 },
      source: 'mood:signals',
      summary: '先来一条旧的心情变化',
      signals: {},
      signalCount: 0,
      evidence: {},
      at: toOffsetIso(EARLIER),
    });
    // 复位那一刻晚一小时，但**用 Z 写法**传进来（复验里翻车的那种用法）。
    store.resetMood('probe:zulu', LATER.toISOString());

    const history = store.moodHistory(10);
    assert.equal(Date.parse(history.at(-1)?.createdAt ?? ''), LATER.getTime(), '归一不许改变时刻本身');
    assert.deepEqual(
      history.map((change) => change.createdAt),
      [toOffsetIso(EARLIER), toOffsetIso(LATER)],
      '老→新的顺序必须按时刻，不能按字符串',
    );
    // 归一的可观察形态：同一次写入之后，这一列只有一种写法（同一个偏移后缀）。
    const suffixes = new Set(history.map((change) => change.createdAt.slice(-6)));
    assert.equal(suffixes.size, 1, `create_at 混了两种写法：${[...suffixes].join('、')}`);
    assert.equal(history.at(-1)?.reset, true, '最新一条就是那次复位');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
