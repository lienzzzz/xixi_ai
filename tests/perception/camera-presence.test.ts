/**
 * 摄像头在场检测（M6）—— 把 Python 回归测试接进 `npm test`，并在 TypeScript 侧再验一遍契约。
 *
 * 两件事，缺一不可：
 *   1. **运行 Python 回归测试**：在场判定、防抖、误检边角与「不上云」边界都在
 *      `services/perception-edge/`（Python + OpenCV），用 `tests/perception/test_presence.py`
 *      离线覆盖。`npm test` 必须把它们跑起来，否则「npm test 全绿」变成一句没有内容的话。
 *   2. **契约交叉验证**：Python 侧自己实现的 schema 子集可能过期，所以这里让 Python 产出
 *      真实的 `presence.changed` 事件 JSON，再用 `packages/contracts` 的 `validateEvent()`
 *      校验一遍——契约的权威实现只有 TypeScript 侧那一个。
 *
 * 解释器选择：**不猜**。按顺序探测 `XIXI_PERCEPTION_PYTHON`、`.venvs/cv4`、
 * `.venvs/field-probe`，要求 import cv2 + numpy 成功；一个都没有就**直接失败**并说明
 * 安装命令（这套测试是本任务的验收项，不允许静默跳过）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEvent, validateEvent } from '@xixi/contracts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PERCEPTION_DIR = join(REPO_ROOT, 'services', 'perception-edge');
const TESTS_DIR = join(REPO_ROOT, 'tests', 'perception');
const DATA_DIR = join(REPO_ROOT, 'data');
const PYTHON_TIMEOUT_MS = 180_000;
const PROBE = 'import cv2, numpy; print(cv2.__version__)';
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|bmp|avi|mp4)$/i;

/**
 * Directories the offline test itself may not add image files to. Note the split:
 *
 *   * `services/perception-edge` and `tests/perception` are asserted to contain **no image
 *     file at all** — these two directories belong to the code and must stay asset-free;
 *   * `data/` is a *before/after* comparison, because it legitimately holds images left by the
 *     T0 recon (`data/models/largest_selfie.jpg`, `lena.jpg`, `vtest.avi`,
 *     `data/recon/camera-frame-{DSHOW,ANY}-0.png`). A wholesale "data/ must be empty"
 *     assertion would be false; "no *new* image appears while the detector runs" is the
 *     property that actually matters, and it is the one asserted below.
 */
const WATCHED_IMAGE_DIRS = [PERCEPTION_DIR, TESTS_DIR];

function walkImageFiles(root: string, found: string[] = []): string[] {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walkImageFiles(full, found);
    else if (IMAGE_EXTENSIONS.test(entry.name)) found.push(full);
  }
  return found;
}

/** File NAMES under `data/` (not paths): a moved file is not "new", a fresh capture is. */
function imageNameSet(root: string): Set<string> {
  return new Set(walkImageFiles(root).map((file) => file.replace(/\\/g, '/').split('/').pop() as string));
}

/**
 * Names present after the run but not before. Extracted so the watching rule itself is
 * testable: an assertion that can never fire is worse than no assertion, because it reads as
 * coverage. `test('the data/ watching rule detects a newly written image')` pins this down.
 */
function newImageNames(before: ReadonlySet<string>, after: readonly string[]): string[] {
  return after.filter((name) => !before.has(name)).sort();
}

function pythonCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.XIXI_PERCEPTION_PYTHON;
  if (fromEnv !== undefined && fromEnv.length > 0) candidates.push(fromEnv);
  const venvs = join(REPO_ROOT, '.venvs');
  if (existsSync(venvs)) {
    // Deterministic order: the pinned OpenCV 4.x venv first, then the rest.
    const names = readdirSync(venvs).sort((left, right) => {
      const rank = (name: string): number => (name === 'cv4' ? 0 : name === 'field-probe' ? 1 : 2);
      return rank(left) - rank(right) || left.localeCompare(right);
    });
    for (const name of names) {
      for (const suffix of ['Scripts/python.exe', 'bin/python3', 'bin/python']) {
        candidates.push(join(venvs, name, ...suffix.split('/')));
      }
    }
  }
  candidates.push('python', 'python3', 'py');
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

