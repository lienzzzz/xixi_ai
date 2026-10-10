/**
 * Deep tier — the interactive prototype (`apps/demo-ui/`) loaded by **real Chromium** through the
 * **real `/demo/` routes** of `scripts/serve-chat.ts` (ADR-0021).
 *
 * This is the port of `xixi_demo_design_pack/tests/browser_smoke.py` (D0) — the smoke the design
 * pack shipped together with the prototype, and the one piece of that pack that never made it into
 * the repository. Until now the demo page's runtime behaviour had **no** automatic defence: the fast
 * tier only parses its scripts and cross-checks ids, and the deep tier only executed the console
 * page. `docs/testing.md` §3.2 said so in as many words ("`/demo/` 的浏览器取证是一次性的").
 *
 * Two deliberate upgrades over the Python original:
 *
 *   1. **It goes through the shipped routes.** The original read the three files and pushed them
 *      into the page with `set_content()` / `add_script_tag()`, which grades file copies. This one
 *      loads `GET /demo/` from the server the user actually opens, so the serving path is under test
 *      as well — `./app.js` really being fetched over HTTP and really being parsed by the browser.
 *   2. **The boot signal is script-only.** The original opened with
 *      `#companion-state == 安静待机` — a string that is **already in the markup**, so it would stay
 *      green on a page whose script never ran. That is the exact shape of the 2026-10-08
 *      「所有按钮点了没反应」incident, where text assertions were green while the whole script block
 *      had died in the parser. `#mode-pill` is written by the prototype's own last lines and by
 *      nothing else, so it can only appear if the script parsed and reached its start-up code.
 *
 * The prototype stays in its default **mock** mode here (no `?mode=live`): no `/api/*` is called, so
 * this file needs no key and no devices. Driving the page against the real API is a different
 * question with a different failure mode, and it is not what this guard is for.
 *
 * Run: `npm run test:ui`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { startTrialPage, type TrialPageFixture } from '../../console/serve-chat-fixture.ts';
import { hasHorizontalOverflow, openPage, waitForSelectorText, type BrowserSession } from '../lib/harness.ts';

/** Written only by `apps/demo-ui/app.js`; the markup's own `#mode-pill` is empty. */
const MOCK_PILL = '交互原型 · 模拟数据';

/**
 * The badge is `display: none` below 768 px, so "the script ran" has to be asked as `attached` —
 * visibility is a layout question and at phone width the honest answer is "hidden on purpose".
 */
const BOOT_WAIT = { state: 'attached' } as const;

const dataDir = mkdtempSync(join(tmpdir(), 'xixi-demo-e2e-'));
let server: TrialPageFixture;
let session: BrowserSession;
/** Responsive checks open extra pages on the same browser; only `session` owns it. */
const extraSessions: BrowserSession[] = [];

before(async () => {
  server = await startTrialPage({ dataDir });
  session = await openPage(`${server.base}/demo/`);
  await waitForSelectorText(session, '#mode-pill', MOCK_PILL, BOOT_WAIT);
});

