/**
 * 评审（judge）字段映射的离线守卫（V0.3 P0 收尾 t19 / t10 复审 R2-D2）。
 *
 * 这一层以前**没有**任何离线用例：`in_character → inCharacter` 只在 `--judge` 真跑（真花钱、
 * 手动）时才看得见，而错名的症状是 `undefined`，被渲染成「否」—— 与一次真实的否定判定一模一样。
 *
 * 三条断言各守一半：
 *   1. **值是搬过来的**，不是 `undefined`（`false` 与 `undefined` 在报告里长得一样，所以单独钉 `false`）；
 *   2. **schema 与读取方同源**：`required`/`properties` 的键名与读取方改用的名字逐个相等 ——
 *      改名只改一半时会红，这正是 t7 那次类型检查才抓到的东西；
 *   3. **反向也守**：camelCase 形状的回包必须**不被接受**（`assertSchema` 拒它、映射返回 `null`），
 *      否则「线上到底叫哪个名字」就成了一团说不清的模糊地带。
 *
 * 输入是**内联 JSON 字符串**（`--judge` 真跑时拿到的就是这种文本），不走网络、不调模型。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertSchema } from '@xixi/contracts';

import { JUDGE_FIELDS, JUDGE_SCHEMA, judgeScoreFromWire } from '../../../scripts/lib/judge-score.ts';

const CLI_SOURCE = join(import.meta.dirname, '..', '..', '..', 'scripts', 'eval-conversation.ts');

/** 一次真实回包的内联形状：注意 `in_character` 是 snake_case，而且这次是 `false`。 */
const WIRE_JSON = '{"naturalness":4,"coherence":5,"in_character":false,"problems":["有一句像客服"]}';
/** 同一个回包，但把字段名改成报告用的 camelCase —— 这种回包**不算数**。 */
const CAMEL_JSON = '{"naturalness":4,"coherence":5,"inCharacter":false,"problems":["有一句像客服"]}';

test('判官回包逐字段搬到报告：in_character 的 false 必须是 false，不是 undefined', () => {
  const score = judgeScoreFromWire(JSON.parse(WIRE_JSON), 'G01');
  assert.ok(score !== null, '形状对得上就必须给出分数，而不是当成没测到');
  assert.equal(score.scenario, 'G01');
  assert.equal(score.naturalness, 4);
  assert.equal(score.coherence, 5);
  // 这一条就是那条缺陷：undefined 会被 `score.inCharacter ? '是' : '否'` 渲染成「否」，
  // 与一次真的「不像家里人」判定无法区分。用 strictEqual 而不是 assert.ok，才能把 false 钉住。
  assert.equal(score.inCharacter, false, 'in_character=false 必须落到 inCharacter=false');
  assert.notEqual(score.inCharacter, undefined, 'undefined 不是「否」，是「没读到」');
  assert.deepEqual(score.problems, ['有一句像客服']);
  // 报告行里不许有 undefined（少一个字段就是一次静默的错误结论）。
  const undefinedFields = Object.entries(score).filter(([, value]) => value === undefined).map(([key]) => key);
  assert.deepEqual(undefinedFields, [], `这些字段是 undefined：${undefinedFields.join('、')}`);
});

test('schema 与读取方同源：字段名只写在一张表里，改名不可能只改一半', () => {
  const wireNames = Object.values(JUDGE_FIELDS).sort();
  // `JsonSchema` 是 `{ [key: string]: JsonValue }`，读它的 required/properties 要就地收窄（不用 any）。
  const required: unknown = JUDGE_SCHEMA.required;
  const properties: unknown = JUDGE_SCHEMA.properties;
  const requiredNames = Array.isArray(required) ? required.map((name: unknown) => String(name)).sort() : [];
  const propertyNames = typeof properties === 'object' && properties !== null ? Object.keys(properties).sort() : [];
  assert.deepEqual(requiredNames, wireNames, 'schema 要的就是读取方读的那几个名字');
  assert.deepEqual(propertyNames, wireNames, 'schema 的属性名也必须逐字相同');
  assert.equal(JUDGE_FIELDS.inCharacter, 'in_character', '线上形状是 snake_case（这条就是 t7 抓到的错名）');
  // schema 真的接受这份内联 JSON（否则「模型回了它要的东西」这一步就说不通）。
  assert.doesNotThrow(() => assertSchema(JUDGE_SCHEMA, JSON.parse(WIRE_JSON), 'INVALID_PAYLOAD', 'judge output does not match the rubric schema'));
});

