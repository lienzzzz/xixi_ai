/**
 * pack v03-preflight ⑥：`packages/conversation/src/index.ts` 的导出补全。
 *
 * handoff 记过两条「已实现但没有登记」：`isAnswerAboutThread`（值）与 `IgnoredThreadTurn`（类型）。
 * 后果不是理论上的：`tests/unit/core/topic-engine.test.ts` 只能**按源文件路径**导入它们
 * （`../../../packages/conversation/src/topic-engine.ts`），于是包边界被绕过，别的包也就借不到这两样。
 *
 * 两条断言各钉一半：
 *   * 值导出走**真导入**：`import { isAnswerAboutThread } from '@xixi/conversation'` 在没有这条导出时
 *     会让 Node 的 ESM 链接直接报 `does not provide an export named`（红在导入语句上）；
 *   * 类型导出在运行期会被擦掉，没有可执行的观测点，所以按**导出清单**判：读 `index.ts`，要求它把
 *     `IgnoredThreadTurn` 登记在 `topic-engine.ts` 那个 export 块里（反事实：删掉这一行 → 本条红）。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { isAnswerAboutThread } from '@xixi/conversation';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const INDEX_SOURCE = join(REPO_ROOT, 'packages', 'conversation', 'src', 'index.ts');

test('isAnswerAboutThread 能从包入口导入，并且判据与实现同源', () => {
  assert.equal(typeof isAnswerAboutThread, 'function', '包入口必须导出这个值');
  // 用一条真实判定同时证明「导入的是生产实现」而不是一个同名替身：
  // ADR-0012 的判据——答案必须与话题的**对象**对得上才算回答。
  assert.equal(isAnswerAboutThread({ summary: '明天下午我要去镇上办证', subject: '去镇上办证' }, '证已经拿到了。'), true);
  assert.equal(isAnswerAboutThread({ summary: '明天下午我要去镇上办证', subject: '去镇上办证' }, '我去楼下买了点水果。'), false);
});

test('IgnoredThreadTurn 登记在包入口的 topic-engine 导出块里', () => {
  const source = readFileSync(INDEX_SOURCE, 'utf8');
  const end = source.indexOf("from './topic-engine.ts'");
  assert.ok(end > 0, 'index.ts 里必须有 topic-engine 的导出块');
  const block = source.slice(source.lastIndexOf('export {', end), end);
  assert.match(block, /IgnoredThreadTurn/, 'ReconcileResult.ignored 的元素类型必须与它一起导出');
  assert.match(block, /isAnswerAboutThread/, '值导出也要登记在同一个块里（不是另开一处）');
});
