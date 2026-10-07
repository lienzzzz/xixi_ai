/**
 * V0.3 P2.5-H — the `plugins` section: the deployment's plugin layer (directories / news / MCP).
 *
 * `config/xixi.example.yaml` used to say about its news block 「这一段今天是注释，不是可调键」: an operator
 * could edit a feed URL, restart, and nothing changed. This file is the offline gate for the section that
 * replaced it, and it pins the two properties that make the replacement worth having:
 *
 *   1. **A value that would not work is refused while the config loads** — with the full path in the
 *      message (`plugins.mcp.servers.weather.transport`), never silently defaulted. The tuning sections
 *      next to it (`tools`, `reminders`) tolerate junk on purpose; this one decides *what runs*, so
 *      tolerating a typo there means an operator staring at a key that looks set and does nothing.
 *   2. **The shipped example parses** — the strict parser is only usable if the file this repo ships
 *      passes it, and passing it is also the proof that the example declares no key the parser does not
 *      know (that is what "no key nobody reads" means mechanically).
 *
 * The shape of every fact below is `parseXixiConfig` → `config.plugins`, i.e. the same call a live entry
 * makes at startup (`scripts/lib/harness.ts` → `loadConfig()`); nothing here builds a runtime.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_PLUGIN_SETTINGS,
  DomainError,
  loadXixiConfig,
  MCP_TIMEOUT_MS_MAX,
  MCP_TIMEOUT_MS_MIN,
  parsePluginSettings,
  parseXixiConfig,
  type PluginSettings,
  type XixiConfig,
} from '@xixi/domain';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const EXAMPLE_CONFIG = join(REPO_ROOT, 'config', 'xixi.example.yaml');

/** The minimum a conversation cannot start without (same shape every other config test uses). */
const BASE_YAML = `
xixi:
  identity:
    name: 西西
    language: zh-CN
    timezone: Asia/Shanghai
    place: 成都
  models:
    llm: { provider: fake, model: fake-1, thinking_realtime: false }
    asr: { provider: fake, model: fake-asr }
    tts: { provider: fake, model: fake-tts }
  personality:
    base: {}
  proactive: {}
  memory: {}
  privacy: {}
  features: {}
`;

/** A full `plugins` section, exactly as `config/xixi.example.yaml` documents it. */
const FULL_PLUGINS = `  plugins:
    enabled: true
    directories:
      - ./plugins
    news:
      enabled: true
      interests: [本地, 天气]
      sources:
        - type: rss
          name: BBC World
          url: https://feeds.bbci.co.uk/news/world/rss.xml
        - type: rss
          url: https://example.com/feed.xml
    mcp:
      servers:
        weather:
          transport: stdio
          command: node
          args: ['./tools/weather-mcp.js']
          timeout_ms: 15000
        calendar:
          transport: http
          url: https://mcp.example.com/calendar
          risk: write
        retired:
          enabled: false
          transport: stdio
          command: node
`;

