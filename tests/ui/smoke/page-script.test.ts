/**
 * Fast tier — the console page's inline script, checked without a browser (ADR-0021).
 *
 * Why this file exists: the repository shipped "the trial page loads but every button is dead"
 * because the emitted `<script>` lost a level of backslash escaping inside its TypeScript
 * template, so the block died in the parser. `tests/console/*` asserted on the page *text* and
 * stayed green. Two checks below catch that class:
 *
 *   1. **It must parse.** Every inline block is compiled with `node:vm` (compile only — nothing is
 *      executed), which is the same refusal the browser's parser would make.
 *   2. **Every id it looks up must exist.** A handler can be wired, parse fine, and still do
 *      nothing because the node it reaches for is not in the markup.
 *
 * Both are zero-dependency and offline: no DOM library, no browser, no network, no database. This
 * file is inside `npm test` (see the `test` script in `package.json`); the behaviour half lives in
 * `tests/ui/e2e/page-behavior.test.ts` and runs only under `npm run test:ui`.
 *
 * Run: node --test tests/ui/smoke/page-script.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzePage, buildConsolePage, collectIdReferences, describeReferences, extractPageScripts } from '../lib/harness.ts';

test('the console page still emits an inline script, and every block parses', () => {
  const html = buildConsolePage();
  const analysis = analyzePage(html);

  // Non-vacuity guards: if extraction ever stops matching, "no syntax problems" would be a lie.
  assert.ok(analysis.scripts.length > 0, '页面里必须至少有一个内联 <script>（抽不到脚本时下面这条就是空断言）');
  assert.ok(
    analysis.scripts.some((script) => script.code.trim().length > 1000),
    '抽出来的脚本要有实际内容：空块或 <script src="…"> 会让「没有语法问题」变成空断言（1000 是下界，不是要同步的数字）',
  );

  assert.deepEqual(
    analysis.syntaxProblems.map((problem) => `脚本 #${problem.scriptIndex}: ${problem.message}`),
    [],
    '页面内联脚本必须能通过解析：整块脚本解析失败时，浏览器一个监听器都不会挂上',
  );
});

test('every element id the console page looks up exists in the page it ships with', () => {
  const html = buildConsolePage();
  const references = collectIdReferences(extractPageScripts(html));

  assert.ok(references.length > 0, '没有抽到任何 id 引用 —— 抽取规则过期了，这条用例会变成空断言');

  const missing = analyzePage(html).missingIds;
  assert.deepEqual(
    missing.map((item) => `${item.id}（${item.via}，脚本 #${item.scriptIndex} 第 ${item.line} 行）`),
    [],
    '脚本按字面量找的 id 必须在页面里真实存在；不存在就是「点了没反应」那类缺陷的静态形态',
  );
  // The positive half of the same statement: the check really is reading this page's lookups.
  assert.ok(
    references.some((item) => item.via === 'el()'),
    `控制台脚本用 el() 找节点，这里应该看到这类引用，实际看到：${describeReferences(references.slice(0, 5))}`,
  );
});

/**
 * The two checks are only worth their time if they fail on the inputs they were written for. These
 * fixtures are permanent counterfactuals: each bad input must turn red, and a good page must not.
 */
function pageWith(script: string, body = ''): string {
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8" /><title>fixture</title></head>\n<body>${body}\n<script>\n${script}\n</script>\n</body></html>`;
}

/** The text of a 1-based page line, so a reported line number can be checked against its content. */
function lineOfPage(page: string, line: number): string {
  return page.split('\n')[line - 1] ?? '';
}

test('the checker rejects the two bad inputs it exists for, and accepts a good page', () => {
  const good = pageWith("function el(id) { return document.getElementById(id); }\nel('go').textContent = 'ok';", '<button id="go">go</button>');
  const goodAnalysis = analyzePage(good);
  assert.deepEqual(goodAnalysis.syntaxProblems, [], '好页面不该被判红（否则下面的反证只是因为「检查器恒红」）');
  assert.deepEqual(goodAnalysis.missingIds, [], '好页面不该被判红');

  // ① The historical defect, written the way it happened: the TypeScript template evaluated `\n`
  //    into a real line break, so the *emitted* JavaScript had a string literal spanning two lines.
  const emittedWithRealNewline = `var hint = '第一行\n第二行';`;
  const syntaxBroken = pageWith(emittedWithRealNewline, '<button id="go">go</button>');
  const syntaxProblems = analyzePage(syntaxBroken).syntaxProblems;
  assert.equal(syntaxProblems.length, 1, '把换行写进字符串字面量必须被解析检查抓住（这正是那次「整页按钮全不响应」的形态）');
  assert.match(
    String(syntaxProblems[0]?.message),
    /Invalid or unexpected token|Unexpected|SyntaxError/i,
    '报错要指出这是一个解析错误',
  );

  // ② An id the script looks up and the markup does not have.
  const idBroken = pageWith("function el(id) { return document.getElementById(id); }\nel('gone').textContent = 'never';", '<button id="go">go</button>');
  const missing = analyzePage(idBroken).missingIds;
  assert.equal(missing.length, 1, '引用了不存在的 id 必须被判红');
  assert.equal(missing[0]?.id, 'gone');
  assert.equal(missing[0]?.via, 'el()');
  assert.match(
    lineOfPage(idBroken, missing[0]?.pageLine ?? 0),
    /el\('gone'\)/,
    '报错要指到页面里真正做这次查找的那一行',
  );

  // ③ The shared panel's id map — emitted as `PX.ids = {"save":"px-save"}` — is the other way a
  //    page names ids, and a map pointing at a node that is not in the markup is the same defect.
  const emittedMap = pageWith(
    'var PX = { base: "/api/field" };\nPX.ids = {"save":"px-save","off":"px-off"};\nvar node = document.getElementById(PX.ids.save);\nnode.click();',
    '<button id="px-off">off</button>',
  );
  const mapMissing = analyzePage(emittedMap).missingIds;
  assert.equal(mapMissing.length, 1, 'ids 映射里的值也是 id 引用，映射指向不存在的节点同样必须判红');
  assert.equal(mapMissing[0]?.id, 'px-save');
  assert.equal(mapMissing[0]?.via, 'ids:{}');

  // …and the hand-written form of the same map (bare keys) is read the same way.
  const bareKeyMap = pageWith('var ids = { save: "px-save" };\ndocument.getElementById(ids.save).click();', '<button id="px-off">off</button>');
  assert.equal(analyzePage(bareKeyMap).missingIds.length, 1, '裸键写法的手写映射也要被读到');
});

test('an id the script creates itself counts as defined, and a module block is refused loudly', () => {
  // False-red guard: `node.id = 'made-later'` really does exist once the script runs.
  const dynamic = pageWith(
    "var node = document.createElement('div');\nnode.id = 'made-later';\ndocument.body.appendChild(node);\ndocument.getElementById('made-later').textContent = 'ok';",
  );
  assert.deepEqual(analyzePage(dynamic).missingIds, [], '脚本自己赋的 id 不算缺失（否则这是误报，不是防线）');

  // A module block is not a syntax error, so it must not be reported as one — but it is also not
  // silently passed: the message says exactly what to extend.
  const moduleBlock = `<!doctype html>\n<html><body><script type="module">export const value = 1;</script></body></html>`;
  const moduleProblems = analyzePage(moduleBlock).syntaxProblems;
  assert.equal(moduleProblems.length, 1, '模块脚本必须被明确拒绝（不许静默跳过）');
  assert.match(String(moduleProblems[0]?.message), /not a classic inline script/, '拒绝的理由要写在报错里');
});