function probe(candidate: string): { ok: boolean; version: string } {
  if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) {
    return { ok: false, version: 'not installed' };
  }
  const result = spawnSync(candidate, ['-c', PROBE], { encoding: 'utf8', timeout: 60_000 });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, version: (result.stderr ?? String(result.error ?? '')).trim().split('\n').slice(-1)[0] ?? 'failed' };
  }
  return { ok: true, version: (result.stdout ?? '').trim() };
}

const resolution: { python: string | null; opencv: string; tried: string[] } = (() => {
  const tried: string[] = [];
  for (const candidate of pythonCandidates()) {
    const outcome = probe(candidate);
    tried.push(`${candidate} -> ${outcome.ok ? `cv2 ${outcome.version}` : outcome.version}`);
    if (outcome.ok) return { python: candidate, opencv: outcome.version, tried };
  }
  return { python: null, opencv: '', tried };
})();

function requirePython(): string {
  if (resolution.python === null) {
    assert.fail(
      [
        '找不到带 OpenCV 的 Python 解释器，摄像头在场检测的回归测试无法运行。',
        '这不是「跳过」：请安装一个隔离 venv（AGENTS.md 第 7 节）：',
        '  py -3.12 -m venv .venvs/cv4',
        '  .venvs/cv4/Scripts/python.exe -m pip install "opencv-python-headless<5" numpy',
        '（需要用 Haar 时必须 pin <5；只用 YuNet 时 5.x 也可以）',
        '当前探测结果：',
        ...resolution.tried,
      ].join('\n'),
    );
  }
  return resolution.python;
}

