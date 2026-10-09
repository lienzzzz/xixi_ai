/**
 * Fast tier — every page this repository ships, checked without a browser (ADR-0021).
 *
 * Why this file exists: the repository shipped "the trial page loads but every button is dead"
 * because the emitted `<script>` lost a level of backslash escaping inside its TypeScript
 * template, so the block died in the parser. `tests/console/*` asserted on the page *text* and
 * stayed green. Three checks below catch that class:
 *
 *   1. **It must parse.** Every inline block — and every local script file the page loads — is
 *      compiled with `node:vm` (compile only, nothing is executed), which is the same refusal the
 *      browser's parser would make.
 *   2. **Every id it looks up must exist.** A handler can be wired, parse fine, and still do
 *      nothing because the node it reaches for is not in the markup.
 *   3. **Nothing may be skipped quietly.** A `<script src="…">` that names no readable repo file is
 *      a failure, not a shrug — the point of this tier is that a script cannot go unchecked.
 *
 * The pages are read from where they really come from — `buildFieldPage()` for the console,
 * `scripts/serve-chat.ts`'s `PAGE` for the trial page, `apps/demo-ui/index.html` (+ its external
 * `app.js`) for the demo prototype — never from a hand-typed copy. The trial page is the one the
 * incident happened on; the demo's `app.js` is a static file, which is why the inline-only first
 * version of this tier could not see it at all.
 *
 * Everything here is offline: no DOM library, no browser, no network. This file is inside
 * `npm test` (the `test` script in `package.json`); the behaviour half lives in
 * `tests/ui/e2e/page-behavior.test.ts` and runs only under `npm run test:ui`.
 *
 * Run: node --test tests/ui/smoke/page-script.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { proactivePanelScript } from '../../../scripts/field-test.ts';

import {
  analyzePage,
  checkPage,
  checkPages,
  collectIdHelpers,
  consolePageSource,
  describeProblems,
  describeReferences,
  shippedPageSource,
  trialPageSource,
  type PageUnderTest,
} from '../lib/harness.ts';

/** The demo prototype's page: a static file whose only script is the external `./app.js`. */
const DEMO_PAGE = 'apps/demo-ui/index.html';

/** Every page this repository serves or ships, from its real source. */
async function shippedPages(): Promise<PageUnderTest[]> {
  return [consolePageSource(), await trialPageSource(), shippedPageSource(DEMO_PAGE)];
}

test('every page we ship has its scripts parsed — inline blocks and the files they load', async () => {
  const checked = checkPages(await shippedPages());

  assert.equal(checked.length, 3, '三个页面都必须在检查清单里：控制台、试用页、demo 原型页');

  for (const page of checked) {
    assert.deepEqual(page.problems, [], `${page.label} 的脚本必须能通过解析：${describeProblems(page.problems)}`);
  }

  // Non-vacuity guards. If a page stopped contributing script text (an empty block, a `src` that
  // extraction missed), "no problems" would be a lie rather than a pass.
  for (const page of checked) {
    assert.ok(
      page.inlineScripts + page.externalFiles.length > 0,
      `${page.label} 必须至少有一个脚本来源（内联块或本地脚本文件），否则这条用例对它没有任何约束`,
    );
    assert.ok(
      page.scriptBytes > 1000,
      `${page.label} 的脚本要有实际内容（实测 ${page.scriptBytes} B）：空块或 <script src="…"> 会让「没有语法问题」变成空断言`,
    );
    assert.deepEqual(
      page.notCompiled,
      [],
      `${page.label} 有没被本档编译的脚本引用：${page.notCompiled.map((item) => `${item.src}（${item.reason}）`).join('；')}`,
    );
  }

  const demo = checked.find((page) => page.label === DEMO_PAGE);
  assert.ok(demo !== undefined, `检查清单里必须有 ${DEMO_PAGE}`);
  assert.ok(
    demo.externalFiles.some((file) => file === 'apps/demo-ui/app.js'),
    `demo 页的外链脚本必须被编译到（实际编译了：${demo.externalFiles.join('、') || '（没有）'}）`,
  );

  const trial = checked.find((page) => page.label.includes('试用页'));
  assert.ok(trial !== undefined, '试用页必须在检查清单里 —— 那次「所有按钮点了没反应」就发生在它身上');
  assert.ok(trial.inlineScripts > 0, '试用页的脚本是内联的，必须真的被抽到');
});

