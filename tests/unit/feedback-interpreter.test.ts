/**
 * 反馈解释器（pack Phase 4）的规则测试 —— 契约里的三条离线用例就在这里，各一条：
 *
 *   1. 「你可以主动一点」→ 学习到的主动性上升（阈值随之下降）；
 *   2. 「你话太多了」→ **优先降话痨相关参数**（talkativeness/verbosity 降幅远大于 proactivity）；
 *   3. 「今天想安静点」→ 写**会话覆盖**，只对当天生效，次日恢复。
 *
 * 另外钉住两件与铁律 4 有关的事：显式纠正的权重（1.0）高于模型推断（0.4），同一轮里两者都命中
 * 同一属性时**只取显式**；以及《方案》§7.4 的上限（单日累计、累计漂移）真的会削减偏移。
 *
 * Run: `npm test`（unit 也在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { interpretFeedback, interpretFeedbackInput, interpretInference, proactiveThreshold, TurnMemoryExtractor } from '@xixi/conversation';
import { DEFAULT_SELF_MODEL_SETTINGS, openXixiStore, SelfModel, type XixiStore } from '@xixi/domain';

const DAY1 = new Date(2026, 9, 1, 20, 0, 0);
const DAY2 = new Date(2026, 9, 2, 9, 0, 0);

function tempStore(): XixiStore {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-feedback-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => DAY1 });
  // 出厂那套基线（与 config/xixi.example.yaml 的 personality.base 一致）。
  store.seedSelfProfile({ proactivity: 0.85, talkativeness: 0.75, verbosity: 0.7, follow_up_probability: 0.5 });
  return store;
}

/**
 * 把一次反馈真正落到三层里 —— 走**生产实现**（`TurnMemoryExtractor.runJob`），不在这里镜像它。
 *
 * 为什么必须走生产（t10 评审 N2）：这个文件早先自己抄了一遍 runJob 的循环，于是**生产被改坏时这里
 * 仍然全绿** —— 反事实里把 extractor 的落库改回乘过权重的 `deltas`，红的只有集成用例，本文件的
 * 镜像照常通过。现在落库交给真正的 runJob：权重乘几次、用名义值还是视图值，都由生产代码决定。
 *
 * 参数是**原始输入**（用户那句话 / 读空气的白名单码），解释也由 runJob 里的解释器做；调用方仍然
 * 可以先单独断言纯解释器的输出，再拿同一句话走这条生产路径（两条链的结论必须一致）。
 */
function apply(
  store: XixiStore,
  self: SelfModel,
  input: { readonly text?: string; readonly inferredCode?: string },
): ReturnType<typeof interpretFeedback> {
  const extractor = new TurnMemoryExtractor({ store, selfModel: self });
  const result = extractor.runJob({
    sessionId: store.createSession().sessionId,
    userText: input.text ?? '',
    replyText: null,
    at: DAY1,
    userEventId: null,
    inferredCode: input.inferredCode ?? null,
  });
  return result.feedback;
}

test('离线用例①：「你可以主动一点」让学习到的主动性上升，主动阈值随之下降', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store);
    const interpretation = interpretFeedback('你可以主动一点。');
    assert.ok(interpretation !== null, '这句话必须是反馈，而不是普通聊天');
    assert.equal(interpretation.kind, 'more_proactive');
    assert.equal(interpretation.source, 'explicit_correction', '父亲自己说的 → 显式纠正');
    assert.ok((interpretation.deltas['proactivity'] ?? 0) > 0);

    const thresholdBefore = proactiveThreshold(store.selfProfile().proactivity);
    const applied = apply(store, self, { text: '你可以主动一点。' });
    const thresholdAfter = proactiveThreshold(store.selfProfile().proactivity);
    assert.equal(applied?.ruleId, interpretation.ruleId, '同一句话走生产（runJob）必须落到同一条规则上');

    assert.equal(store.selfProfile().proactivity, 0.97, '0.85 + 0.12（《方案》§13.1 的 proactivity +0.12）');
    assert.ok(thresholdAfter < thresholdBefore, `阈值必须下降：${thresholdBefore} → ${thresholdAfter}`);
    assert.equal(thresholdBefore, 0.495);
    assert.equal(thresholdAfter, 0.459);
    // 学习是**有记录**的：§7.5 的 history 里能看到来源与前后值。
    const changes = self.history('proactivity');
    const learned = changes.filter((change) => change.sourceType === 'learned:explicit_correction');
    assert.equal(learned.length, 1);
    assert.equal(learned[0]?.beforeValue, 0.85);
    assert.equal(learned[0]?.afterValue, 0.97);
    assert.equal(self.learned().find((entry) => entry.property === 'proactivity')?.delta, 0.12);
  } finally {
    store.close();
  }
});

