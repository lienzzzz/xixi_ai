/**
 * D0.1/D0.2：交互原型 `apps/demo-ui/` 由 `/demo/` 的三条静态路由提供，且旧调试页不被替换。
 *
 * 这一条用例守的是**接线**，不是页面好不好看：
 *   1. **三个资源真的取得到**：`/demo/`、`/demo/styles.css`、`/demo/app.js` 都是 200，且 content-type
 *      带 charset（少了它中文页面在浏览器里要靠猜编码）；封面页自己引用的那两个相对路径也按 `/demo/`
 *      解析得到 200，所以「页面能加载完成」不依赖我手抄的路径清单。
 *   2. **少一个斜杠不会静默退回模拟模式**：`/demo?mode=live` 302 到 `/demo/?mode=live`，**查询串必须保留**
 *      —— 丢掉它页面会变成 mock，而 mock 输出的格式和真实回复一模一样，只有角落里的模式徽章不同。
 *   3. **原型调用的接口真在这台服务上**：读接口逐个真请求；写接口挑最轻的一条证明路由存在
 *      （`/api/voice` 需要真 ASR socket，离线驱动不了，浏览器验证记录里单独说明）。
 *   4. **旧页面没有被动过**：`/` 仍是调试 fallback（带自己的 marker，且**不含**原型的 marker）；
 *      `/demo/` 不是通配静态服务器（`/demo/nope.js` → 404），免得多出一个读文件的注入面。
 *
 * Run: `npm run test:console`（也在 `npm test` 里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { startTrialPage, type TrialPageFixture } from './serve-chat-fixture.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'xixi-demo-route-'));
let page: TrialPageFixture;

before(async () => {
  page = await startTrialPage({ dataDir });
});

after(async () => {
  await page.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('D0.2 /demo/ 的三条静态路由', () => {
  const assets = [
    { path: '/demo/', name: '页面', type: 'text/html; charset=utf-8', contains: 'id="companion-toggle"' },
    { path: '/demo/styles.css', name: '样式表', type: 'text/css; charset=utf-8', contains: '.app-shell' },
    { path: '/demo/app.js', name: '脚本', type: 'text/javascript; charset=utf-8', contains: "get('mode') === 'live'" },
  ] as const;

  for (const asset of assets) {
    test(`${asset.name} ${asset.path} 返回 200 且 content-type 带 charset`, async () => {
      const response = await fetch(`${page.base}${asset.path}`);
      assert.equal(response.status, 200, `${asset.path} 应该是 200：\n${page.output()}`);
      assert.equal(response.headers.get('content-type'), asset.type);
      const body = await response.text();
      assert.ok(body.includes(asset.contains), `${asset.path} 的内容看起来不是${asset.name}（缺 ${asset.contains}）`);
      // `content-length` 与实际字节数一致：截断的静态文件在浏览器里表现为「脚本解析到一半就没有了」，
      // 那种错在页面上只留一句看不懂的 SyntaxError，这里先钉住。
      const declared = Number(response.headers.get('content-length'));
      assert.equal(declared, Buffer.byteLength(body), `${asset.path} 的 content-length 与实际字节数不一致`);
    });
  }

  test('页面自己引用的相对资源按 /demo/ 解析都能取到', async () => {
    const html = await (await fetch(`${page.base}/demo/`)).text();
    const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((match) => match[1]);
    // 只允许这两个（外加一个 data: 图标，正则不会匹配到它）：原型里不该再引第三个本地文件，
    // 否则 /demo/ 的路由表就得跟着长。
    assert.deepEqual(refs, ['styles.css', 'app.js']);
    for (const ref of refs) {
      const response = await fetch(`${page.base}/demo/${ref}`);
      assert.equal(response.status, 200, `/demo/${ref} 取不到：\n${page.output()}`);
    }
  });

  test('/demo（少一个斜杠）302 到 /demo/ 且保留查询串', async () => {
    const response = await fetch(`${page.base}/demo?mode=live`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/demo/?mode=live');
  });

  test('/demo/ 之外不是通配静态服务器（未知文件 404）', async () => {
    const response = await fetch(`${page.base}/demo/nope.js`);
    assert.equal(response.status, 404);
    const payload = (await response.json()) as { error?: string };
    assert.equal(payload.error, 'not found');
  });
});

describe('D0.2 原型在真实接口模式下调用的端点', () => {
  test('读接口逐个真请求（state / camera / proactive loop）', async () => {
    // 每条只断言原型真的读的那几个字段：`/api/state` 没有 `ok` 字段（它是会话状态，不是命令应答），
    // 所以这里不能拿一个统一的形状去套三条接口 —— 那会把「形状不同」误报成「接口坏了」。
    const reads = [
      { path: '/api/state', has: (payload: Record<string, unknown>) => typeof payload['sessionId'] === 'string' },
      { path: '/api/camera', has: (payload: Record<string, unknown>) => payload['ok'] === true && typeof payload['status'] === 'object' },
      { path: '/api/proactive/loop?cursor=0', has: (payload: Record<string, unknown>) => payload['ok'] === true && Array.isArray(payload['entries']) },
    ];
    for (const read of reads) {
      const response = await fetch(`${page.base}${read.path}`);
      assert.equal(response.status, 200, `${read.path} 应该是 200：\n${page.output()}`);
      const payload = (await response.json()) as Record<string, unknown>;
      assert.ok(read.has(payload), `${read.path} 的响应缺少原型要读的字段：${JSON.stringify(payload)}`);
    }
  });

  test('写接口在这台服务上存在（挑最轻的一条，不制造副作用）', async () => {
    // `/api/tts` 是原型「朗读回复」开关走的那条：切一次再切回来，除了一行日志没有别的副作用。
    const response = await fetch(`${page.base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(response.status, 200, `/api/tts 不存在或被拒：\n${page.output()}`);
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload['ok'], true);
    assert.equal(payload['ttsEnabled'], false);
  });

  test('文字一轮真的跑得通（原型的主路径）', async () => {
    const response = await fetch(`${page.base}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好，西西。', speak: false }),
    });
    assert.equal(response.status, 200, `/api/turn 应该是 200：\n${page.output()}`);
    const payload = (await response.json()) as { reply?: string | null; action?: string };
    assert.equal(payload.action, 'SPEAK');
    assert.ok((payload.reply ?? '').length > 0, '离线替身也该给出非空回复');
  });
});

describe('D0.2 旧调试页没有被替换', () => {
  test('/ 仍是原来的调试 fallback，且不含原型 marker', async () => {
    const response = await fetch(`${page.base}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = await response.text();
    // 旧页面的 marker（按住说、摄像头卡片、来源面板）：这些是它自己的接线，不能因为新增静态路由而消失。
    for (const marker of ['id="cam-card"', '按住说', 'id="form"', 'proactive']) {
      assert.ok(body.includes(marker), `调试页缺少自己的 marker「${marker}」`);
    }
    // 原型独有的 marker 一个都不该出现：`/` 没有变成 `/demo/` 的别名。
    for (const marker of ['id="companion-toggle"', '陪伴空间', 'app.js']) {
      assert.ok(!body.includes(marker), `调试页里出现了原型的东西「${marker}」`);
    }
  });
});