test('every element id these pages look up exists in the page that ships with it', async () => {
  const checked = checkPages(await shippedPages());

  for (const page of checked) {
    assert.ok(
      page.references.length > 0,
      `${page.label}: 没有抽到任何 id 引用 —— 抽取规则过期了，这条用例对它会变成空断言`,
    );
    assert.deepEqual(
      page.missingIds.map((item) => `${item.id}（${item.via}，脚本 #${item.scriptIndex} 第 ${item.line} 行）`),
      [],
      `${page.label}: 脚本按字面量找的 id 必须在页面里真实存在；不存在就是「点了没反应」那类缺陷的静态形态`,
    );
  }

  const consolePage = checked.find((page) => page.label.includes('控制台'));
  const trial = checked.find((page) => page.label.includes('试用页'));
  const demo = checked.find((page) => page.label === DEMO_PAGE);

  assert.ok(
    consolePage?.references.some((item) => item.via === 'el()') === true,
    `控制台脚本用 el() 找节点，这里应该看到这类引用：${describeReferences(consolePage?.references.slice(0, 5) ?? [])}`,
  );
  // The demo page reaches every element through its own `$()` helper, so this asserts that the
  // alias rule really fired there rather than the check passing on an empty reference set.
  assert.ok(
    demo?.references.some((item) => item.via === '$()') === true,
    `demo 脚本用 $() 找节点，这里应该看到这类引用：${describeReferences(demo?.references.slice(0, 5) ?? [])}`,
  );

  // 试用页曾经逐字内嵌控制台的面板片段，t28 因此给它开了两条豁免；t31 把根因修掉之后豁免全部消失
  // （下面「共享核心不带另一个页面的 id」那条用例守着这件事）。这里只留非空守卫：豁免没有了，
  // 试用页必须靠自己的 47 条查找过检，而不是「什么都没检查」。
  assert.ok(
    (trial?.references.length ?? 0) > 10,
    `试用页自己的脚本要有实打实的查找被检查（实测 ${trial?.references.length ?? 0} 条）`,
  );
});