test('离线用例②：「你话太多了」优先降话痨相关参数，而不是简单砍 proactivity', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store);
    const interpretation = interpretFeedback('你话太多了。');
    assert.ok(interpretation !== null);
    assert.equal(interpretation.kind, 'too_talkative');
    apply(store, self, { text: '你话太多了。' });

    const effective = store.selfProfile();
    const drop = (before: number, after: number | undefined): number => Math.round((before - (after ?? 0)) * 10_000) / 10_000;
    const talkativenessDrop = drop(0.75, effective.talkativeness);
    const verbosityDrop = drop(0.7, effective.verbosity);
    const proactivityDrop = drop(0.85, effective.proactivity);

    assert.equal(talkativenessDrop, 0.12, '《方案》§13.1：talkativeness −0.12');
    assert.equal(verbosityDrop, 0.1, '§13.1：verbosity −0.10');
    assert.equal(proactivityDrop, 0.02, '§13.1：proactivity 只降 −0.02');
    assert.ok(
      talkativenessDrop + verbosityDrop > proactivityDrop * 5,
      `话痨参数的降幅必须远大于 proactivity：${talkativenessDrop}+${verbosityDrop} vs ${proactivityDrop}`,
    );
    assert.equal(proactiveThreshold(effective.proactivity), 0.501, '主动性几乎没动：0.45 + 0.3 × (1 − 0.83)');
  } finally {
    store.close();
  }
});

test('离线用例③：「今天想安静点」写会话覆盖，只对当天生效，次日恢复', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store);
    const interpretation = interpretFeedback('今天想安静点。');
    assert.ok(interpretation !== null);
    assert.equal(interpretation.kind, 'quiet_today');
    assert.deepEqual(interpretation.deltas, {}, '这是**当天**的要求，不是长期人设：不该写学习层');
    assert.ok(Object.keys(interpretation.sessionDeltas).length > 0);
    apply(store, self, { text: '今天想安静点。' });

    const today = store.selfProfile({ now: DAY1 });
    assert.equal(today.proactivity, 0.55, '0.85 − 0.30（《方案》§13 的例子）');
    assert.equal(today.talkativeness, 0.5, '0.75 − 0.25');
    assert.equal(today.verbosity, 0.5, '0.7 − 0.20');
    assert.equal(self.overrides(DAY1).length, 3, '三条当天覆盖都落了库');
    assert.equal(self.learned().length, 0, '学习层必须是空的');

    // 次日：覆盖失效，回到基础层（+学习层，本例为空）。
    const tomorrow = store.selfProfile({ now: DAY2 });
    assert.equal(tomorrow.proactivity, 0.85);
    assert.equal(tomorrow.talkativeness, 0.75);
    assert.equal(tomorrow.verbosity, 0.7);
    assert.equal(self.overrides(DAY2).length, 0, '次日自动失效，不需要定时任务');
    // 覆盖只写在当天那一行上，历史里仍能查到它发生过。
    assert.ok(self.history('proactivity').some((change) => change.sourceType === 'session_override:explicit_correction'));
  } finally {
    store.close();
  }
});

