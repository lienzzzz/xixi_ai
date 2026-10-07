import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flattenPrompt } from '@xixi/brain-adapter';
import { moodProse } from '@xixi/domain';
import {
  CORE_IDENTITY,
  HARD_POLICY,
  MEMORY_SECTION_HEADING,
  PromptAssembler,
  personalityDirectives,
  SILENCE_TOKEN,
  WRITE_OPERATION_RULE,
  worldStateLite,
} from '@xixi/conversation';

const assembler = new PromptAssembler();

function input(overrides: Partial<Parameters<PromptAssembler['assemble']>[0]> = {}) {
  return {
    identityName: '西西',
    personality: { verbosity: 0.4, formality: 0.15, warmth: 0.8 },
    world: worldStateLite(new Date('2026-09-29T23:10:00+08:00'), 'Asia/Shanghai', 480),
    conversationState: 'ACTIVE',
    turnIndex: 1,
    history: [
      { role: 'user' as const, text: '西西，明天天气怎么样？' },
      { role: 'assistant' as const, text: '明天有雨，出门带把伞。' },
    ],
    userText: '那后天呢？',
    ...overrides,
  };
}

test('the system prompt carries the identity, the compact safety block and the effective style', () => {
  const prompt = assembler.assemble(input());
  assert.ok(prompt.system.includes(CORE_IDENTITY));
  assert.ok(prompt.system.includes(HARD_POLICY));
  assert.ok(prompt.system.includes(SILENCE_TOKEN), 'the silence channel must be stated where the model can see it');
  assert.ok(prompt.system.includes('你现在按这些话来说'), 'the effective speaking style must be injected (§26.1)');

  // P1: the personality reaches the model as described behaviour, never as raw numbers.
  assert.doesNotMatch(
    prompt.system,
    /(?:verbosity|talkativeness|curiosity|formality|humor|warmth|directness|silence_tolerance|proactivity)\s*=/,
    'no bare personality floats may appear in the prompt (P1)',
  );
});

test('the identity reads as a person, not as a numbered must / must-not list (P1)', () => {
  // The V0.1 form was a numbered rule list ("1. 说话像家里人… 7. 可核查的具体事实…"); that
  // checklist shape is part of why every turn came out the same 2–3 sentences (baseline §2.3).
  assert.equal((CORE_IDENTITY.match(/^\d+\. /gm) ?? []).length, 0, 'no numbered rules in the identity');
  assert.equal((CORE_IDENTITY.match(/^\s*[-*·]\s/gm) ?? []).length, 0, 'and no bullet list either');
  assert.doesNotMatch(CORE_IDENTITY, /严禁|必须/, 'the identity states how she talks, not a compliance list');

  // …and it still says the things the realism design (§03_REALISM_DESIGN) needs, in prose.
  assert.match(CORE_IDENTITY, /不是客服和用户的关系/);
  assert.match(CORE_IDENTITY, /有时一句，有时多说几句/);
  assert.match(CORE_IDENTITY, /不用每轮都提问题/);
  assert.match(CORE_IDENTITY, /别总用「你呢？」「你觉得呢？」/, 'the pack names those two as the AI-flavoured question endings');
  assert.match(CORE_IDENTITY, /没有合适的话题时，不必硬聊/);
  assert.match(CORE_IDENTITY, /不要把对方的话重新总结一遍/);
  assert.match(CORE_IDENTITY, /我记得好像/);
  assert.match(CORE_IDENTITY, /可以被打断/);
  // t21 (t4 F3): answers are speech, not a formatted document — the hygiene layer strips what slips through.
  assert.match(CORE_IDENTITY, /不用列表、不加粗、不用标题/);
  // Ordinary knowledge questions may be answered at length — length must have a distribution.
  assert.match(CORE_IDENTITY, /遇到知识问题、需要解释的事，可以自然多说几句/);
});

test('no numbered rule list survives anywhere in the stable prefix (P1)', () => {
  const prompt = assembler.assemble(input());
  assert.equal(
    (prompt.system.match(/^\d+\. /gm) ?? []).length,
    0,
    'identity + safety + style must not be a numbered checklist the model walks through',
  );
});