/**
 * The checks are only worth their time if they fail on the inputs they were written for. These
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

test('a broken script file, a missing script file and a mistyped id all turn this tier red', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-ui-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string): void => writeFileSync(join(dir, name), body);
  const pageLoading = (src: string): PageUnderTest => ({
    label: 'fixture/index.html',
    html: `<!doctype html>\n<html><body><button id="go">go</button>\n<script src="${src}"></script>\n</body></html>`,
    assetDir: dir,
  });

  // ① A healthy external file is compiled — the demo page's shape (`$()` included).
  write('good.js', "const $ = (id) => document.getElementById(id);\n$('go').textContent = 'ok';\n");
  const good = checkPage(pageLoading('./good.js'));
  assert.deepEqual(good.problems, [], `好文件不该被判红：${describeProblems(good.problems)}`);
  assert.deepEqual(good.missingIds, [], '好文件不该被判红');
  assert.equal(good.externalFiles.length, 1, '外链脚本必须被读到');
  assert.match(String(good.externalFiles[0]), /good\.js$/, '编译的应该是被引用的那个文件');

  // ② The file's own syntax error — and the failure has to say **which file**.
  write('broken.js', 'function f() {\n  return 1;\n');
  const broken = checkPage(pageLoading('./broken.js'));
  assert.equal(broken.problems.length, 1, '外链脚本的语法错误必须被判红');
  assert.match(String(broken.problems[0]?.source), /broken\.js$/, `报错必须指出是哪个文件，实际是「${broken.problems[0]?.source}」`);
  assert.match(String(broken.problems[0]?.message), /Unexpected|Invalid|SyntaxError|Unexpected end/i, '报错要说明这是解析失败');

  // ③ A `src` that names no file is a failure, never a silent skip.
  const missingFile = checkPage(pageLoading('./nope.js'));
  assert.equal(missingFile.problems.length, 1, '引用了不存在的脚本文件必须被判红');
  assert.match(String(missingFile.problems[0]?.source), /<script src="\.\/nope\.js">/, '要指出是哪一条引用');
  assert.match(String(missingFile.problems[0]?.message), /没有这个文件/, '要说清是没有这个文件');

  // ④ A server-rendered page that declares no asset directory cannot silently drop its `src` either.
  const served = checkPage({ label: '某个服务端页面', html: pageLoading('./app.js').html, assetDir: null });
  assert.equal(served.problems.length, 1, '服务端页面上的相对 src 必须被报出来');
  assert.match(String(served.problems[0]?.message), /没有声明它的静态资源目录/, '要说清为什么没法编译它');

  // ⑤ A non-repo `src` is reported as not compiled (the caller asserts that list is empty) instead
  //    of quietly counting as "checked".
  const external = checkPage({
    label: '某个服务端页面',
    html: '<!doctype html>\n<html><body><script src="https://cdn.example.com/x.js"></script></body></html>',
    assetDir: null,
  });
  assert.deepEqual(external.problems, [], '外部地址不是仓库文件，不该凭空报解析错误');
  assert.equal(external.notCompiled.length, 1, '但必须被登记为「没有编译」');
  assert.equal(external.notCompiled[0]?.src, 'https://cdn.example.com/x.js');
});

/**
 * t31：共享面板不再写另一个页面的 id。
 *
 * 修之前的形态（t28 在求值后的页面上量到的）：试用页发出的那段与控制台逐字共用，里面有约 30 条
 * `getElementById('px-cam-problem')` / `('turns')` / `('presence-text')` 这类查找 —— 试用页没有那些节点，
 * 全部是静默死分支；它还每秒拉一次控制台独有的 `/api/live`（试用页上就是每秒一条 404）。根因是共享片段
 * 写死了控制台的 id，所以修法也落在根因上：核心只发页面无关的那一半，控制台那几张卡只在控制台要的时候
 * （`{ consoleCards: true }`）随页面发出。
 *
 * 这条用例是那件事的判据：**核心不许含控制台的字面量查找，控制台形态必须仍然全都有**。两侧都断言，
 * 免得「把控制台卡片整段删掉」也能变绿。
 */