/** The same section as data, for the direct `parsePluginSettings` calls below. */
const PLUGINS_ONLY: Record<string, unknown> = {
  enabled: true,
  directories: ['./plugins'],
  news: {
    enabled: true,
    interests: ['本地', '天气'],
    sources: [
      { type: 'rss', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { type: 'rss', url: 'https://example.com/feed.xml' },
    ],
  },
  mcp: {
    servers: {
      weather: { transport: 'stdio', command: 'node', args: ['./tools/weather-mcp.js'], timeout_ms: 15_000 },
      calendar: { transport: 'http', url: 'https://mcp.example.com/calendar', risk: 'write' },
      retired: { enabled: false, transport: 'stdio', command: 'node' },
    },
  },
};

function config(extra = ''): XixiConfig {
  return parseXixiConfig(`${BASE_YAML}${extra}`, 'test-inline.yaml');
}

/** The refusal a bad value must produce: `INVALID_CONFIG`, and the message must name its path. */
function refused(extra: string, path: string, why = ''): DomainError {
  let error: DomainError | null = null;
  try {
    config(extra);
  } catch (caught) {
    assert.ok(caught instanceof DomainError, `expected DomainError, received ${String(caught)}`);
    assert.equal(caught.code, 'INVALID_CONFIG', `expected INVALID_CONFIG, got ${caught.code}: ${caught.message}`);
    error = caught;
  }
  assert.ok(error !== null, `this config must be refused (${why}), but it loaded: ${extra}`);
  assert.match(error.message, /configuration is not usable/, error.message);
  assert.ok(error.message.includes(path), `the refusal must name "${path}": ${error.message}`);
  return error;
}

test('缺段 = 出厂默认：没有 plugins 段的旧配置照旧加载，且默认「什么都不声明」', () => {
  const legacy = config();
  assert.deepEqual(legacy.plugins, DEFAULT_PLUGIN_SETTINGS, '缺段给的是出厂默认，不是加载失败');
  assert.deepEqual(DEFAULT_PLUGIN_SETTINGS, {
    enabled: true,
    directories: [],
    news: null,
    mcpServers: [],
  });
  // 默认值本身必须「什么也不做」：这就是「加配置不改变任何入口的默认工具集」的那一半。
  assert.equal(DEFAULT_PLUGIN_SETTINGS.news, null, 'news = null 表示「配置不管这一段」，入口自己声明的照旧');
  assert.deepEqual(DEFAULT_PLUGIN_SETTINGS.mcpServers, [], '没有 MCP 服务器');
  assert.deepEqual(DEFAULT_PLUGIN_SETTINGS.directories, [], '不扫描任何插件目录');
});

test('完整的 plugins 段解析成强类型：目录 / 新闻来源 / MCP 两种 transport', () => {
  const plugins = config(FULL_PLUGINS).plugins;
  assert.ok(plugins !== undefined, 'parseXixiConfig 必须把这一段解析出来（不是原始 Record）');
  assert.equal(plugins.enabled, true);
  assert.deepEqual(plugins.directories, ['./plugins']);
  assert.deepEqual(plugins.news, {
    enabled: true,
    sources: [
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'example.com', url: 'https://example.com/feed.xml' },
    ],
    interests: ['本地', '天气'],
  });
  assert.deepEqual(plugins.mcpServers, [
    { name: 'weather', enabled: true, risk: 'read', timeoutMs: 15_000, transport: 'stdio', command: 'node', args: ['./tools/weather-mcp.js'] },
    { name: 'calendar', enabled: true, risk: 'write', timeoutMs: null, transport: 'http', url: 'https://mcp.example.com/calendar' },
    { name: 'retired', enabled: false, risk: 'read', timeoutMs: null, transport: 'stdio', command: 'node', args: [] },
  ]);
  // 不写 risk 的来源默认 read（最窄的有用档）；`dangerous` 是允许写的，核心会一律拒绝它（铁律 7）。
  assert.equal(plugins.mcpServers[0]?.risk, 'read');
});

test('parsePluginSettings 自己的两个默认：name 取 URL 主机名、args 缺省为空表', () => {
  const parsed: PluginSettings = parsePluginSettings(PLUGINS_ONLY, 'inline.yaml');
  assert.equal(parsed.news?.sources[1]?.name, 'example.com', '不写 name 就用主机名，不凭空编一个出处');
  const retired = parsed.mcpServers[2];
  assert.ok(retired !== undefined && retired.transport === 'stdio', 'retired 必须是 stdio 那条');
  assert.deepEqual(retired.args, []);
  assert.equal(parsePluginSettings(undefined, 'inline.yaml'), DEFAULT_PLUGIN_SETTINGS, '缺段 = 出厂默认');
  assert.deepEqual(parsePluginSettings({}, 'inline.yaml'), DEFAULT_PLUGIN_SETTINGS, 'plugins: {} 同样是「什么都不声明」');
});