test('显式纠正的权重高于模型推断，且同一轮里只取显式', () => {
  const explicit = interpretFeedback('你话太多了。');
  const inferred = interpretInference('user_quiet');
  assert.ok(explicit !== null && inferred !== null);
  assert.equal(explicit.weight, 1);
  assert.equal(inferred.weight, 0.4, '模型推断的权重必须低于显式纠正（铁律 4）');
  assert.equal(inferred.source, 'model_inference');
  assert.equal(inferred.nominalDeltas['proactivity'], -0.05, '名义值就是《方案》§13.1 里那个数，没有乘权重');
  assert.equal(inferred.deltas['proactivity'], -0.02, '乘过权重的视图：0.05 × 0.4 = 0.02，落在 §7.4 的 0.01~0.03 内');
  assert.equal(explicit.nominalDeltas['talkativeness'], -0.12, '显式的权重是 1.0，两份值一样');
  assert.equal(explicit.deltas['talkativeness'], -0.12);
  assert.ok(Math.abs(explicit.deltas['talkativeness'] ?? 0) > Math.abs(inferred.deltas['proactivity'] ?? 0));

  // 两个输入同时存在：只取显式，推断被丢弃（不是叠加）。
  const both = interpretFeedbackInput({ text: '你话太多了。', inferredCode: 'user_quiet' });
  assert.ok(both !== null);
  assert.equal(both.source, 'explicit_correction');
  assert.equal(both.ruleId, 'too_talkative');
  assert.equal(both.deltas['proactivity'], -0.02, '若叠加会是 −0.04');

  // 只有推断时它才生效，而且量级很小。
  const onlyInferred = interpretFeedbackInput({ inferredCode: 'user_quiet' });
  assert.equal(onlyInferred?.source, 'model_inference');
  assert.equal(onlyInferred?.deltas['proactivity'], -0.02);
});

test('推断落库只乘一次权重：名义 −0.05 → 落库 −0.02（不是 0.4 × 0.4）', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store);
    const inferred = interpretFeedbackInput({ inferredCode: 'user_quiet' });
    assert.ok(inferred !== null);
    // 与生产（`TurnMemoryExtractor.runJob` → `SelfModel.learn`）同一条路：名义值进，权重在自我模型那层乘。
    // 这一句现在是**生产路径本身**：把 extractor 的落库改回乘过权重的 `deltas`，下面两条断言会红
    // （t10 评审 N2：改造之前这里本地镜像 runJob，那种改动它一条都抓不住）。
    apply(store, self, { inferredCode: 'user_quiet' });
    assert.equal(self.learned().find((entry) => entry.property === 'proactivity')?.delta, -0.02, '0.05 × 0.4');
    assert.equal(self.learned().find((entry) => entry.property === 'talkativeness')?.delta, -0.012, '0.03 × 0.4');
    assert.equal(store.selfProfile().proactivity, 0.83);
    // 证据里存的是白名单码，不是模型的自由文本（铁律 5）。
    const change = self.history('proactivity').find((entry) => entry.sourceType === 'learned:model_inference');
    assert.match(change?.summary ?? '', /inferred:user_quiet/);
  } finally {
    store.close();
  }
});

test('推断只认白名单码：自由文本与无关码都不产生偏移', () => {
  assert.equal(interpretInference('我觉得他今天心情不错'), null, '自由文本一律不认（铁律 5）');
  assert.equal(interpretInference('good_moment'), null, '白名单里没有偏移含义的码不学习');
  assert.equal(interpretInference('user_busy')?.deltas['proactivity'], -0.02);
  assert.equal(interpretInference('already_said')?.deltas['old_topic_resurface'], -0.02);
  assert.equal(interpretInference(null), null);
});

test('普通聊天不是反馈：不要为了「有学习」把每一句都当纠正', () => {
  for (const text of ['今天过得怎么样？', '明天天气怎么样？', '嗯，好。', '我吃过了。', '这电视挺吵的。', '']) {
    assert.equal(interpretFeedback(text), null, `「${text}」不该被当成反馈`);
  }
  // 正例仍然认得出来（免得上面的断言把规则全关掉）。
  assert.equal(interpretFeedback('你以后主动一点行不行')?.kind, 'more_proactive');
  assert.equal(interpretFeedback('别老主动找我说话')?.kind, 'less_proactive');
});