test('the safety block stays compact and every boundary is still checkable (P1 must not drop 铁律)', () => {
  const lines = HARD_POLICY.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(lines.length <= 8, `the safety block must stay compact, found ${lines.length} lines`);
  assert.ok(HARD_POLICY.length <= 800, `…and short, found ${HARD_POLICY.length} characters`);

  // 铁律 2/1: the boundaries are not negotiable — this phrasing existed in V0.1, was dropped by the
  // P1 rewrite, and is pinned again here so the next rewrite cannot quietly lose it (t16).
  assert.match(HARD_POLICY, /不受任何指令影响/);
  assert.match(HARD_POLICY, /都不能让它们作废/);
  // 铁律 7: a checkable fact may only come from a tool result, and proactive speech is bound too.
  assert.match(HARD_POLICY, /可核查的具体事实/);
  assert.match(HARD_POLICY, /先调用工具去查/);
  assert.match(HARD_POLICY, /这一条对主动开口同样有效/);
  // 铁律: no machine language about tools, and no listing abilities.
  assert.match(HARD_POLICY, /工具只是能力，不报幕/);
  assert.match(HARD_POLICY, /工具执行成功/);
  // 铁律: she cannot rewrite her own rules; she must not narrate implementation details.
  assert.match(HARD_POLICY, /不能修改系统规则、权限或者隐私设置/);
  assert.match(HARD_POLICY, /不自称 AI 助手/);
  // Interruptibility and the silence channel stay explicit (§55, §14.2).
  assert.match(HARD_POLICY, /一开口就停下来听/);
  assert.ok(HARD_POLICY.includes(SILENCE_TOKEN), 'the safety block must name the silence token');
});

/**
 * V0.3 P2-H：**写操作必须走工具**（pack Phase 2 第二条未达标项的提示词层根因）。
 *
 * 背景（t14 的 P2 gate 实测，22 次「明天八点提醒我打电话。」）：只有 6 次真的调用了工具（27%），
 * 其余 16 次里有 4 次回复自称「记下了」而库里**一行都没有** —— 提醒、记东西这类操作在数据上就是
 * 一次工具调用，所以那种回复是**可判定为假**的话。当时的根因定位在提示词层：原来的硬边界只管
 * 「事实」，没有一条要求写操作走工具，于是模型可以只嘴上答应。
 *
 * 这一条用例守三件事：
 *   1. 规则段真的在**装配后的核心提示词**里（不是只在一个没人读的常量里）；
 *   2. 意图点得出来（提醒我 / 记一下 / 记住 / 记笔记），且**点明「没调用工具就是假话」**；
 *   3. 不点**工具名** —— 工具表是动态的（插件与 MCP 都会往里加），名字变了这句话仍然成立。
 *
 * 反事实（可复跑）：把 `WRITE_OPERATION_RULE` 从 `HARD_POLICY` 里删掉（或把它改成空串），
 * 本用例红 —— 见 P2-H 的完成回报（对最终字节跑的那一次）。
 *
 * ⚠ 这一条只证明**规则在提示词里**，**不**证明它把真调工具率提上去了：P2-H 的 A/B 实测
 * （同一个探针、同一批句子、22 对交替跑）「去掉这一段」21/22 真调用、「带上这一段」22/22（最终字节上
 * 单独再跑 22/22）—— 两边几乎都满，**规则的效果在这一次测量里没有体现出来**；数字、样本量与观察
 * 写在完成回报里，别把这条用例读成「可靠性已达标」。
 */