after(async () => {
  for (const extra of extraSessions) await extra.stop();
  await session?.stop();
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('the prototype loads over the real /demo/ route with zero uncaught script errors', async () => {
  assert.equal(session.loadStatus, 200, 'GET /demo/ 必须由真的 serve-chat 服务返回 200');

  // The page reached the browser's own start-up code: `#mode-pill` is empty in the markup and is
  // filled on the prototype's last lines. A script that died in the parser never gets here.
  assert.equal(
    (await session.page.locator('#mode-pill').textContent())?.trim(),
    MOCK_PILL,
    '#mode-pill 必须由原型脚本自己写成模拟模式徽章',
  );

  // Upgrade 1 in action: the external script was fetched over HTTP rather than injected, so this
  // also proves `/demo/app.js` is served, parseable, and referenced with the right relative path.
  assert.ok(
    session.requests.includes('GET /demo/app.js'),
    `页面必须自己取得 /demo/app.js，实际请求：${session.requests.join(', ')}`,
  );
  assert.ok(
    session.requests.includes('GET /demo/styles.css'),
    `页面必须自己取得 /demo/styles.css，实际请求：${session.requests.join(', ')}`,
  );

  assert.deepEqual(session.pageErrors, [], '页面不得抛任何未捕获脚本错误（整块脚本解析失败正是这一类）');
  assert.deepEqual(session.failedRequests, [], '页面发出的请求不得失败');
  assert.deepEqual(session.consoleErrors, [], '控制台不得有 error 级输出');
});

test('a suggestion fills the composer and sending it renders a turn', async () => {
  const suggestion = session.page.locator('[data-example]').first();
  const example = await suggestion.getAttribute('data-example');
  assert.ok(example !== null && example.length > 0, '第一个建议按钮必须带 data-example');

  await suggestion.click();
  assert.equal(
    await session.page.locator('#message-input').inputValue(),
    example,
    '点建议必须把它自己的示例文本填进输入框（handler 没挂上时这一步静默什么都不做）',
  );

  await session.page.locator('#send-button').click();
  // Mock mode answers after 600 ms; wait for the *second* bubble (the reply) rather than sleeping.
  await session.page.locator('.message').nth(1).waitFor({ state: 'attached', timeout: 5_000 });
  assert.equal(await session.page.locator('.message').count(), 2, '一次发送应该渲染出「你说的一句 + 西西回的一句」');

  // The prototype's own promise, and the one a reader could actually be misled by: in mock mode the
  // reply says so **on the reply itself**. A corner badge is not enough — it is `display: none`
  // below 768 px, so on a phone this tag is the only thing between a demo answer and someone who
  // thinks the real backend answered.
  assert.match(
    String(await session.page.locator('.message').nth(1).textContent()),
    /模拟回复/,
    'mock 模式的回复必须自带「模拟回复」标记，否则用户会把它当成真回复',
  );

  assert.deepEqual(session.pageErrors, [], '交互之后页面仍不得抛未捕获脚本错误');
  assert.deepEqual(session.consoleErrors, [], '交互之后控制台仍不得有 error 级输出');
});

test('the two toggles move the state they own, and only their own', async () => {
  // `#companion-state` reads 安静待机 in the markup and is rewritten by `updateUI()`, so a change
  // here can only have come from the handler.
  await session.page.locator('#companion-toggle').click();
  await session.page.locator('#companion-state', { hasText: '陪伴已开启' }).waitFor({ state: 'visible', timeout: 5_000 });
  await session.page.locator('#companion-toggle').click();
  await session.page.locator('#companion-state', { hasText: '安静待机' }).waitFor({ state: 'visible', timeout: 5_000 });

  // Mock mode must not touch a real device: the label flips, and the placeholder says so.
  await session.page.locator('#camera-toggle').click();
  await session.page.locator('#camera-toggle', { hasText: '关闭摄像头' }).waitFor({ state: 'visible', timeout: 5_000 });
  assert.match(
    String(await session.page.locator('#camera-placeholder').textContent()),
    /模拟预览模式/,
    '原型默认是 mock 模式，摄像头开关不得去连真实设备，占位文案要说清这一点',
  );
  await session.page.locator('#camera-toggle').click();
  await session.page.locator('#camera-toggle', { hasText: '开启摄像头' }).waitFor({ state: 'visible', timeout: 5_000 });

  assert.deepEqual(session.pageErrors, [], '交互之后页面仍不得抛未捕获脚本错误');
});

test('navigation swaps the two workspaces and the privacy dialog opens and closes', async () => {
  await session.page.locator('[data-view="lab"]').click();
  assert.equal(await session.page.locator('#view-lab').isVisible(), true, '点「开发者实验室」必须露出实验室');
  assert.equal(await session.page.locator('#view-home').isVisible(), false, '两个工作区不能同时露出来');

  await session.page.locator('#return-home').click();
  assert.equal(await session.page.locator('#view-home').isVisible(), true, '点「回到陪伴空间」必须换回去');
  assert.equal(await session.page.locator('#view-lab').isVisible(), false, '换回去时实验室必须收起来');

  await session.page.locator('#privacy-link').click();
  assert.equal(await session.page.locator('#privacy-dialog').isVisible(), true, '点隐私说明必须打开对话框');
  await session.page.locator('#close-privacy').click();
  assert.equal(await session.page.locator('#privacy-dialog').isVisible(), false, '点关闭必须收起对话框');

  assert.deepEqual(session.pageErrors, [], '交互之后页面仍不得抛未捕获脚本错误');
});

test('the prototype does not scroll sideways at phone, tablet or desktop width', async () => {
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1440, 900],
  ] as const) {
    const view = await openPage(`${server.base}/demo/`, { browser: session.browser, viewport: { width, height } });
    extraSessions.push(view);
    await waitForSelectorText(view, '#mode-pill', MOCK_PILL, BOOT_WAIT);
    // `scrollWidth > innerWidth` is the honest test: a single wide child (an unshrinkable table, a
    // fixed-width camera frame) makes the whole page pan, and no CSS assertion would see it.
    const overflows = await hasHorizontalOverflow(view);
    assert.equal(overflows, false, `${width}×${height} 下页面不该横向溢出`);
    assert.deepEqual(view.pageErrors, [], `${width}×${height} 下页面不得抛未捕获脚本错误`);
  }
});