test('the shared panel core carries no other page ids — the console cards ship only to the console', () => {
  const core = proactivePanelScript('/api'); // 试用页拿到的就是这一份（serve-chat.ts 只传 apiBase）
  const withCards = proactivePanelScript('/api/field', { consoleCards: true });

  const consoleOnlyLookups = [
    "getElementById('px-cam-problem')",
    "getElementById('px-cam-problem-title')",
    "getElementById('px-cam-problem-note')",
    "getElementById('px-cam-problem-steps')",
    "getElementById('px-cam-problem-command')",
    "getElementById('px-cam-problem-raw')",
    "getElementById('presence-text')",
    "getElementById('turns')",
    "getElementById('px-cam')",
    "getElementById('px-cam-note')",
    "getElementById('px-live-frames')",
    "getElementById('px-live-frame-note')",
    "getElementById('px-enable')",
    "getElementById('px-disable')",
    "getElementById('px-enable-state')",
    "getElementById('px-enable-detail')",
    "getElementById('px-tts-switch')",
    "getElementById('px-camera-switch')",
    "getElementById('px-vision-auto')",
    "getElementById('px-look')",
    "getElementById('px-look-status')",
    "getElementById('px-look-history')",
    "getElementById('px-look-history-note')",
    "getElementById('px-look-privacy')",
  ];
  for (const lookup of consoleOnlyLookups) {
    assert.equal(core.includes(lookup), false, `共享核心不许按字面量找控制台的节点：${lookup}`);
    assert.ok(withCards.includes(lookup), `控制台形态必须仍然有它（否则是「把卡片删掉」而不是「拆开」）：${lookup}`);
  }
  // 控制台独有的那条每秒轮询也不许跟到试用页：`/api/live` 只存在于控制台。
  assert.equal(core.includes("'/live'"), false, '共享核心不许拉控制台独有的 /live');
  assert.ok(withCards.includes("'/live'"), '控制台形态仍然拉 /live');

  // 非空守卫：两侧都要有实际内容，否则上面那两条可能只是在比两个空串。
  assert.ok(core.length > 10_000, `共享核心要有实际内容（实测 ${core.length} B）`);
  assert.ok(
    withCards.length > core.length,
    `控制台形态要比核心多出那几张卡（核心 ${core.length} B / 控制台 ${withCards.length} B）`,
  );

  // 而**真实控制台页面**必须真的带上这几张卡 —— 断言上面那种「调用形态」是不够的：把
  // `buildFieldPage` 里的 `{ consoleCards: true }` 去掉时，控制台的 markup 里那些 id 就没人找了，
  // id 检查反而全绿（它只核对「出现过的查找」）。这条把「谁必须发出这些卡」钉在真页面上。
  const consolePage = consolePageSource();
  for (const lookup of ["getElementById('px-cam-problem')", "getElementById('turns')", "getElementById('px-live-frames')"]) {
    assert.ok(
      consolePage.html.includes(lookup),
      `控制台页必须真的发出这几张卡：${lookup}（八成是调用点漏了 { consoleCards: true }）`,
    );
  }
  assert.deepEqual(analyzePage(consolePage.html).missingIds, [], '控制台页那几张卡必须找得到自己的节点');
});

test('the id-helper rule is narrow enough to be useful and strict enough not to invent ids', () => {
  // Positive: a thin `getElementById` alias, in the shapes the repository actually uses.
  assert.deepEqual(collectIdHelpers('const $ = (id) => document.getElementById(id);'), ['$']);
  assert.deepEqual(collectIdHelpers('function el(id) { return document.getElementById(id); }'), ['el']);
  assert.deepEqual(collectIdHelpers('const byId = document.getElementById.bind(document);'), ['byId']);

  // Negative: functions that merely *mention* `getElementById` inside more logic. Loosening the rule
  // to match these was measured to produce false reds — the console page's `pxVal('cooldown')` /
  // `pxStatus('正在走九道门禁…')` take logical keys and messages, not ids.
  assert.deepEqual(
    collectIdHelpers(
      'function pxVal(name) { var node = document.getElementById(PX.ids[name]); return node ? node.value : undefined; }\n' +
        'function pxStatus(text) { var node = document.getElementById(PX.ids.status); if (!node) return; node.textContent = text; }',
    ),
    [],
    '只有「body 就是一次 getElementById」的助手才是 id 助手；放宽会把逻辑键当成 id（实测过假红）',
  );

  // …and the negative case really is silent at the reference level too: a helper from the markup's
  // own vocabulary (`activateView('home')`) is not an element lookup.
  const notIds = pageWith("function activateView(view) { return view; }\nactivateView('home');", '<button id="go">go</button>');
  assert.deepEqual(analyzePage(notIds).references, [], '普通函数调用里的字符串不是 id 引用');

  // Positive end-to-end: the alias rule turns a mistyped id red, and says which helper it came from.
  const aliasBroken = pageWith("const $ = (id) => document.getElementById(id);\n$('gone').textContent = 'never';", '<button id="go">go</button>');
  const missing = analyzePage(aliasBroken).missingIds;
  assert.equal(missing.length, 1, '经 id 助手找不存在的节点必须被判红');
  assert.equal(missing[0]?.id, 'gone');
  assert.equal(missing[0]?.via, '$()');
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