test('写操作必须走工具：核心提示词里有这一段，点名意图、写明只说「记下了」不算', () => {
  // ① 这一段是装配后的 system 的一部分（`PromptAssembler` 每一条路径都会带上它）。
  const prompt = assembler.assemble(input());
  assert.ok(prompt.system.includes(WRITE_OPERATION_RULE), '核心提示词里必须有这一段');
  assert.ok(HARD_POLICY.includes(WRITE_OPERATION_RULE), '它是硬边界的一段，不是挂在别处的旁支');
  const safety = prompt.sections.find((section) => section.name === 'safety-policy');
  assert.ok(safety !== undefined && safety.part === 'system', '它随 safety-policy 段进稳定前缀');
  assert.ok((safety?.text ?? '').includes(WRITE_OPERATION_RULE), '段正文里逐字包含它');

  // ② 点名属于写操作的意图，并写清「只回一句记下了」的后果。
  for (const intent of ['提醒我', '记一下', '记住', '记笔记']) {
    assert.match(WRITE_OPERATION_RULE, new RegExp(intent, 'u'), `写操作意图要点名：${intent}`);
  }
  assert.match(WRITE_OPERATION_RULE, /没有调用工具/u, '要写明判据是「有没有调用工具」，不是「说得好不好听」');
  assert.match(WRITE_OPERATION_RULE, /那句话就是假的/u, '要写明「只回一句记下了」是一句假话（用户看得见的后果）');
  assert.match(WRITE_OPERATION_RULE, /只有工具真的写成功才算数/u, '要写明什么叫「做到了」');

  // ③ 措辞不点工具名：名字随工具表变，规则不该跟着漂。
  assert.doesNotMatch(WRITE_OPERATION_RULE, /xixi_|set_reminder|tools?\b/iu, '不许把工具名写进核心提示词');

  // ④ 这一段也在**下一次装配**里（提示词是每轮重算的，规则不能只在第一次出现）。
  const second = assembler.assemble(input({ userText: '（自言自语）', conversationState: 'ACTIVE', turnIndex: 9 }));
  assert.ok(second.system.includes(WRITE_OPERATION_RULE), '之后的每一轮读到的还是同一段规则');
});

/**
 * 存量守卫：加这一段**不许**把硬边界撑成一张长长的清单 —— 上面那条上限（8 行 / 800 字、
 * 既有断言一字未改）就是 P1 定的「短到能被模型读完」，写操作那条是**塞进**这两条之内的。
 */
test('写操作规则加进来之后，硬边界仍然短（行数与字数的上限照旧）', () => {
  const lines = HARD_POLICY.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(lines.length <= 8, `硬边界必须仍然紧凑，现有 ${lines.length} 行`);
  assert.ok(HARD_POLICY.length <= 800, `…而且仍然短，现有 ${HARD_POLICY.length} 字`);
  assert.ok(lines.some((line) => line.startsWith(WRITE_OPERATION_RULE.slice(0, 12))), '它就是其中一行');
});

/**
 * V0.3 P1 改写了硬边界的第一条（pack `docs/02_MEMORY_CONTEXT.md` §4）。
 *
 * 旧写法「可核查事实只能来自工具或刚刚说的信息」与长期记忆召回**直接冲突**（审计 §3.2）：
 * 系统一旦真的把带 provenance 的记忆放进提示词，那句话就等于让模型读到的记忆「不能当事实用」。
 * 这条用例同时钉住两件必须一起成立的事：
 *   * 新写法把第三个来源（系统提供的可信记忆 / 世界状态）明确纳入；
 *   * **来源约束没有被放宽** —— 模型自己「好像记得」的内容仍然不许当事实，而且引用系统给的记忆
 *     时必须按 confidence / freshness 表达不确定。
 */
test('硬边界按 pack §4 改写：可信记忆是第三个允许的来源，但来源约束与不确定性表达都还在', () => {
  assert.match(HARD_POLICY, /只能来自三处/, '三个来源必须写清');
  assert.match(HARD_POLICY, /系统在上面给你的可信记忆或世界状态/, '第三个来源就是它');
  assert.match(HARD_POLICY, /你自己「好像记得」的内容不算事实/, '模型自己的记忆不是事实来源（铁律 4）');
  assert.match(HARD_POLICY, /标了较确定才当事实/, '按 confidence 表达不确定');
  assert.match(HARD_POLICY, /标了有点旧就当作可能已经变了/, '按 freshness 表达不确定');
  // 旧措辞不许回潮：它会让「记忆进了提示词」与「不许当事实用」同时成立，那是自相矛盾的。
  assert.doesNotMatch(HARD_POLICY, /只能来自工具结果或对方刚刚明确说的信息/);
});