test('越界的值与写错的键一律拒（带路径），不是静默忽略', () => {
  // 每一条都是一种「看起来配了、其实没生效」的写法 —— 也就是这一步要消灭的那种失败。
  const cases: readonly { readonly why: string; readonly yaml: string; readonly path: string }[] = [
    { why: '段本身不是映射', yaml: '  plugins: []\n', path: '"plugins"' },
    { why: '总开关不是布尔', yaml: '  plugins:\n    enabled: yes-please\n', path: 'plugins.enabled' },
    { why: '目录写成一个字符串', yaml: '  plugins:\n    directories: ./plugins\n', path: 'plugins.directories' },
    { why: '目录列表里有空串', yaml: '  plugins:\n    directories: [""]\n', path: 'plugins.directories[0]' },
    { why: '键名拼错（dirctories）', yaml: '  plugins:\n    dirctories: []\n', path: 'plugins.dirctories' },
    { why: '新闻开着却一个来源都没有', yaml: '  plugins:\n    news:\n      enabled: true\n', path: 'plugins.news' },
    { why: 'news 不是映射', yaml: '  plugins:\n    news: rss\n', path: '"plugins.news"' },
    { why: 'sources 不是列表', yaml: '  plugins:\n    news:\n      sources: https://example.com/feed.xml\n', path: 'plugins.news.sources' },
    { why: '来源缺 type', yaml: '  plugins:\n    news:\n      sources:\n        - url: https://example.com/feed.xml\n', path: 'plugins.news.sources[0].type' },
    { why: 'json_api 不是配置能表达的来源（需要 map 函数）', yaml: '  plugins:\n    news:\n      sources:\n        - type: json_api\n          url: https://example.com/api\n', path: 'plugins.news.sources[0].type' },
    { why: 'URL 没有 scheme', yaml: '  plugins:\n    news:\n      sources:\n        - type: rss\n          url: feeds.example.com/rss.xml\n', path: 'plugins.news.sources[0].url' },
    { why: 'URL 不是 http(s)', yaml: '  plugins:\n    news:\n      sources:\n        - type: rss\n          url: ftp://example.com/feed.xml\n', path: 'plugins.news.sources[0].url' },
    { why: 'interests 拼成了 intersts', yaml: '  plugins:\n    news:\n      intersts: []\n', path: 'plugins.news.intersts' },
    { why: 'MCP 服务器没有 transport（不许猜）', yaml: '  plugins:\n    mcp:\n      servers:\n        weather:\n          command: node\n', path: 'plugins.mcp.servers.weather.transport' },
    { why: 'transport 写成了别的协议', yaml: '  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: grpc\n          command: node\n', path: 'plugins.mcp.servers.weather.transport' },
    { why: 'stdio 没有 command', yaml: '  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: stdio\n', path: 'plugins.mcp.servers.weather.command' },
    { why: 'stdio 却写了 url', yaml: '  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: stdio\n          command: node\n          url: https://example.com/mcp\n', path: 'plugins.mcp.servers.weather.url' },
    { why: 'http 却写了 args', yaml: '  plugins:\n    mcp:\n      servers:\n        calendar:\n          transport: http\n          url: https://example.com/mcp\n          args: [x]\n', path: 'plugins.mcp.servers.calendar.args' },
    { why: '服务器名带点（会变成 mcp.a.b.tool，读不回来）', yaml: '  plugins:\n    mcp:\n      servers:\n        a.b:\n          transport: stdio\n          command: node\n', path: 'plugins.mcp.servers.a.b' },
    { why: '服务器名与 mcp. 前缀重合', yaml: '  plugins:\n    mcp:\n      servers:\n        mcp:\n          transport: stdio\n          command: node\n', path: 'plugins.mcp.servers.mcp' },
    { why: 'timeout_ms 低于下界', yaml: `  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: stdio\n          command: node\n          timeout_ms: ${MCP_TIMEOUT_MS_MIN - 1}\n`, path: 'plugins.mcp.servers.weather.timeout_ms' },
    { why: 'timeout_ms 高于上界', yaml: `  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: stdio\n          command: node\n          timeout_ms: ${MCP_TIMEOUT_MS_MAX + 1}\n`, path: 'plugins.mcp.servers.weather.timeout_ms' },
    { why: 'risk 不在词汇表里', yaml: '  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: stdio\n          command: node\n          risk: safe\n', path: 'plugins.mcp.servers.weather.risk' },
    { why: '停用键拼成了 enable', yaml: '  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: stdio\n          command: node\n          enable: false\n', path: 'plugins.mcp.servers.weather.enable' },
    { why: 'mcp 段里的未知键', yaml: '  plugins:\n    mcp:\n      server:\n        weather: {}\n', path: 'plugins.mcp.server' },
  ];
  for (const entry of cases) refused(entry.yaml, entry.path, entry.why);
});