test('反向守卫：camelCase 形状的回包不算数（既不通过 schema，也不给出分数）', () => {
  assert.throws(
    () => assertSchema(JUDGE_SCHEMA, JSON.parse(CAMEL_JSON), 'INVALID_PAYLOAD', 'judge output does not match the rubric schema'),
    Error,
    'schema 必须拒掉 camelCase 回包 —— 否则「线上叫哪个名字」就说不清了',
  );
  assert.equal(judgeScoreFromWire(JSON.parse(CAMEL_JSON), 'G01'), null, '映射也不接受它（读不到 in_character）');
});

test('少字段 / 类型不对 / 不是对象：一律算「没测到」，绝不给出带 undefined 的分数', () => {
  const missing = ['{"coherence":5,"in_character":true,"problems":[]}', '{"naturalness":4,"in_character":true,"problems":[]}'];
  for (const payload of missing) {
    assert.equal(judgeScoreFromWire(JSON.parse(payload), 'G01'), null, payload);
  }
  assert.equal(judgeScoreFromWire({ naturalness: 4, coherence: 5, in_character: 'yes', problems: [] }, 'G01'), null, 'in_character 必须是布尔值');
  assert.equal(judgeScoreFromWire({ naturalness: 4, coherence: 5, in_character: true, problems: '无' }, 'G01'), null, 'problems 必须是数组');
  assert.equal(judgeScoreFromWire(null, 'G01'), null);
  assert.equal(judgeScoreFromWire('not json at all', 'G01'), null);
  assert.equal(judgeScoreFromWire([], 'G01'), null, '数组不是回包');
  // 形状对、但问题列表里混进了非字符串：丢那一条，不丢整次测量。
  const score = judgeScoreFromWire({ naturalness: 3, coherence: 3, in_character: true, problems: ['太客套', 42] }, 'G02');
  assert.deepEqual(score?.problems, ['太客套']);
});

/**
 * 调用图（AGENTS §9.24）：只把映射抽出来还不够 —— 若 CLI 仍留一份自己的读法，上面三条断言测的是替身。
 * 所以这里断言两件事：CLI **真的调用**那个共享函数，而且**不许自己再读**线上字段名（旧写法就是
 * `parsed.in_character` 手抄一份）。提示词里那几行是给模型看的散文，字段名也在里面 —— 作为弱一点的
 * 交叉核对，一并要求它们出现（schema 与提示词不能各说一个名字）。
 */
test('CLI 真的调用共享映射，不再自己抄一份字段名（只测替身等于没测）', () => {
  const cli = readFileSync(CLI_SOURCE, 'utf8');
  assert.match(cli, /judgeScoreFromWire\(/, 'CLI 必须调用共享映射');
  assert.match(cli, /from '\.\/lib\/judge-score\.ts'/, '而且是从 scripts/lib/judge-score.ts 导入的');

  const offenders: string[] = [];
  for (const [index, line] of cli.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue; // 注释不算
    if (/\.in_character\b|\[\s*['"]in_character['"]\s*\]/.test(line)) offenders.push(`${index + 1}: ${trimmed}`);
  }
  assert.deepEqual(offenders, [], `CLI 里还有自己读线上字段名的地方（映射会分裂成两份）：\n${offenders.join('\n')}`);

  for (const wireName of Object.values(JUDGE_FIELDS)) {
    assert.ok(cli.includes(wireName), `发给模型的提示词里没有写「${wireName}」`);
  }
});
