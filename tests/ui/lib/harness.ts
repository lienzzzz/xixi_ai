/**
 * Shared harness for the two UI tiers ([ADR-0021](../../../docs/adr/0021-browser-ui-testing.md)).
 *
 * The repository shipped a defect class no gate could see: the console page's inline `<script>`
 * lost one level of backslash escaping inside its TypeScript template, the emitted JavaScript
 * contained a raw newline *inside a string literal*, and the whole block died in the parser —
 * **not a single listener was attached** while `tests/console/*` (text assertions only) stayed
 * green. Both tiers here exist to close that hole, and they read the page from **one** source:
 * `buildConsolePage()` calls the real `buildFieldPage()`. If the fast tier analysed a hand-typed
 * copy of the markup it would be grading the copy, not the page.
 *
 *   * fast tier — `tests/ui/smoke/page-script.test.ts`, inside `npm test`: zero dependencies
 *     (`node:vm` compiles the extracted blocks, plain regexes find the element ids). No browser,
 *     no network, no database.
 *   * deep tier — `tests/ui/e2e/page-behavior.test.ts`, `npm run test:ui` only: real Chromium
 *     loads the page from the real HTTP server and the assertions are about *behaviour* —
 *     zero `pageerror`, and the key controls really run their handlers.
 *
 * What the fast tier can and cannot see is written down in `docs/testing.md` §3.2; the short
 * version is: it catches "this script cannot parse" and "this lookup aims at an id that is not in
 * the markup", and it cannot catch anything that only happens at run time (a handler reading a
 * property that does not exist, an id that is only created later by script). That is the deep
 * tier's job.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

import type { Browser, Page } from 'playwright';

import {
  buildFieldPage,
  createFieldServer,
  readCalibration,
  retentionPolicy,
  type FieldBootstrap,
  type FieldServerHandle,
  type ProbeRunner,
} from '../../../scripts/field-test.ts';
import { REPO_ROOT, loadConfig } from '../../../scripts/lib/harness.ts';

// ============================================================ page under test

/**
 * The boot the tiers analyse. It is deliberately the *offline, no-key* boot: that is the one the
 * page must survive on a fresh checkout, and it keeps the fast tier away from any code path that
 * could reach for a network or a key.
 */
export function consolePageBoot(overrides: Partial<FieldBootstrap> = {}): FieldBootstrap {
  return {
    listen: '127.0.0.1:8792',
    offline: true,
    ttsEnabled: false,
    modelConfigured: false,
    calibration: readCalibration(join(REPO_ROOT, 'data', 'ui-harness-no-calibration.json')),
    policy: retentionPolicy(loadConfig()),
    databasePath: join(REPO_ROOT, 'data', 'field-test'),
    ...overrides,
  };
}

/** The real page, exactly as `GET /` would serve it (same builder, same boot shape). */
export function buildConsolePage(overrides: Partial<FieldBootstrap> = {}): string {
  return buildFieldPage(consolePageBoot(overrides));
}

// ============================================================ fast tier: static checks

/** One inline script block, in page order. */
export interface PageScript {
  readonly index: number;
  /** `''` for a classic script, otherwise the `type="…"` attribute. */
  readonly type: string;
  readonly code: string;
  /**
   * Page line where the block's first character sits. That is the `<script>` tag's own line: the
   * captured code starts immediately after `>`, so a leading newline belongs to the code, not to a
   * gap before it (getting this wrong by one is what makes a reported line point at `</script>`).
   */
  readonly line: number;
}

/** One element lookup the script performs with an id it names literally. */
export interface IdReference {
  readonly id: string;
  /** How the id was reached — `el()`, `getElementById()`, `querySelector('#…')`, `ids:{}`. */
  readonly via: string;
  readonly scriptIndex: number;
  /** Line inside its script block (1-based); a page-relative line is reported too. */
  readonly line: number;
  readonly pageLine: number;
}

export interface SyntaxProblem {
  readonly scriptIndex: number;
  readonly message: string;
}