test('反事实：把被拒的那一行改对，同一份配置就加载得下来（判据不是恒真）', () => {
  // 同一段配置，只把「写错」的那一处改掉：一红一绿，否则上面那一堆拒绝可能只是「这份配置整体不合法」。
  const wrongType = '  plugins:\n    news:\n      sources:\n        - type: json_api\n          url: https://example.com/api\n';
  const rightType = '  plugins:\n    news:\n      sources:\n        - type: rss\n          url: https://example.com/api\n';
  const wrongTransport = '  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: grpc\n          command: node\n';
  const rightTransport = '  plugins:\n    mcp:\n      servers:\n        weather:\n          transport: stdio\n          command: node\n';
  refused(wrongType, 'plugins.news.sources[0].type');
  refused(wrongTransport, 'plugins.mcp.servers.weather.transport');
  assert.equal(config(rightType).plugins?.news?.sources.length, 1);
  assert.equal(config(rightTransport).plugins?.mcpServers[0]?.transport, 'stdio');
});

test('出厂配置本身就是一份合法配置：每个键都是解析器认识的键', () => {
  const shipped = loadXixiConfig(EXAMPLE_CONFIG);
  const plugins = shipped.plugins;
  assert.ok(plugins !== undefined, '示例配置必须有 plugins 段（不能再是「写了没人读」的注释）');
  assert.equal(plugins.enabled, true, '插件层默认开着');
  assert.deepEqual(plugins.directories, [], '出厂不扫描本地插件目录');
  assert.deepEqual(plugins.mcpServers, [], '出厂没有 MCP 服务器');
  // 出厂的新闻这一段是**具体的**（真 feed、真出处名），只是 `enabled: false`。
  // 这一条如果红了，通常是因为有人把 enabled 翻成了 true —— 那是「配置接管所有入口的新闻」，
  // 会让现场测试控制台与试用页多出 news.* 三个工具（tests/console/field-test-console.test.ts 钉着
  // 那条链上恰好只有三个内置工具），所以那次翻转必须与那条用例在**同一个**任务里改。
  assert.equal(plugins.news?.enabled, false, '出厂不接管新闻来源（翻成 true 之前先读这一条的注释）');
  assert.equal(plugins.news?.sources.length, 1, '出厂那份来源是真的，不是占位');
  assert.match(plugins.news.sources[0]?.url ?? '', /^https:\/\//);
  assert.ok((plugins.news.sources[0]?.name ?? '').length > 0);
  assert.deepEqual(plugins.news.interests, []);
});

test('示例配置里提醒工具的示例名跟着 T7 的改名走（不许留下已经不存在的名字）', () => {
  const source = readFileSync(EXAMPLE_CONFIG, 'utf8');
  // 那是操作者会照抄的一行：抄一个已经不存在的工具名，等于一条永远匹配不上的审批声明。
  assert.match(source, /xixi_set_reminder"/, '审批示例必须给出真名 xixi_set_reminder');
  assert.doesNotMatch(source, /xixi_set_reminder_stub/, 'T7 改名之后，示例名要跟着走');
});
