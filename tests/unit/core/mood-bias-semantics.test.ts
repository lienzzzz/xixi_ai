/**
 * pack v03-preflight ⑤：`moodBias` 的**注释与公式**必须说同一件事。
 *
 * 二者取一，这里选的是**改注释、保留公式**（理由见下面第一条用例的注释），并把它钉成两半：
 *   * 数值一半：`moodBias` 是「两个维度各自减去中性后的偏移**相加**、再夹在 [-1, 1]」——
 *     `(1, 0.5)` 读成 0.5 而不是 0.25（取平均会读成 0.25），两端能被夹到 ±1；
 *   * 文字一半：源码里 `moodBias` 的文档注释必须写「相加」（旧注释写「平均」，与代码相反）。
 *
 * 为什么文字也要断言：这一条的**缺陷本体就是注释**（公式没坏、注释写反），没有别的可观察面。
 * 文档注释在这个仓库里是代码事实的一部分（`check:docs` 检查文档，这里检查公式的说明），
 * 所以用一条会红的断言把它钉住，而不是靠人记得。
 *
 * Run: `npm test`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { moodBias } from '@xixi/domain';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const MOOD_SOURCE = join(REPO_ROOT, 'packages', 'domain', 'src', 'mood.ts');

test('moodBias 是「相加后夹」，不是平均（取平均会把幅度减半、让 ±1 的夹子变成死代码）', () => {
  // 相加：0.5 + 0 = 0.5。取平均的话这里会是 0.25 —— 这条断言就是「选哪一个」的分界。
  assert.equal(moodBias({ valence: 1, energy: 0.5 }), 0.5);
  assert.equal(moodBias({ valence: 0.5, energy: 1 }), 0.5);
  // 两端被夹住：只有相加才会溢出到 ±1，±1 的夹子因此是活的（取平均永远到不了）。
  assert.equal(moodBias({ valence: 1, energy: 1 }), 1);
  assert.equal(moodBias({ valence: 0, energy: 0 }), -1);
  // 中性点仍然是 0（两个维度都在中性）。
  assert.equal(moodBias({ valence: 0.5, energy: 0.5 }), 0);
});

test('moodBias 的文档注释写的是公式本身（旧的「平均」措辞不许回来）', () => {
  const source = readFileSync(MOOD_SOURCE, 'utf8');
  const declaration = source.indexOf('export function moodBias');
  assert.ok(declaration > 0, 'mood.ts 里必须有 moodBias');
  const docStart = source.lastIndexOf('/**', declaration);
  const doc = source.slice(docStart, declaration);

  assert.match(doc, /各自减去中性后的偏移相加/, '注释必须写明两个维度的偏移是相加的');
  assert.match(doc, /夹在/, '注释必须写明结果的界');
  assert.doesNotMatch(doc, /减去中性后的平均/, '旧注释写「平均」，与代码相反 —— 不许回来');
});