/** Everything both fast-tier checks know about a page. */
export interface PageAnalysis {
  readonly scripts: readonly PageScript[];
  readonly definedIds: readonly string[];
  readonly references: readonly IdReference[];
  readonly syntaxProblems: readonly SyntaxProblem[];
  readonly missingIds: readonly IdReference[];
}

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const SCRIPT_TYPE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** Every inline script block of the page, with the line it starts on. */
export function extractPageScripts(html: string): PageScript[] {
  const scripts: PageScript[] = [];
  const pattern = new RegExp(SCRIPT_BLOCK.source, SCRIPT_BLOCK.flags);
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1] ?? '';
    const code = match[2] ?? '';
    const typeMatch = SCRIPT_TYPE.exec(attributes);
    scripts.push({
      index: scripts.length,
      type: typeMatch?.[1] ?? typeMatch?.[2] ?? '',
      code,
      line: lineOf(html, match.index ?? 0),
    });
  }
  return scripts;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * Compile each block the way a browser's parser would, without running a single statement.
 *
 * `node:vm`'s `Script` only *compiles*; nothing is executed, so the page's DOM calls never happen
 * and no side effect can leak into the test process. A syntax error here is exactly the historical
 * defect: the browser would refuse the same block, and the page would come up with no handlers.
 */