test('personality changes the directives, which is what makes feedback verifiable in behaviour', () => {
  const terse = personalityDirectives({ verbosity: 0.1, curiosity: 0.1, silence_tolerance: 0.9 });
  const chatty = personalityDirectives({ verbosity: 0.95, curiosity: 0.9, silence_tolerance: 0.2 });
  assert.ok(terse.some((line) => line.includes('偏简短')));
  assert.ok(chatty.some((line) => line.includes('愿意多说几句')));
  assert.ok(terse.some((line) => line.includes('沉默')));
  assert.notDeepEqual(terse, chatty);

  // P1: every directive is a sentence about how she talks — no digits, no parameter names.
  for (const line of [...terse, ...chatty, ...personalityDirectives({ verbosity: 0.5 })]) {
    assert.doesNotMatch(line, /\d/, `a directive must not carry numbers: ${line}`);
    assert.doesNotMatch(
      line,
      /verbosity|talkativeness|curiosity|formality|humor|warmth|directness|silence_tolerance|proactivity/,
      `a directive must not name a parameter: ${line}`,
    );
  }
});

test('pack Phase 4：学习到的人格偏移会真的改掉提示词里的说话方式', () => {
  // 「你话太多了」之后的出厂基线（talkativeness 0.75 → 0.63、verbosity 0.7 → 0.6）：
  // talkativeness 掉到 0.65 以下，提示词里那句「可以主动接话」就该消失。
  const before = personalityDirectives({ talkativeness: 0.75, verbosity: 0.7 });
  const after = personalityDirectives({ talkativeness: 0.63, verbosity: 0.6 });
  assert.ok(before.some((line) => line.includes('可以主动接话')), '学习之前鼓励主动接话');
  assert.ok(!after.some((line) => line.includes('可以主动接话')), `学习之后不该再鼓励：${JSON.stringify(after)}`);
  assert.notDeepEqual(before, after, '反馈必须在行为上可验证，而不是只改了一个数');
});

test('the model-visible prompt separates the stable prefix from the changing suffix', () => {
  const first = assembler.assemble(input({ turnIndex: 1, userText: '那后天呢？' }));
  const second = assembler.assemble(input({ turnIndex: 2, userText: '知道了' }));
  assert.equal(first.system, second.system, 'the system prefix must stay byte-identical for prompt caching (§46.3)');
  assert.notEqual(first.user, second.user);

  // The changing part still has to carry enough context to answer coherently.
  assert.ok(second.user.includes('【当前情境】'));
  assert.ok(second.user.includes('知道了'), 'the current turn must be present');
  assert.ok(!second.user.includes('那后天呢？'), 'a previous turn must not leak into the current-turn section');
  assert.equal(second.history.length, 2);
});

test('prior turns travel as messages only — never expanded into the prompt text again (P1)', () => {
  const prompt = assembler.assemble(input());
  assert.deepEqual(prompt.history, [
    { role: 'user', content: '西西，明天天气怎么样？' },
    { role: 'assistant', content: '明天有雨，出门带把伞。' },
  ]);
  assert.ok(!prompt.user.includes('明天天气怎么样？'), 'the earlier user turn must not be repeated as text');
  assert.ok(!prompt.user.includes('明天有雨，出门带把伞。'), 'the earlier reply must not be repeated as text');
  assert.ok(!prompt.system.includes('明天天气怎么样？'), 'nor in the stable prefix');
  assert.ok(
    !prompt.sections.some((section) => section.text.includes('明天天气怎么样？')),
    'the debug sections must not carry a second text copy either — the Debug UI reads `history`',
  );
});

test('the flattened task carries each prior turn exactly once (P1: no second copy)', () => {
  // `flattenPrompt` is the seam the DSH harness path uses (§26: system + transcript + user);
  // the direct MiMo path sends the same history as real messages instead. Either way each turn
  // must appear once — V0.1 had it twice, once as messages and once inside `user`.
  const prompt = assembler.assemble(input());
  const flat = flattenPrompt(prompt);
  assert.equal(flat.split('明天天气怎么样？').length - 1, 1, 'the earlier user turn appears exactly once');
  assert.equal(flat.split('明天有雨，出门带把伞。').length - 1, 1, 'the earlier reply appears exactly once');
  assert.ok(flat.includes(prompt.system), 'the stable prefix is still there');
  assert.ok(flat.includes(prompt.user), 'and so is the current turn');
});

