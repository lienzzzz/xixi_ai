/**
 * pack v03-preflight ③：`TurnMemoryExtractor.runJob` 里**一条**提取失败会吞掉整轮其它提取。
 *
 * 事实（重构前）：`runJob` 从头到尾只有调用方（`#runSafely`）一层 `try`。任何一步抛错
 * （一个非法属性、一次写库失败、一条坏规则）都会让这一轮**后面所有**提取一起消失 ——
 * 记忆里不会留下任何痕迹，日志里也只有「这一轮失败」。
 *
 * 这条用例让**第一步**（自我模型学习）失败，然后要求后面的每一步都还在：
 *   关系笔记 → 「他提出过这件事」的 episodic → 未完话题的 episodic → 稳定偏好 semantic。
 *
 * 判红方式：修好之前 `runJob` 直接抛出，这条用例以异常失败（不是断言失败）。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TurnMemoryExtractor, type PostTurnJob } from '@xixi/conversation';
import { MemoryStore, openXixiStore, SelfModel, type XixiStore } from '@xixi/domain';

const AT = new Date(2026, 9, 2, 20, 0, 0);

/**
 * 一句话里同时命中三条互不相同的提取路径（顺序就是 `runJob` 的执行顺序）：
 *   1. 反馈规则 `too_talkative`（`你话太多了`）→ 学习 + 关系笔记 + 「他提出过」的 episodic；
 *   2. 未完话题（`明天下午我要去社区医院拿药`）→ plan episodic；
 *   3. 稳定偏好（`我很喜欢喝茉莉花茶`）→ semantic。
 */
const TEXT = '你话太多了。明天下午我要去社区医院拿药。我很喜欢喝茉莉花茶。';

function tempStore(): XixiStore {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-extractor-isolation-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => AT });
  store.seedSelfProfile({ proactivity: 0.85, talkativeness: 0.75, verbosity: 0.7, follow_up_probability: 0.5 });
  return store;
}

test('runJob 隔离单条失败：坏的那条只丢自己，同一轮其它提取照常落库（并且有日志）', () => {
  const store = tempStore();
  try {
    const memory = new MemoryStore(store);
    const realSelf = new SelfModel(store);
    const logged: string[] = [];
    /**
     * 只让**学习**这一步坏掉：这是 `runJob` 的第一步，修好之前它一抛，后面全丢。
     * 其余方法仍走生产实现，所以「后面的步骤真的跑完了」这件事不是替身答的。
     */
    const brokenSelf = {
      learn: (): never => {
        throw new Error('domain: 不认识的人格属性「nope」');
      },
      overrideToday: (...args: Parameters<SelfModel['overrideToday']>) => realSelf.overrideToday(...args),
    } as unknown as SelfModel;

    const extractor = new TurnMemoryExtractor({
      store,
      selfModel: brokenSelf,
      memory,
      onError: (error) => void logged.push(error instanceof Error ? error.message : String(error)),
    });
    const job: PostTurnJob = {
      sessionId: store.createSession().sessionId,
      userText: TEXT,
      replyText: null,
      at: AT,
      userEventId: 'evt_00000000-0000-4000-8000-0000000000ff',
      inferredCode: null,
    };

    const result = extractor.runJob(job);

    // ① 坏的那一步诚实地空着，并且**说得出是哪一步坏了**（日志 = onError 回调）。
    assert.equal(result.learned.length, 0, '学习失败，就没有学习结果');
    assert.ok(result.failures.length > 0, '失败必须出现在结果里，不能只是静默少写几条');
    assert.ok(
      result.failures.some((failure) => /learn/.test(failure.step)),
      `失败的步骤要写清是哪一步：${JSON.stringify(result.failures)}`,
    );
    assert.ok(logged.some((line) => /learn/.test(line)), `坏的那条必须有日志：${JSON.stringify(logged)}`);

    // ② 后面的每一步都还在（这正是修好之前全部丢失的部分）。
    assert.equal(memory.notes({ aspect: 'chat_style' }).length, 1, '关系笔记照常落库');
    assert.equal(memory.episodic({ kind: 'correction', limit: 50 }).length, 1, '「他提出过这件事」照常落库');
    assert.equal(memory.episodic({ kind: 'plan', limit: 50 }).length, 1, '未完话题照常落库');
    assert.equal(memory.semantic({ property: 'preference', limit: 50 }).length, 1, '稳定偏好照常落库');
  } finally {
    store.close();
  }
});