export function compilePageScripts(scripts: readonly PageScript[]): SyntaxProblem[] {
  const problems: SyntaxProblem[] = [];
  for (const script of scripts) {
    if (script.type !== '') {
      // A module block is NOT a syntax error, and pretending otherwise would be a false red. The
      // pages are single files with classic inline scripts (ADR-0021), so this is an explicit
      // "unsupported input" rather than a silent pass — the message says what to extend.
      problems.push({
        scriptIndex: script.index,
        message:
          `<script type="${script.type}"> is not a classic inline script: harness.ts only compiles classic blocks ` +
          '(a module block needs `vm.SourceTextModule` and a different loader model). Extend `compilePageScripts()` ' +
          'before switching a page to modules.',
      });
      continue;
    }
    try {
      new Script(script.code, { filename: `page-script-${script.index}.js` });
    } catch (error) {
      problems.push({ scriptIndex: script.index, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return problems;
}

const MARKUP_ID = /<[a-zA-Z][^>]*\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DYNAMIC_ID = /\.\bid\s*=\s*(?:"([^"]*)"|'([^']*)')|setAttribute\(\s*["']id["']\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)/g;

/**
 * Ids that exist in the page: the ones the markup declares, plus the ones the script assigns to a
 * node it creates (`.id = 'x'` / `setAttribute('id', 'x')`) — those exist at run time too, and
 * flagging them would be a false red.
 */
export function collectDefinedIds(html: string): string[] {
  const ids = new Set<string>();
  const markup = html.replace(new RegExp(SCRIPT_BLOCK.source, SCRIPT_BLOCK.flags), '');
  for (const match of markup.matchAll(new RegExp(MARKUP_ID.source, MARKUP_ID.flags))) {
    const id = match[1] ?? match[2];
    if (id !== undefined && id !== '') ids.add(id);
  }
  for (const script of extractPageScripts(html)) {
    for (const match of script.code.matchAll(new RegExp(DYNAMIC_ID.source, DYNAMIC_ID.flags))) {
      const id = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (id !== undefined && id !== '') ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Literal element lookups. Three shapes cover what a page can do without indirection:
 * `el('x')` (the console's own helper), `getElementById('x')`, `querySelector('#x')`.
 *
 * Indirection is deliberately *not* guessed at: `document.getElementById(PX.ids.save)` yields
 * nothing here. `ids = { … }` maps are read as a second, documented source (see below) because the
 * shared proactive panel is emitted that way — and a map whose value is not in the markup is a real
 * defect, not a false positive.
 */
export function collectIdReferences(scripts: readonly PageScript[]): IdReference[] {
  const references: IdReference[] = [];
  const patterns: readonly { readonly via: string; readonly pattern: RegExp }[] = [
    { via: 'el()', pattern: /\bel\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g },
    { via: 'getElementById()', pattern: /getElementById\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g },
    { via: "querySelector('#…')", pattern: /querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)["']\s*\)/g },
  ];
  for (const script of scripts) {
    for (const { via, pattern } of patterns) {
      for (const match of script.code.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const id = match[1] ?? match[2];
        if (id !== undefined) references.push(reference(id, via, script, match.index ?? 0));
      }
    }
    // `PX.ids = {"save":"px-save",…}` — the ids the shared panel looks up by name. The emitted map
    // is JSON (`JSON.stringify`), so quoted keys are the normal shape; a hand-written map with bare
    // keys is accepted too.
    const idMap = /\bids\s*[:=]\s*\{([^}]*)\}/g;
    for (const mapMatch of script.code.matchAll(idMap)) {
      const body = mapMatch[1] ?? '';
      const entry = /(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*(?:"([^"]+)"|'([^']+)')/g;
      for (const entryMatch of body.matchAll(entry)) {
        const id = entryMatch[4] ?? entryMatch[5];
        if (id !== undefined && /^[A-Za-z][\w-]*$/.test(id)) {
          references.push(reference(id, 'ids:{}', script, (mapMatch.index ?? 0) + (entryMatch.index ?? 0)));
        }
      }
    }
  }
  return references;
}

function reference(id: string, via: string, script: PageScript, index: number): IdReference {
  const line = lineOf(script.code, index);
  return { id, via, scriptIndex: script.index, line, pageLine: script.line + line - 1 };
}

/** References whose id the page never defines — the "button wired to a node that isn't there". */
export function findMissingIds(definedIds: readonly string[], references: readonly IdReference[]): IdReference[] {
  const defined = new Set(definedIds);
  return references.filter((item) => !defined.has(item.id));
}

/** Both fast-tier checks over one page, in one place so a fixture and the real page use one path. */
export function analyzePage(html: string): PageAnalysis {
  const scripts = extractPageScripts(html);
  const definedIds = collectDefinedIds(html);
  const references = collectIdReferences(scripts);
  return { scripts, definedIds, references, syntaxProblems: compilePageScripts(scripts), missingIds: findMissingIds(definedIds, references) };
}

/** One-line-per-problem text for assertion messages. */
export function describeReferences(references: readonly IdReference[]): string {
  return references.map((item) => `${item.id} ← ${item.via} (脚本 #${item.scriptIndex} 第 ${item.line} 行)`).join('; ');
}

// ============================================================ deep tier: real Chromium

/**
 * Chromium is not in the repository and must not be part of `npm test` (ADR-0021). Where the
 * binary lives is resolved in one place:
 *
 *   1. `XIXI_UI_BROWSER_PATH` — an explicit executable (a system Chrome, a container image, a
 *      machine that already has one). Nothing is downloaded.
 *   2. `PLAYWRIGHT_BROWSERS_PATH` — Playwright's own knob, honoured as given.
 *   3. `data/ms-playwright` — a repository-local download (gitignored, disposable). This is what
 *      `PLAYWRIGHT_BROWSERS_PATH=data/ms-playwright npm run test:ui:install` creates, and it is the
 *      only option on a machine where `~/.cache` is not writable (containers, sandboxes).
 *   4. nothing — Playwright's default cache (`~/.cache/ms-playwright`, `%USERPROFILE%\AppData\
 *      Local\ms-playwright`), which is where a plain `npm run test:ui:install` puts the binary.
 */
export function resolveBrowserExecutable(): string | undefined {
  const explicit = process.env['XIXI_UI_BROWSER_PATH'];
  return explicit === undefined || explicit === '' ? undefined : resolve(explicit);
}

/** `data/ms-playwright` when it really holds a downloaded browser, else `undefined`. */
export function repoLocalBrowsersPath(): string | undefined {
  const candidate = join(REPO_ROOT, 'data', 'ms-playwright');
  try {
    if (!statSync(candidate).isDirectory()) return undefined;
    return readdirSync(candidate).some((entry) => entry.startsWith('chromium')) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Point Playwright at the repository-local download before it is first imported. */
export function applyBrowserPathOverride(): void {
  if (process.env['XIXI_UI_BROWSER_PATH'] !== undefined || process.env['PLAYWRIGHT_BROWSERS_PATH'] !== undefined) return;
  const local = repoLocalBrowsersPath();
  if (local !== undefined) process.env['PLAYWRIGHT_BROWSERS_PATH'] = local;
}

/** The failure a missing browser must produce: loud, actionable, never a silent skip. */
export function missingBrowserError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
  const local = join(REPO_ROOT, 'data', 'ms-playwright');
  return new Error(
    '真实浏览器深档需要 Chromium，而版本库里没有浏览器二进制（ADR-0021）。这一次的加载失败了：' +
      `${detail}\n` +
      '取一次即可（约 280 MB，不进版本库）：\n' +
      '  npm run test:ui:install                                   # playwright install chromium --only-shell\n' +
      `  取不动或 ~/.cache 不可写时（容器/沙箱）：PLAYWRIGHT_BROWSERS_PATH=${local} npm run test:ui:install\n` +
      '  Windows PowerShell：$env:PLAYWRIGHT_BROWSERS_PATH="data/ms-playwright"; npm run test:ui:install\n' +
      '本机已有 Chrome/Chromium？直接指过去、不下载：XIXI_UI_BROWSER_PATH=<可执行文件路径> npm run test:ui\n' +
      '这条命令**不在默认门禁里**：`npm test` 不需要浏览器，也不需要这条。',
  );
}

export interface ConsoleServer {
  readonly url: string;
  readonly port: number;
  readonly dataDir: string;
  /** The real console server handle, for tests that want the resident runtime behind it. */
  readonly handle: FieldServerHandle;
  close(): Promise<void>;
}

/**
 * Deterministic device readings. The real probe spawns Python (`pycaw`); the deep tier is about the
 * page, so the server gets a stub that answers with names only this test knows — which is what makes
 * "the click really ran the handler and rendered server data" a real assertion instead of a
 * "something changed" shrug.
 */
export function stubDeviceReadings(): ProbeRunner {
  return async () => ({
    ok: true,
    readOnly: true,
    checkedAt: new Date(0).toISOString(),
    render: { label: 'render', name: 'UI 桩扬声器', muted: true, volumeScalar: 0.5, volumeDb: -6, gainDb: null },
    capture: { label: 'capture', name: 'UI 桩麦克风', muted: true, volumeScalar: 0.5, volumeDb: -6, gainDb: 0 },
  });
}

/** Boot the **real** console server on an ephemeral port, offline, writing only into a temp dir. */
export async function startConsoleServer(): Promise<ConsoleServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'xixi-ui-e2e-'));
  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    dataDir,
    presenceDataDir: dataDir,
    voiceDir: join(dataDir, 'voice'),
    reportDir: join(dataDir, 'reports'),
    probeRunner: stubDeviceReadings(),
    log: () => undefined,
  });
  return {
    url: handle.url,
    port: handle.port,
    dataDir,
    handle,
    close: async () => {
      await handle.close();
      removeTempDir(dataDir);
    },
  };
}

/** `rmSync` only ever runs on a directory this module created under `tmpdir()`. */
function removeTempDir(dir: string): void {
  const resolved = resolve(dir);
  if (!resolved.startsWith(resolve(tmpdir()))) {
    throw new Error(`拒绝删除临时目录之外的路径：${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

/**
 * Wraps `addEventListener` so the test can ask a direct question the DOM cannot answer by itself:
 * "did the page's own handler for this control actually run?" — the fast tier cannot see this at
 * all, and a `click()` that silently hits a dead page would otherwise look identical.
 */
const UI_PROBE_SCRIPT = `(() => {
  var probe = { listeners: {}, calls: {} };
  var original = EventTarget.prototype.addEventListener;
  var originalRemove = EventTarget.prototype.removeEventListener;
  var wrapped = new WeakMap();
  function label(target) {
    if (target === window) return 'window';
    if (target === document) return 'document';
    if (target && target.tagName) return target.id ? '#' + target.id : target.tagName.toLowerCase();
    return 'unknown';
  }
  function keyOf(target, type) { return type + ' ' + label(target); }
  window.__xixiUiProbe = probe;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    var key = keyOf(this, type);
    probe.listeners[key] = (probe.listeners[key] || 0) + 1;
    if (typeof listener === 'function') {
      var self = this;
      var handler = function (event) {
        probe.calls[key] = (probe.calls[key] || 0) + 1;
        return listener.call(self, event);
      };
      var byType = wrapped.get(listener) || {};
      byType[key] = handler;
      wrapped.set(listener, byType);
      return original.call(this, type, handler, options);
    }
    return original.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    var byType = listener && typeof listener === 'function' ? wrapped.get(listener) : undefined;
    var handler = byType ? byType[keyOf(this, type)] : undefined;
    return originalRemove.call(this, type, handler || listener, options);
  };
})();`;

export interface UiProbeSnapshot {
  readonly listeners: Readonly<Record<string, number>>;
  readonly calls: Readonly<Record<string, number>>;
}

export interface BrowserSession {
  readonly browser: Browser;
  readonly page: Page;
  /** HTTP status of the page request itself (`null` if the navigation carried no response). */
  readonly loadStatus: number | null;
  /** Uncaught script errors (the `pageerror` event) — the deep tier's headline assertion. */
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
  readonly failedRequests: string[];
  /** `"GET /api/field/state"`-shaped requests the page itself made. */
  readonly requests: string[];
  probe(): Promise<UiProbeSnapshot>;
  stop(): Promise<void>;
}

/** Launch real Chromium with the resolved browser path. Throws `missingBrowserError` when absent. */
export async function launchChromium(options: { readonly executablePath?: string } = {}): Promise<Browser> {
  // The override must be applied *before* Playwright is first imported: it reads the path when the
  // module is loaded, and the dynamic import below is the only place it enters this process.
  applyBrowserPathOverride();
  const executablePath = options.executablePath ?? resolveBrowserExecutable();
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch(executablePath === undefined ? { headless: true } : { headless: true, executablePath });
  } catch (error) {
    throw missingBrowserError(error);
  }
}

/** Open the page served by `server` in a real browser and start recording what it does. */
export async function openConsolePage(server: ConsoleServer, options: { readonly executablePath?: string } = {}): Promise<BrowserSession> {
  const browser = await launchChromium(options);
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ''}`);
  });
  await page.addInitScript(UI_PROBE_SCRIPT);
  const response = await page.goto(`${server.url}/`, { waitUntil: 'load' });
  return {
    browser,
    page,
    loadStatus: response === null ? null : response.status(),
    pageErrors,
    consoleErrors,
    failedRequests,
    requests,
    probe: async () =>
      await page.evaluate((): UiProbeSnapshot => {
        const holder = globalThis as unknown as { __xixiUiProbe?: UiProbeSnapshot };
        return holder.__xixiUiProbe ?? { listeners: {}, calls: {} };
      }),
    stop: async () => {
      await browser.close();
    },
  };
}

/**
 * Wait until the page has *run its own start-up code*: `#p-listen` is filled by
 * `renderState(payload)` after a real `GET /api/field/state` round trip, so the text only appears
 * when the script parsed, wired up, and reached the server. A dead script times out here — and the
 * error carries the captured `pageerror`, which is the actual diagnosis.
 *
 * The wait itself is Playwright's locator API rather than `page.waitForFunction`: the callback of
 * the latter would need DOM types, and this repository's `tsconfig.json` deliberately has no `dom`
 * lib (there is no browser code in TypeScript anywhere else). Locators run on the Node side, so the
 * check stays inside the same type program as the rest of the repository.
 */
export async function waitForPageBoot(session: BrowserSession, timeoutMs = 15_000): Promise<void> {
  try {
    await session.page.locator('#p-listen', { hasText: /^地址 / }).waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    const scriptErrors = session.pageErrors.length === 0 ? '（没有捕获到 pageerror）' : session.pageErrors.join(' | ');
    throw new Error(`页面没有完成启动（等待 #p-listen 超时，${timeoutMs}ms）：${reason}\n脚本错误：${scriptErrors}`);
  }
}