test('the context block tells the model when it is, including time of day', () => {
  const lateNight = assembler.assemble(input({ world: worldStateLite(new Date('2026-09-29T23:40:00+08:00'), 'Asia/Shanghai', 480) }));
  const morning = assembler.assemble(input({ world: worldStateLite(new Date('2026-09-29T08:10:00+08:00'), 'Asia/Shanghai', 480) }));
  assert.ok(lateNight.user.includes('深夜'));
  assert.ok(morning.user.includes('清早') || morning.user.includes('上午'));
  assert.ok(lateNight.user.includes('周二'));
  assert.ok(morning.user.includes('+08:00'), 'timestamps keep an explicit offset');
});

/**
 * V0.3 P2.5-J 修的第一个缺口：`ContextBuilder` 算出来的世界状态进不了提示词。
 *
 * 装配器现在有两种世界状态来源，**互斥**：
 *   * `worldState`（来自 `ContextBuilder.render().worldLines`，含在场判断）—— 有它就用它；
 *   * `world`（`worldStateLite`，只有时间 / 时区 / 时段 / 星期）—— 只在没有上下文层时被读。
 *
 * 这一条用例压两件事：世界行**真的**进了 `user` 与 `world-state` 段；时间与星期**不重复**
 * （两条路同时拼进去就会出现两遍「现在：」）。反事实：把 `worldState` 分支删掉 → 前三组断言红；
 * 把两条路改成「都拼」→ 「只出现一次」那组红。
 */
test('世界状态那一段：上下文层给了行就用它，轻量写法只在没有上下文层时兜底（时间与星期不重复）', () => {
  const contextLines = [
    '现在：2026-09-29T23:10:00.000+08:00（Asia/Shanghai）',
    '时段：深夜　星期：周二',
    '在场：他这会儿在家。',
    '- 家里常说的地点：成都',
  ];
  const connected = assembler.assemble(input({ worldState: { lines: contextLines } }));

  assert.ok(connected.user.includes('在场：他这会儿在家。'), `在场判断必须进提示词：\n${connected.user}`);
  // 渲染器给附行时自带 `- `，装配器再加一次就是 `- - …`：这里压住归一化。
  assert.ok(connected.user.includes('- 家里常说的地点：成都'), '附行只有一个前缀');
  assert.equal(connected.user.includes('- - '), false, '不许出现双重前缀');

  // 不重复：上下文层的行替代（而不是叠加在）轻量写法上。
  for (const marker of ['现在：', '时段：', '星期：', '周二']) {
    assert.equal(connected.user.split(marker).length - 1, 1, `「${marker}」只许出现一次：\n${connected.user}`);
  }
  // 段本身仍叫 world-state、仍在同一个位置（Debug UI 按名字与顺序核对）。
  assert.deepEqual(connected.sections.map((section) => section.name), ['core-identity', 'safety-policy', 'effective-style', 'world-state', 'current-turn']);
  const worldSection = connected.sections.find((section) => section.name === 'world-state');
  assert.ok(worldSection !== undefined);
  assert.ok(worldSection.text.includes('在场：他这会儿在家。'), '面板读的段正文里也有它');
  assert.equal(worldSection.text.split('\n')[0], contextLines[0], '段正文用的是上下文层那一行，且不带 `- `');

  // 没有上下文层时逐字回到从前：轻量写法那两行 + 没有在场。
  const bare = assembler.assemble(input());
  assert.equal(bare.user.includes('在场'), false, '没有上下文层就没有在场判断');
  assert.equal(bare.user.split('现在：').length - 1, 1);
  assert.equal(bare.user.split('星期：').length - 1, 1);
  assert.ok(bare.user.includes('时段：深夜　星期：周二'), '轻量写法本身一字未改');

  // 上下文层给了空数组时也一样回退（世界状态那段不许整段空着）—— 这条守的是回退那个守卫本身。
  const emptyContextWorld = assembler.assemble(input({ worldState: { lines: [] } }));
  assert.ok(emptyContextWorld.user.includes('时段：深夜　星期：周二'), '空数组退回轻量写法');
  assert.equal(emptyContextWorld.user.split('现在：').length - 1, 1, '回退时也不会多出一份时间');
});