function run(command: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: PYTHON_TIMEOUT_MS });
  if (result.error !== undefined && result.error.message.includes('ETIMEDOUT')) {
    assert.fail(`${command} ${args.join(' ')} 超时（${PYTHON_TIMEOUT_MS} ms）`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('Python presence regression suite passes offline (tests/perception)', () => {
  const python = requirePython();
  const { status, stdout, stderr } = run(
    python,
    ['-m', 'unittest', 'discover', '-s', 'tests/perception', '-t', 'tests/perception', '-v'],
    REPO_ROOT,
  );
  const combined = `${stdout}\n${stderr}`;
  assert.equal(
    status,
    0,
    `Python 回归测试失败（解释器 ${python}，cv2 ${resolution.opencv}）：\n${combined.slice(-4000)}`,
  );
  assert.match(combined, /\bOK\b/, 'unittest 必须报告 OK');
  const ran = /Ran (\d+) tests?/.exec(combined);
  assert.ok(ran !== null, `unittest 没报告跑了多少测试：\n${combined.slice(-1000)}`);
  assert.ok(Number(ran[1]) >= 30, `测试数量异常少（${ran[1]}），怀疑发现失败`);
  // 允许 skip 只出现在「本机没有可选模型」的用例上；skipped 数量必须被显式记录。
  const skipped = /skipped=(\d+)/.exec(combined);
  if (skipped !== null) {
    assert.ok(Number(skipped[1]) <= 8, `skip 太多（${skipped[1]}），说明关键用例被跳过了：\n${combined.slice(-2000)}`);
  }
});

test('the Python producer emits events the released TypeScript contract accepts', () => {
  const python = requirePython();
  const { status, stdout, stderr } = run(
    python,
    ['-m', 'perception_edge.run', '--source', 'synthetic', '--scenario', 'person-arrives-moves-leaves', '--quiet-frames'],
    PERCEPTION_DIR,
  );
  assert.equal(status, 0, `合成场景运行失败：\n${stderr.slice(-2000)}`);

  const records = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const events = records.filter((record) => record.record === 'event');
  const summary = records.find((record) => record.record === 'summary');
  assert.ok(summary !== undefined, '缺少 summary 记录');

  // One startup announcement (the initial state), then the two real transitions: the
  // projection must exist from the first second, and a transition must be one event.
  assert.equal(summary.events, 3, 'summary 自己报告的事件数：启动 1 + 到达 1 + 离开 1');
  assert.equal(events.length, 3, '启动状态 1 条 + 到达 1 条 + 离开 1 条');
  const [startup, arrived, left] = events as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  assert.match(
    (startup.payload as { source_detail: string }).source_detail,
    /reason=camera_started/,
    '启动那一条必须写明是开机状态，而不是一次真实的转换',
  );
  assert.equal((summary.counters as Record<string, number>).frames_seen, summary.frames);
  for (const [record, expected] of [
    [startup, false],
    [arrived, true],
    [left, false],
  ] as const) {
    const raw = { ...record };
    delete raw.record;
    const validated = validateEvent(raw); // ContractError on any drift
    assert.equal(validated.event_type, 'presence.changed');
    assert.equal(validated.schema_version, 1);
    assert.deepEqual(Object.keys(validated.payload).sort(), ['present', 'source_detail']);
    assert.equal((validated.payload as { present: boolean }).present, expected);
    assert.match(validated.event_id, /^evt_[0-9a-f-]{36}$/);
    assert.match(validated.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.ok(!validated.timestamp.endsWith('Z'), '契约拒绝 Z 形式时间戳');

    // 同一个事件再走一遍权威构造器：字段一致才算「Python 与 TypeScript 生成同一件事」。
    const rebuilt = buildEvent({
      event_type: 'presence.changed',
      source: validated.source,
      actor: validated.actor,
      confidence: validated.confidence,
      room: validated.room,
      event_id: validated.event_id,
      correlation_id: validated.correlation_id,
      timestamp: validated.timestamp,
      payload: validated.payload,
    });
    assert.deepEqual(rebuilt, validated);
  }
});

test('the privacy boundary is enforced by the code, not only by the docs', () => {
  const python = requirePython();

  // Baseline BEFORE the detector runs: file NAME sets (not paths), so a moved file is not
  // reported as new, while a genuinely new capture is.
  const dataImagesBefore = imageNameSet(DATA_DIR);

  const { status, stderr } = run(python, ['-m', 'unittest', 'test_presence.PrivacyBoundaryTests', '-v'], TESTS_DIR);
  // unittest writes its summary to stderr; the exit code is the verdict.
  assert.equal(status, 0, `隐私边界测试必须通过（无网络客户端、无语义分析调用）：\n${stderr.slice(-2000)}`);
  assert.match(stderr, /\bOK\b/);

  // The two code/test directories must hold no image file at all.
  const stray: string[] = [];
  for (const dir of WATCHED_IMAGE_DIRS) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isFile() && IMAGE_EXTENSIONS.test(entry)) stray.push(full);
    }
  }
  assert.deepEqual(stray, [], '检测过程不得把画面落盘（服务目录与测试目录必须无图片）');

  // `data/` is compared, not required to be empty: the T0 recon left 5 image files there
  // (models + camera frames) and they must survive; nothing new may appear.
  const added = newImageNames(dataImagesBefore, walkImageFiles(DATA_DIR).map((file) => file.replace(/\\/g, '/').split('/').pop() as string));
  assert.deepEqual(
    added,
    [],
    '本断言只覆盖服务目录与测试目录的无图条件；data/ 用「文件名集合未新增」比较，' +
      '因为 data/ 里存在 T0 勘测留下的历史抓帧（models/ 的自查图与 recon/ 的 camera-frame-*.png）。' +
      `新增文件：${added.join(', ')}`,
  );
  assert.ok(
    dataImagesBefore.size >= 4,
    `data/ 的既有图片集看起来不对（${dataImagesBefore.size} 个）：若确实被清理过，请更新这条下界的说明`,
  );
});

test('the data/ watching rule detects a newly written image', () => {
  // The privacy test compares snapshots; this proves the comparison itself works, so a future
  // refactor cannot turn it into a check that silently never fires.
  const baseline = new Set(['camera-frame-DSHOW-0.png', 'largest_selfie.jpg']);
  assert.deepEqual(newImageNames(baseline, ['camera-frame-DSHOW-0.png', 'largest_selfie.jpg']), []);
  assert.deepEqual(newImageNames(baseline, ['camera-frame-DSHOW-0.png', 'fresh-capture.png']), ['fresh-capture.png']);
  // A moved file keeps its name, so moving the existing recon frames is not reported as new.
  assert.deepEqual(newImageNames(baseline, ['largest_selfie.jpg']), []);
  // …and the real data/ directory today still holds the recon assets (the baseline is not empty).
  assert.ok(imageNameSet(DATA_DIR).size >= 4, 'data/ 里应当仍有 T0 勘测留下的图片');
});
