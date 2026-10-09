/**
 * Deep tier — the console page loaded by **real Chromium**, against the **real HTTP server**
 * (ADR-0021). This is the half no text assertion can replace: it is the only thing in the
 * repository that executes the page's JavaScript.
 *
 * `npm run test:ui` — deliberately **not** part of `npm test`. The browser binary is not in the
 * repository and must be fetched once (`npm run test:ui:install`); a missing binary fails this file
 * loudly instead of skipping it, because a silent skip is exactly the shape this tier was added to
 * remove.
 *
 * What is asserted:
 *   1. the page loads from the real server in its offline/no-key mode, with **zero `pageerror`**;
 *   2. the key controls really run their handlers and reach the real API — device readings render,
 *      the quiet switch moves the session state, a new session resets the log, and a typed message
 *      comes back as a rendered turn.
 *
 * Run: npm run test:ui
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { openConsolePage, startConsoleServer, waitForPageBoot, type BrowserSession, type ConsoleServer } from '../lib/harness.ts';

let server: ConsoleServer;
let session: BrowserSession;

before(async () => {
  server = await startConsoleServer();
  session = await openConsolePage(server);
  await waitForPageBoot(session);
});

after(async () => {
  await session?.stop();
  await server?.close();
});

test('the console page loads over real HTTP with zero uncaught script errors', async () => {
  assert.equal(session.loadStatus, 200, 'GET / 必须由真的控制台服务返回 200');

  const title = await session.page.title();
  assert.match(title, /现场测试控制台/, `页面标题应该是控制台，实际是「${title}」`);

  // The page's own start-up code reached the server and rendered what came back: this is the
  // "real interface mode" half — no mocked fetch, no `page.setContent()` of a copy.
  const listen = await session.page.locator('#p-listen').textContent();
  assert.equal(listen, `地址 127.0.0.1:${server.port}`, '#p-listen 必须由 /api/field/state 的真实往返填出来');
  assert.ok(session.requests.includes('GET /api/field/state'), `页面应该自己请求状态接口，实际请求：${session.requests.join(', ')}`);

  // The headline assertion: the browser reported no uncaught error while parsing and running it.
  assert.deepEqual(session.pageErrors, [], '页面不得抛任何未捕获脚本错误（整块脚本解析失败正是这一类）');
  assert.deepEqual(session.failedRequests, [], '页面发出的请求不得失败');
  assert.deepEqual(session.consoleErrors, [], '控制台不得有 error 级输出');
});

test('the key controls really run their handlers and reach the real API', async () => {
  const probeBefore = await session.probe();
  // The page wired these controls itself; if a handler were never attached, the clicks below could
  // still "succeed" as DOM events, so this is checked first and separately.
  for (const listener of ['click #ep-refresh', 'click #quiet', 'click #new', 'submit #form']) {
    assert.ok(
      (probeBefore.listeners[listener] ?? 0) >= 1,
      `页面必须给「${listener}」挂上监听器，实际监听表：${JSON.stringify(probeBefore.listeners)}`,
    );
  }

  // ① 刷新设备读数 — server data (a stub only this test knows) has to reach the DOM.
  await session.page.click('#ep-refresh');
  await session.page.locator('#ep-capture-name', { hasText: 'UI 桩麦克风' }).waitFor({ timeout: 10_000 });
  assert.equal(await session.page.locator('#ep-capture-muted').textContent(), '是（麦克风被静音！）');
  assert.equal(await session.page.locator('#ep-render-name').textContent(), 'UI 桩扬声器');
  assert.equal(await session.page.locator('#ep-render-muted').textContent(), '是（扬声器放不出声）');

  // ② 今天安静点 — a POST to the real route, and the state line follows it.
  await session.page.click('#quiet');
  await session.page.locator('#p-state', { hasText: /SUSPENDED/ }).waitFor({ timeout: 10_000 });
  assert.match(String(await session.page.locator('#p-state').textContent()), /安静模式/, '安静之后页面要说清怎么恢复');

  // ③ 新会话 — the log is reset by the page itself after `POST /api/session`.
  await session.page.click('#new');
  await session.page.locator('#turns', { hasText: '新会话已开始' }).waitFor({ timeout: 10_000 });

  // ④ 打一句字并回车 — a full turn through the real route and the offline brain double, rendered
  //    back into the log. `模拟回复：` is `FakeBrainAdapter`'s deterministic reply (offline boot).
  const sentence = '你好呀';
  await session.page.fill('#input', sentence);
  await session.page.press('#input', 'Enter');
  await session.page.locator('#turns .item', { hasText: `模拟回复：${sentence}` }).waitFor({ timeout: 20_000 });

  for (const request of ['GET /api/field/endpoints', 'POST /api/quiet', 'POST /api/session', 'POST /api/turn']) {
    assert.ok(session.requests.includes(request), `页面应该真的请求了 ${request}，实际请求：${session.requests.join(', ')}`);
  }

  // The direct answer to "did the handler run?" — counted inside the page, not inferred from the DOM.
  const probeAfter = await session.probe();
  for (const listener of ['click #ep-refresh', 'click #quiet', 'click #new', 'submit #form']) {
    assert.ok(
      (probeAfter.calls[listener] ?? 0) > (probeBefore.calls[listener] ?? 0),
      `「${listener}」的处理器必须真的执行过（执行计数：${JSON.stringify(probeAfter.calls)}）`,
    );
  }

  // …and none of it produced an uncaught error.
  assert.deepEqual(session.pageErrors, [], '交互之后页面仍不得抛未捕获脚本错误');
  assert.deepEqual(session.consoleErrors, [], '交互之后控制台仍不得有 error 级输出');
});