test('sections are addressable so the Debug UI can show exactly what the model saw', () => {
  const prompt = assembler.assemble(input());
  const names = prompt.sections.map((section) => section.name);
  // 没接线时只有这五段：V0.3 P1 新增的 self / memories / relationship / open-threads / audience
  // 都是**可选**层，`@xixi/context` 没有接线的调用方拿到的提示词与从前逐字相同（见下一条用例）。
  assert.deepEqual(names, ['core-identity', 'safety-policy', 'effective-style', 'world-state', 'current-turn']);
  assert.ok(prompt.sections.every((section) => section.part === 'system' || section.part === 'user'));
});

/**
 * 上下文四段是**增量**的（V0.3 P1）。
 *
 * 这一条守的是「没接线 = 逐字不变」：`@xixi/context` 没有接线的调用方（老测试、老脚本）
 * 不该因为这次改动而看到多出来的段落。接上之后每一段才出现，而且记忆那一段的条数只进
 * `sections[].debug`（模型看到的是那几行字，不是「注入了 6 条」）。
 */
test('没有上下文时提示词逐字不变；接上之后每一段才出现，且条数只进 Debug 段', () => {
  const bare = assembler.assemble(input());
  assert.equal(
    bare.sections.some((section) => ['memories', 'relationship', 'open-threads', 'audience'].includes(section.name)),
    false,
    '没接线就不该多出这几段',
  );
  assert.ok(!bare.user.includes(MEMORY_SECTION_HEADING), '更不该多出一段空标题');

  const connected = assembler.assemble(
    input({
      memories: { lines: ['- [较确定] 父亲不喜欢绿茶。'], injected: 6, droppedAtRender: 1 },
      relationship: { lines: ['你不必等他开口才说话。'] },
      openThreads: { lines: ['- 他说要去镇上办证'] },
      self: { lines: ['（你现在的说话方式与脾气都已经按下面的设定调过了，不用复述。）'], profile: { verbosity: 0.7 } },
      audience: { lines: ['可能有外人或者电视媒体在场：别提到家里人的私事与没办完的事。'] },
    }),
  );
  const names = connected.sections.map((section) => section.name);
  for (const name of ['memories', 'relationship', 'open-threads', 'audience']) {
    assert.ok(names.includes(name), `${name} 必须可寻址（面板要能逐段核对）`);
  }
  assert.ok(connected.user.includes(MEMORY_SECTION_HEADING), '记忆那一段用的是 pack §3 的标题');
  assert.ok(connected.user.includes('父亲不喜欢绿茶。'), '记忆的正文进了提示词');
  assert.ok(connected.user.includes('你不必等他开口才说话。'), '关系摘要也进了');
  assert.ok(connected.user.includes('他说要去镇上办证'), '未完话题也进了');
  assert.ok(connected.system.includes('别提到家里人的私事'), '听众那一段在稳定前缀里');

  // 条数（注入几家）只进 Debug：模型看到的是句子，不是统计。
  const memorySection = connected.sections.find((section) => section.name === 'memories');
  assert.ok(memorySection !== undefined);
  assert.equal(memorySection.text.includes('injected'), false, '`injected=` 不许出现在模型看的那一段');
  assert.match(memorySection.debug ?? '', /injected=6/, 'Debug 段里保留条数供核对');
  assert.match(memorySection.debug ?? '', /dropped_at_render=1/, '被出口闸门挡掉几条也要能看到');
  assert.doesNotMatch(connected.user, /injected|dropped_at_render/, 'user 里不许出现程序字段名');
});

/**
 * 心情进提示词（第五轮 t4）：**散文**给模型，数字只进 `sections`（Debug UI）。
 *
 * 两条要同时成立，所以它们钉在同一个用例里：
 *   * 模型看到的是句子（`mood.ts` 渲染），不是 `valence=0.31` 这种参数（pack §23 明文禁止）；
 *   * 没传心情时提示词与从前**逐字相同** —— 特性是增量的，老调用方不必知道它存在。
 */