test('《方案》§7.4 的上限：单日累计 ±0.15、累计漂移 ±0.30', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store);
    const first = self.learn({ property: 'talkativeness', delta: -0.12, sourceType: 'explicit_correction', at: DAY1 });
    assert.equal(first.applied, -0.12);
    assert.equal(first.clampedByDailyLimit, false);

    // 同一天再抱怨一次：单日累计只能到 −0.15，所以第二次只落 −0.03。
    const second = self.learn({ property: 'talkativeness', delta: -0.12, sourceType: 'explicit_correction', at: DAY1 });
    assert.equal(second.applied, -0.03);
    assert.equal(second.clampedByDailyLimit, true);
    assert.equal(self.learned().find((entry) => entry.property === 'talkativeness')?.delta, -0.15);

    // 次日额度恢复。
    const third = self.learn({ property: 'talkativeness', delta: -0.12, sourceType: 'explicit_correction', at: DAY2 });
    assert.equal(third.applied, -0.12);
    assert.equal(third.clampedByDailyLimit, false);
    assert.equal(self.learned().find((entry) => entry.property === 'talkativeness')?.delta, -0.27);

    // 累计漂移上限：把上限调小就能看到它削减（同一个属性不会因为反复抱怨被拉到极端）。
    const narrow = new SelfModel(store, { ...DEFAULT_SELF_MODEL_SETTINGS, driftLimit: 0.2 });
    const drifted = narrow.learn({ property: 'verbosity', delta: -0.15, sourceType: 'explicit_correction', at: DAY1 });
    assert.equal(drifted.applied, -0.15);
    const capped = narrow.learn({ property: 'verbosity', delta: -0.15, sourceType: 'explicit_correction', at: DAY2 });
    assert.equal(capped.clampedByDriftLimit, true);
    assert.equal(capped.after, -0.2, '累计停在 drift_limit');
  } finally {
    store.close();
  }
});

test('推断反馈走的是更小的单日额度（§7.4：隐式单次最多 ±0.03）', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store);
    const first = self.learn({ property: 'proactivity', delta: -0.05, sourceType: 'model_inference', at: DAY1 });
    assert.equal(first.applied, -0.02, '0.05 × 0.4');
    const second = self.learn({ property: 'proactivity', delta: -0.05, sourceType: 'model_inference', at: DAY1 });
    assert.equal(second.applied, -0.01, '推断的单日额度只有 0.03');
    assert.equal(second.clampedByDailyLimit, true);
    const third = self.learn({ property: 'proactivity', delta: -0.05, sourceType: 'model_inference', at: DAY1 });
    assert.equal(third.applied, 0, '额度用完就不再学');
  } finally {
    store.close();
  }
});

test('学习可以回滚，而且回滚本身也留记录', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store);
    self.learn({ property: 'proactivity', delta: 0.12, sourceType: 'explicit_correction', at: DAY1 });
    assert.equal(store.selfProfile().proactivity, 0.97);
    const rolled = self.rollback('proactivity', 'test:rollback');
    assert.equal(rolled.applied, -0.12);
    assert.equal(store.selfProfile().proactivity, 0.85);
    assert.equal(self.learned().find((entry) => entry.property === 'proactivity')?.delta, 0);
    assert.ok(self.history('proactivity').some((change) => change.sourceType === 'learned:rollback'));
  } finally {
    store.close();
  }
});

test('关掉学习开关后不再学习（已有偏移保持原样）', () => {
  const store = tempStore();
  try {
    const self = new SelfModel(store, { ...DEFAULT_SELF_MODEL_SETTINGS, learningEnabled: false });
    const result = self.learn({ property: 'proactivity', delta: 0.12, sourceType: 'explicit_correction', at: DAY1 });
    assert.equal(result.applied, 0);
    assert.equal(store.selfProfile().proactivity, 0.85);
    assert.equal(self.learned().length, 0);
  } finally {
    store.close();
  }
});