test('心情以散文进提示词：没有数字、没有不存在的经历，且不接线时提示词逐字不变', () => {
  const withoutMood = assembler.assemble(input());
  assert.ok(!withoutMood.system.includes('你现在的心情'), '不传心情就没有这一段');
  assert.equal(
    withoutMood.sections.some((section) => section.name === 'mood'),
    false,
  );

  const mood = {
    valence: 0.31,
    energy: 0.72,
    prose: moodProse({ valence: 0.31, energy: 0.72 }),
    updatedAt: '2026-10-01T20:00:00+08:00',
    staleAfterMinutes: 160,
    now: '2026-10-01T20:05:00+08:00',
  };
  const withMood = assembler.assemble(input({ mood }));

  // 散文进了稳定前缀，而且带一句「这是状态不是事实」的边界（pack §23 的可执行版本）。
  assert.ok(withMood.system.includes('你现在的心情'));
  assert.ok(withMood.system.includes('不是发生过的某件事'));
  for (const line of mood.prose) {
    assert.ok(withMood.system.includes(line), `每一句散文都该进提示词：${line}`);
  }
  // 模型看不到数字：`0.31` / `0.72` 不许出现在 system 或 user 里。
  assert.doesNotMatch(withMood.system, /0\.31|0\.72|valence|energy/, 'system 里不许出现数值或参数名');
  assert.doesNotMatch(withMood.user, /0\.31|0\.72|valence|energy/, 'user 里也不许出现');
  assert.ok(withMood.user.includes('心情：'), '世界状态那一行给的是「这份心情有多新」，不是数值');

  // Debug UI 看得到数值（挂在 `sections[].debug` 上，**不拼进** system/user）。
  const moodSection = withMood.sections.find((section) => section.name === 'mood');
  assert.ok(moodSection !== undefined, '心情必须是可寻址的一段（§22.2）');
  assert.equal(moodSection.part, 'system');
  assert.ok((moodSection.debug ?? '').includes(String(mood.valence)), 'Debug 段里保留数值供核对');
  assert.ok(!withMood.system.includes('valence='), '数值绝不能拼进模型看的 system');

  // 心情不同 → 说话方式不同（否则「轻微影响语气」没有可观察结果）。
  const low = assembler.assemble(input({ mood: { ...mood, valence: 0.05, energy: 0.05, prose: moodProse({ valence: 0.05, energy: 0.05 }) } }));
  assert.notEqual(low.system, withMood.system);

  // 久未更新的心情要说明「多半淡了」，否则一句早上的心情会被当成此刻的心情。
  const stale = assembler.assemble(input({ mood: { ...mood, updatedAt: '2026-10-01T01:00:00+08:00' } }));
  assert.ok(stale.user.includes('早先的心情'), '过期的心情必须自己说明');
});

test('心情那一行不泄漏数值、也不依赖系统时钟（重放同输入同输出）', () => {
  const mood = {
    valence: 0.9,
    energy: 0.9,
    prose: moodProse({ valence: 0.9, energy: 0.9 }),
    updatedAt: '2026-10-01T20:00:00+08:00',
    staleAfterMinutes: 160,
    now: '2026-10-01T21:00:00+08:00',
  };
  const first = assembler.assemble(input({ mood }));
  const second = assembler.assemble(input({ mood }));
  assert.equal(first.system, second.system, '同样的输入必须得到同样的提示词（`now` 是显式传入的）');
  assert.equal(first.user, second.user);
  // 「刚更新过 / 早先的心情」这类措辞里不该出现时刻：`user` 里唯一允许出现时间的是那一行「现在：…」。
  const worldLines = first.user.split('\n').filter((line) => line.startsWith('- '));
  const withoutNow = worldLines.filter((line) => !line.startsWith('- 现在：'));
  assert.ok(
    withoutNow.every((line) => !/\d{2}:\d{2}/.test(line)),
    `除了「现在：」那一行，上下文里不该再出现时刻：${JSON.stringify(withoutNow)}`,
  );
  assert.ok(first.user.includes('心情：'), '心情那一行仍然在');
});
