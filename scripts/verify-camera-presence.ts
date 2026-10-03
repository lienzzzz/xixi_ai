/**
 * 摄像头在场检测验收（M6）：用**真实摄像头**跑一遍，并把事件写进真正的西西事件日志。
 *
 * 与离线测试的分工（不要混为一谈）：
 *   * `tests/perception/` 是离线的：帧是代码画的，断言的是**判定逻辑**（防抖、误检边角）；
 *   * 本脚本是**在线**的：真的打开摄像头、真的抓帧、真的写库，输出可判读的事件、帧率与耗时。
 *
 * 它做的事：
 *   1. 先打开一次 `XixiStore`（这样迁移必然跑过，Python 侧才能安全地只做 INSERT）；
 *   2. 用 `services/perception-edge` 抓帧若干秒（默认 20 s，摄像头 DSHOW 后端）；
 *   3. Python 把每个 `presence.changed` 事件**在数据库事务里**追加进 `events`；
 *   4. 脚本把事件按 `event_id` 去重、重建信封并用 `validateEvent()` 校验一遍，
 *      再读回 `world_state` 投影，打印帧率 / 抓帧耗时 / 检测耗时 / 状态。
 *
 * 两个库，别写混（`--db` 可显式覆盖，覆盖时会打印警告）：
 *   * 真实摄像头 → `data/perception/field-test.sqlite`（现场测试台账）；
 *   * `--self-test` → `data/perception/self-test.sqlite`（合成帧的**自检库**，默认单独一个文件），
 *     这样合成事件不会混进「真实摄像头」的台账里；旧版曾把自检帧写进 field-test 库，
 *     那批遗留事件在 `docs/design/perception.md` §8.2 里点名说明。
 *
 * 退出码：0 = 通过；2 = 没有可用摄像头（明确失败，不是静默跳过）；3 = 缺模型；1 = 其它失败
 * （含未知参数）。`--require-transition`（别名 `--require-event`）时，一次真实状态转换都没有
 * 也判失败（给「人真的站在镜头前」的实测用）。
 *
 * 相机朝向天花板、画面里没有人时，正常结果是「0 次转换」——那也是一种正确结果，
 * 所以默认**不**因为 0 转换而失败，只在 `--require-transition` 下失败。真人实测属于用户自测步骤，
 * 见 `docs/design/perception.md` §8.3。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { validateEvent, type EventEnvelope } from '@xixi/contracts';
import { PRESENCE_KEY, openXixiStore } from '@xixi/domain';

import { REPO_ROOT, printEvidence } from './lib/harness.ts';

const PERCEPTION_DIR = join(REPO_ROOT, 'services', 'perception-edge');
/**
 * Dedicated database for field tests, so a run of this script can never interfere with the
 * chat database (`data/xixi.sqlite`) that `npm run chat` uses.
 */
const DEFAULT_DB = join(REPO_ROOT, 'data', 'perception', 'field-test.sqlite');
/**
 * Self-test writes to its own ledger. The frames are synthetic, so their events are not
 * evidence about the room; keeping them in a separate file means "which database holds the
 * real camera's history" is answerable by looking at the file name, not by reading payloads.
 */
const SELF_TEST_DB = join(REPO_ROOT, 'data', 'perception', 'self-test.sqlite');
const PROBE = 'import cv2, numpy; print(cv2.__version__)';

const args = process.argv.slice(2);

/** The usage text is shared by `--help`, unknown-argument errors and the option table. */
const USAGE = `摄像头在场检测验收（M6）

用法：
  node scripts/verify-camera-presence.ts [选项]

选项（全部可选；不接受列表外的参数）：
  --seconds <n>                 用真实摄像头跑多少秒（默认 20）
  --db <path>                   事件日志路径（默认 data/perception/field-test.sqlite；
                                自检模式默认 data/perception/self-test.sqlite）
  --camera-index <n>            摄像头索引（默认 0）
  --self-test                   不打开摄像头：用生成的「脸 + 移动」帧跑通检测→事件→投影的写库路径
  --scenario <name>             --self-test 的场景名（默认 long-occlusion）
  --require-transition          至少有 1 次真实状态转换才算通过（一般人站在镜头前时用）
  --require-event               同 --require-transition（旧名，保留兼容）
  --min-fps <n>                 真实摄像头路径的处理帧率门槛（默认 20）
  --help                        打印本用法后退出（不打开摄像头、不写库）

退出码：0 通过；1 失败（含未知参数）；2 没有可用摄像头；3 缺少模型或解释器。

例：
  node scripts/verify-camera-presence.ts --seconds 15
  node scripts/verify-camera-presence.ts --self-test
  node scripts/verify-camera-presence.ts --seconds 40 --require-transition
  node scripts/verify-camera-presence.ts --live --seconds 10     实时预览路径（控制台「启用」用的同一条：帧只经内存与 localhost、在场事件照常落库；会打印图像文件的扫描范围）`;

/** Every accepted option. Anything else is refused loudly instead of being ignored. */
const OPTIONS_WITH_VALUE = new Set([
  '--seconds',
  '--db',
  '--camera-index',
  '--scenario',
  '--min-fps',
  '--live-fps',
]);
const FLAGS = new Set(['--self-test', '--require-transition', '--require-event', '--help', '--live']);

function parseArgs(argv: string[]): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  /** Numeric options legitimately take negative values (`--camera-index -1`). */
  const NUMERIC_OPTIONS = new Set(['--seconds', '--camera-index', '--min-fps', '--live-fps']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (FLAGS.has(token)) {
      flags.add(token);
      continue;
    }
    if (OPTIONS_WITH_VALUE.has(token)) {
      const value = argv[index + 1];
      const startsLikeFlag =
        value === undefined ||
        value.startsWith('--') ||
        (value.startsWith('-') && !(NUMERIC_OPTIONS.has(token) && /^-\d+$/.test(value)));
      if (startsLikeFlag) {
        console.error(`参数错误：${token} 需要一个值。\n\n${USAGE}`);
        process.exit(1);
      }
      values.set(token, value as string);
      index += 1;
      continue;
    }
    // An unknown argument used to be ignored silently, which turned a typo into a run with
    // default settings — the worst outcome, because it looks like it worked.
    //
    // A bare negative number is a VALUE, not a flag: `--camera-index -1` is a legitimate way to
    // ask for a camera that cannot exist, and `-1` must not be rejected as "unknown parameter".
    const looksLikeNegativeNumber = /^-\d+$/.test(token);
    if (looksLikeNegativeNumber) {
      console.error(
        `参数错误：${token} 像一个数值，但没有对应的选项。\n` +
          '如果你要指定不存在的摄像头索引，请写成「--camera-index ' +
          token +
          '」（例如 --camera-index -1 用来验证「打不开时会不会快速失败」）。\n\n' +
          USAGE,
      );
      process.exit(1);
    }
    const hint = token.startsWith('-') && !token.startsWith('--') ? '\n（选项要用两个短横线，例如 --seconds）' : '';
    console.error(`参数错误：无法识别的参数「${token}」。${hint}\n\n${USAGE}`);
    process.exit(1);
  }
  return { values, flags };
}

const parsed = parseArgs(args);
if (parsed.flags.has('--help')) {
  // Print and leave: no camera is opened, no database is written.
  console.log(USAGE);
  process.exit(0);
}

function argValue(name: string, fallback: string): string {
  return parsed.values.get(name) ?? fallback;
}
function hasFlag(name: string): boolean {
  return parsed.flags.has(name);
}

const selfTest = hasFlag('--self-test');
const seconds = Number(argValue('--seconds', '20'));
/** Explicit `--db` always wins; otherwise the mode picks its own ledger (see the header). */
const explicitDb = parsed.values.get('--db');
const dbPath = explicitDb ?? (selfTest ? SELF_TEST_DB : DEFAULT_DB);
const requireTransition = hasFlag('--require-event') || hasFlag('--require-transition');
const qualityFloorFps = Number(argValue('--min-fps', '20'));
/**
 * t89: `--camera-index` was parsed and documented but **never forwarded to the child**, so the
 * option did nothing — the script always opened index 0. That is exactly why "point it at a camera
 * that cannot exist" never produced a failure to observe: the request never left this process.
 */
const cameraIndex = Number(argValue('--camera-index', '0'));

if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error(`参数错误：--seconds 需要正数，收到「${argValue('--seconds', '')}」。\n\n${USAGE}`);
  process.exit(1);
}
if (!Number.isFinite(qualityFloorFps) || qualityFloorFps <= 0) {
  console.error(`参数错误：--min-fps 需要正数，收到「${argValue('--min-fps', '')}」。\n\n${USAGE}`);
  process.exit(1);
}
if (!Number.isInteger(cameraIndex)) {
  console.error(`参数错误：--camera-index 需要整数（摄像头设备索引），收到「${argValue('--camera-index', '')}」。\n\n${USAGE}`);
  process.exit(1);
}
if (explicitDb !== undefined && selfTest) {
  console.error(
    `注意：你显式指定了 --db ${explicitDb}，所以自检的合成事件会写进这个库，而不是默认的自检库 ${SELF_TEST_DB}。\n` +
      '      合成事件不是关于房间的证据；要么去掉 --db 让它单独落库，要么在消费时忽略这次运行写入的记录。',
  );
}

/** Same search order as tests/perception/camera-presence.test.ts: never guess silently. */
function pythonCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.XIXI_PERCEPTION_PYTHON;
  if (fromEnv !== undefined && fromEnv.length > 0) candidates.push(fromEnv);
  const venvs = join(REPO_ROOT, '.venvs');
  if (existsSync(venvs)) {
    const names = readdirSync(venvs).sort((left, right) => {
      const rank = (name: string): number => (name === 'cv4' ? 0 : name === 'field-probe' ? 1 : 2);
      return rank(left) - rank(right) || left.localeCompare(right);
    });
    for (const name of names) {
      candidates.push(join(venvs, name, 'Scripts', 'python.exe'));
      candidates.push(join(venvs, name, 'bin', 'python3'));
    }
  }
  candidates.push('python', 'python3', 'py');
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

function probe(candidate: string): boolean {
  if ((candidate.includes('\\') || candidate.includes('/')) && !existsSync(candidate)) return false;
  const result = spawnSync(candidate, ['-c', PROBE], { encoding: 'utf8', timeout: 60_000 });
  return result.status === 0;
}

const python = pythonCandidates().find((candidate) => probe(candidate));
if (python === undefined) {
  console.error(
    [
      '摄像头在场检测 FAILED：找不到带 OpenCV 的 Python 解释器。',
      '  py -3.12 -m venv .venvs/cv4',
      '  .venvs/cv4/Scripts/python.exe -m pip install "opencv-python-headless<5" numpy',
      '（Haar 需要 opencv<5；只用 YuNet 时 5.x 也可）',
    ].join('\n'),
  );
  process.exit(3);
}

// Open the store once so migrations are guaranteed to have run before Python writes.
mkdirSync(dirname(dbPath), { recursive: true });
const store = openXixiStore({ dbPath });
const dbFile = store.dbPath;
const before = store.eventCount();
const beforePresence = store.readEvents({ type: 'presence.changed', limit: Number.MAX_SAFE_INTEGER }).length;
/**
 * When this run started, in the filesystem's clock: the image-file check (t81) only counts files
 * created/changed after this instant, so pre-existing images in `data/` are not mistaken for
 * something the live path wrote.
 */
const imageBaselineAtMs = Date.now();

interface FrameRecord {
  frame: number;
  signal: boolean;
  motion: number;
  motion_ratio: number;
  faces: number;
  face_ran: boolean;
  detect_ms: number;
  state: string;
  state_changed: boolean;
  decision_reason: string;
}
interface SummaryRecord {
  frames: number;
  elapsed_s: number;
  fps_processed: number;
  detect_ms_mean: number;
  detect_ms_p95: number;
  events: number;
  final_state: string;
  face_backend: string;
  camera: Record<string, number> | null;
  counters: Record<string, number>;
  privacy: Record<string, unknown>;
  semantic_analysis: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Budget handed to the child for waiting on the device. Measured (t89): the whole run must come
 * back in about 5 s, and this process needs 1-1.5 s of its own for probing the interpreter and
 * opening the store. 2.5 s here leaves the end-to-end failure path inside the target even when the
 * DSHOW constructor is slow (measured 0.1-1.4 s across runs) while still giving a real device time
 * to answer — enumeration is fast; it is waiting for a device that does not exist that is pointless.
 */
const CHILD_CAMERA_OPEN_TIMEOUT_S = 2.5;

const pythonArgs = [
  '-m',
  'perception_edge.run',
  '--seconds',
  String(seconds),
  // t89: forwarded, not assumed. Without this line `--camera-index` was inert and a run against a
  // non-existent index silently opened the default device instead of failing.
  '--camera-index',
  String(cameraIndex),
  '--db',
  dbFile,
  '--append',
  '--quiet-frames',
  '--threads',
  '1',
  // t89: the whole point is that the caller gets an answer in seconds. This process also spends
  // time probing interpreters and opening the store, so the child's own device wait is capped
  // below the 5 s target instead of using the module's own default.
  '--camera-open-timeout',
  String(CHILD_CAMERA_OPEN_TIMEOUT_S),
];
if (hasFlag('--self-test')) {
  // No real person is needed (and no real person is present): play the generated
  // "person walks through the frame" scene through the *same* detect → emit → DB path.
  // This is explicitly NOT the real-face acceptance — that one needs a human and is
  // documented as a user step in docs/design/perception.md §8.3.
  pythonArgs.push('--source', 'synthetic', '--scenario', argValue('--scenario', 'long-occlusion'), '--frames', '2000');
}
// t78: the console's 「启用」 runs the same module in `--live` mode (frames on stdout as base64
// JPEG, picture in memory only). This flag is the CLI way to check that path on this machine.
const liveMode = hasFlag('--live');
if (liveMode) {
  pythonArgs.length = 0;
  pythonArgs.push(
    '-m',
    'perception_edge.run',
    '--live',
    '--live-fps',
    argValue('--live-fps', '8'),
    '--camera-index',
    String(cameraIndex),
    '--db',
    dbFile,
    '--append',
    '--quiet-frames',
    '--threads',
    '1',
    '--camera-open-timeout',
    String(CHILD_CAMERA_OPEN_TIMEOUT_S),
  );
  if (hasFlag('--self-test')) pythonArgs.push('--source', 'synthetic', '--scenario', argValue('--scenario', 'long-occlusion'));
}

console.log(
  selfTest
    ? `自检模式：用生成帧（不是真人）跑通检测→事件→投影的写库路径；写入自检库 ${dbPath}`
    : `用真实摄像头跑 ${seconds} s（索引 ${cameraIndex}）：${python} -m perception_edge.run（摄像头 DSHOW，画面不出本机）；写入台账 ${dbPath}`,
);
const frames: FrameRecord[] = [];
/** t78 `--live`: one entry per frame the child streamed on stdout (base64 JPEG in memory). */
const liveFrames: Record<string, unknown>[] = [];
let summary: SummaryRecord | null = null;
let stderrTail = '';
let stoppedForLive = false;
/**
 * Widow watchdog (t89): the child is expected to finish on its own — `--seconds` for the finite
 * modes, and for `--live` it is this script that closes stdin. If neither happens (a driver that
 * hangs in `VideoCapture`, a blocked read), the caller must still get an answer instead of an
 * endless wait. Budget = what we asked for + a generous buffer for process start and shutdown.
 */
let watchdogFired = false;
let killedByWatchdog = false;
const watchdogMs = liveMode ? Math.max(1, seconds) * 1000 + 20_000 : Math.max(1, seconds) * 1000 + 15_000;

/**
 * Lines that come from OpenCV's C++ layer rather than from our own Python code. The field-test
 * page shows the child's stderr verbatim, so a raw `[ WARN:0@0.12] global cap.cpp:477 …` line
 * would reach the user as English noise about an internal file. `run.py` already silences
 * OpenCV's logger; this is the second line of defence for builds where that API is unavailable.
 */
const NATIVE_WARNING_PATTERNS = [/^\[\s*(WARN|ERROR|FATAL|INFO):/i, /\bglobal\s+[\w./-]+\.(cpp|hpp|h):\d+/i, /VIDEOIO\s*\(/i];

function splitChildStderr(text: string): { ours: string; native: string[] } {
  const ours: string[] = [];
  const native: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (NATIVE_WARNING_PATTERNS.some((pattern) => pattern.test(trimmed))) native.push(trimmed);
    else ours.push(trimmed);
  }
  return { ours: ours.join('\n'), native };
}

const pythonExit = await new Promise<number>((resolve) => {
  const child = spawn(python, pythonArgs, {
    cwd: PERCEPTION_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      // The child prints Chinese reasons on stderr; without UTF-8 mode a Chinese Windows install
      // encodes them with the ANSI code page (GBK) and the page, which decodes UTF-8, shows
      // mojibake. `run.py` also reconfigures its streams — both, on purpose (t89).
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    child.kill();
    // On Windows `kill()` is TerminateProcess; if the child is stuck inside a driver call it may
    // need a moment. Escalate only if it is still alive.
    const escalate = setTimeout(() => {
      if (!killedByWatchdog) child.kill('SIGKILL');
    }, 3000);
    child.on('close', () => clearTimeout(escalate));
  }, watchdogMs);
  child.on('close', () => {
    clearTimeout(watchdog);
    killedByWatchdog = watchdogFired;
  });
  if (liveMode) {
    // The live loop runs until its stdin closes; this CLI stops it after --seconds (the console
    // stops it with the 停用 button instead). Close stdin first and give the child a moment to
    // finish its loop and print `live_summary` — on Windows `kill()` maps to TerminateProcess, so
    // killing immediately would destroy the very evidence we want (the child's own final report).
    setTimeout(() => {
      stoppedForLive = true;
      try {
        child.stdin?.end();
      } catch {
        /* already gone */
      }
      const hardStop = setTimeout(() => child.kill(), 2500);
      child.on('close', () => clearTimeout(hardStop));
    }, Math.max(1, seconds) * 1000);
  }
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.record === 'frame') frames.push(record as unknown as FrameRecord);
      else if (record.type === 'frame') liveFrames.push(record);
      else if (record.record === 'summary') summary = record as unknown as SummaryRecord;
      else if (record.type === 'live_summary') summary = record as unknown as SummaryRecord;
      else if (record.record === 'event') console.log(`  事件 ${String(record.event_id)} present=${String((record.payload as { present: boolean }).present)}`);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2000);
  });
  child.on('error', (error) => {
    stderrTail += `\n${error.message}`;
    resolve(1);
  });
  child.on('close', (code) => resolve(code ?? 1));
});

const after = store.eventCount();
const stored = store.readEvents({ type: 'presence.changed', limit: Number.MAX_SAFE_INTEGER }).slice(beforePresence);
const projection = store.worldState(PRESENCE_KEY);
store.close();

/** Only our own Chinese lines reach the operator; OpenCV's native lines are dropped (t89). */
const childStderr = splitChildStderr(stderrTail);
const childReason = childStderr.ours.trim();

if (watchdogFired) {
  // The child did not finish in its budget and was terminated. Say so, in Chinese, with the
  // numbers — the caller's job is to show this sentence, not to guess what a bare exit code meant.
  console.error(
    [
      `摄像头在场检测 FAILED：等待子进程超过 ${Math.round(watchdogMs / 1000)} 秒仍没有结束，已结束它（不会一直等下去）。`,
      childReason.length > 0 ? `子进程最后的中文说明：${childReason}` : '子进程在被结束前没有给出中文说明。',
      '可能原因：设备不存在 / 被别的程序占用（相机 App、会议软件、另一个预览窗口）/ Windows 隐私设置禁止了相机。',
      '先关掉占用摄像头的程序，或用 --camera-index 换一个索引（环境变量 XIXI_PERCEPTION_PYTHON 可指定解释器）。',
    ].join('\n'),
  );
  process.exit(2);
}
if (pythonExit === 2) {
  console.error(
    [
      '摄像头在场检测 FAILED：没有可用的摄像头。',
      childReason.length > 0 ? childReason : '（子进程没有留下中文说明）',
      '可能原因：设备不存在 / 被别的程序占用（相机 App、会议软件、另一个预览窗口）/ Windows 隐私设置禁止了相机。',
      '先关掉占用摄像头的程序，或换 --camera-index（环境变量 XIXI_PERCEPTION_PYTHON 可指定解释器）。',
    ].join('\n'),
  );
  process.exit(2);
}
if (pythonExit === 3) {
  console.error(`摄像头在场检测 FAILED：缺少模型文件或解释器。\n${childReason}`);
  process.exit(3);
}
if (pythonExit !== 0 && !(liveMode && stoppedForLive)) {
  console.error(`摄像头在场检测 FAILED：perception-edge 退出码 ${pythonExit}\n${childReason}`);
  process.exit(1);
}
// 约定（t81 写进文档：docs/design/perception.md §7.1）：`--live` 由**我们**在 --seconds 之后主动停
// （先关 stdin 再 SIGTERM）。Windows 上被终止的子进程报 exit 1、没有信号标记——这是正常停止，
// 不是失败；漏掉这一行的调用方（或评审）会把「停用」误报成验收失败。
if (liveMode && stoppedForLive && pythonExit !== 0) {
  console.log(`（正常停止：子进程被本脚本停掉，Windows 上返回 exit ${pythonExit}；按约定不算失败。）`);
}

if (liveMode) {
  // t78/t81: the same check for the console's 「启用」 path — frames must arrive *with a picture*,
  // the picture must stay in memory (nothing on disk), and the presence events must still be
  // written. 口径（t81 起写清）：
  //   * 「不保存图像」= 画面只经内存与 localhost；**在场事件照常写库**（事件才是产品）。
  //   * 「0 个图像文件」只对下面列出的扫描范围成立，扫描范围会被打印出来（以前只扫了库目录）。
  const withPicture = liveFrames.filter((frame) => typeof frame.jpeg === 'string' && String(frame.jpeg).length > 0);
  const bytes = withPicture.map((frame) => Number(frame.jpeg_bytes ?? 0));
  const liveProblems: string[] = [];
  if (liveFrames.length === 0) liveProblems.push('实时模式一帧都没收到：子进程没有进入 --live 循环');
  if (withPicture.length !== liveFrames.length) {
    liveProblems.push(`有 ${liveFrames.length - withPicture.length} 帧没有 JPEG 数据（页面会看不到画面）`);
  }
  if (bytes.some((value) => value <= 0)) liveProblems.push('有帧的 jpeg_bytes 是 0');
  const eventsWritten = after - before;
  if (eventsWritten <= 0) liveProblems.push('实时模式的 presence 事件没有落库（world_state 投影不会更新）');
  /** Everywhere a frame could plausibly land; each entry is a directory we really walked. */
  const scanScopes = [
    dirname(dbPath),
    join(REPO_ROOT, 'data'),
    PERCEPTION_DIR,
    tmpdir(),
  ];
  const imageFiles: { readonly scope: string; readonly file: string }[] = [];
  /** Only files created/changed **by this run** count: `data/` legitimately holds older images
   * (the YuNet self-check images and the T0 recon frames). Scanning for "any image" would fail on
   * files that were already there — the check must be about what this run wrote. The baseline is
   * taken before the child starts (see `imageBaselineAtMs`). */
  const runStartedAtMs = imageBaselineAtMs;
  const walk = (scope: string, dir: string, recursive: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && entry.name !== 'node_modules' && entry.name !== '.git') walk(scope, full, recursive);
        continue;
      }
      if (!/\.(jpe?g|png|bmp|webp)$/i.test(entry.name)) continue;
      try {
        if (statSync(full).mtimeMs < runStartedAtMs) continue;
      } catch {
        continue;
      }
      imageFiles.push({ scope, file: full });
    }
  };
  for (const scope of scanScopes) walk(scope, scope, scope !== tmpdir());
  // What the child itself reports — the field really exists in `live_summary` (t81), so this is a
  // checked statement rather than an outside guess. A hard kill can lose the summary; say so
  // instead of pretending the child reported anything.
  const selfReport = summary === null ? null : ((summary as unknown as { images_written?: number }).images_written ?? null);
  if (imageFiles.length > 0) {
    liveProblems.push(`实时模式在这些范围内留下了图像文件：${imageFiles.map((row) => `${row.file}（${row.scope}）`).join(', ')}`);
  }
  if (selfReport !== null && selfReport !== 0) liveProblems.push(`子进程 live_summary 自报 images_written=${selfReport}（应为 0）`);
  const report = selfReport === null ? '（没等到 live_summary：子进程被强杀或还没打印）' : String(selfReport);
  console.log(
    [
      `实时模式（--live）结果：收到 ${liveFrames.length} 帧，其中 ${withPicture.length} 帧带画面，`,
      `平均 ${bytes.length > 0 ? Math.round(bytes.reduce((sum, value) => sum + value, 0) / bytes.length / 1024) : 0} KB/帧；`,
      `presence 事件落库 ${eventsWritten} 条（事件照常入库，这是设计）；子进程 live_summary 自报 images_written=${report}。`,
      `图像文件扫描范围（共 ${scanScopes.length} 处，只看本次运行新建/改动的，命中 ${imageFiles.length} 个，必须是 0）：${scanScopes.join('；')}`,
      `解释器：${python}；库：${dbFile}。`,
    ].join('\n'),
  );
  if (liveProblems.length > 0) {
    console.error(['实时模式 FAILED：', ...liveProblems.map((row) => `  - ${row}`)].join('\n'));
    process.exit(1);
  }
  console.log('实时模式 OK：画面只经内存与 localhost 到页面、在场事件照常入库、上述范围内没有图像文件。');
  process.exit(0);
}

const uniqueEvents = new Map<string, EventEnvelope>();
const contractProblems: string[] = [];
for (const record of stored) {
  const envelope: EventEnvelope = {
    schema: 'xixi.event.v1',
    schema_version: record.schema_version,
    event_id: record.event_id,
    event_type: record.event_type,
    timestamp: record.timestamp,
    source: record.source,
    room: record.room,
    actor: record.actor,
    confidence: record.confidence,
    correlation_id: record.correlation_id,
    payload: record.payload,
  };
  try {
    uniqueEvents.set(record.event_id, validateEvent(JSON.parse(JSON.stringify(envelope))));
  } catch (cause) {
    contractProblems.push(`${record.event_id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const eventList = [...uniqueEvents.values()].map((event) => ({
  event_id: event.event_id,
  event_type: event.event_type,
  timestamp: event.timestamp,
  source: event.source,
  confidence: event.confidence,
  payload: event.payload,
}));
/**
 * t99: brightness evidence from the frames the child reported. A camera whose driver hands out
 * blank buffers looks *identical* to an empty room in the event log (both say "nobody is there"),
 * so the acceptance output has to carry the pixels' own testimony: if every frame has max 0, the
 * picture never arrived and "0 transitions" must not be read as "we looked and the room was empty".
 */
const motionRatios = frames.map((frame) => Number(frame.motion_ratio ?? 0));
const framesWithAnySignal = frames.filter((frame) => frame.signal === true).length;
const movementEvidence = {
  motion_ratio_max: motionRatios.length > 0 ? Math.max(...motionRatios) : null,
  motion_ratio_mean:
    motionRatios.length > 0 ? Number((motionRatios.reduce((sum, value) => sum + value, 0) / motionRatios.length).toFixed(5)) : null,
  frames_with_signal: framesWithAnySignal,
  evidence_note:
    movementEvidenceNote(framesWithAnySignal, motionRatios),
} as { motion_ratio_max: number | null; motion_ratio_mean: number | null; frames_with_signal: number; evidence_note: string };

/**
 * Whether the run saw *any* movement evidence. With a blank stream every `motion_ratio` is 0 and no
 * frame carries a signal, which is exactly the same summary an empty-but-working room produces —
 * this note states which reading the numbers support so a report cannot quietly claim the second.
 */
function movementEvidenceNote(signals: number, ratios: number[]): string {
  const max = ratios.length > 0 ? Math.max(...ratios) : 0;
  if (signals > 0 || max > 0) {
    return `画面里确实出现了运动/人脸证据（frames_with_signal=${signals}）——这次的「无人」是看过画面的结论。`;
  }
  return (
    `整个运行期没有任何运动证据（frames_with_signal=0，motion_ratio 全 0）：可能是房间真的没人，` +
    '也可能是驱动回传空帧/纯色帧。要区分请先跑 ' +
    'python -m perception_edge.run --probe-frames 10（逐帧亮度 + 中文结论），' +
    '或让一个人走到镜头前重跑并加 --require-transition。'
  );
}
/**
 * A startup record is a state announcement (`reason=camera_started`), not a transition the
 * detector observed. Keeping them apart matters: otherwise `--require-transition` would be
 * satisfied by the startup row and the check would prove nothing.
 */
const startupEvents = eventList.filter((event) =>
  String((event.payload as { source_detail?: string | null }).source_detail ?? '').includes('reason=camera_started'),
);
const transitions = eventList.filter((event) => !startupEvents.includes(event));
/**
 * The child's `live_summary`, read **after** the run.
 *
 * `summary` is assigned inside the child's stdout handler, so control-flow analysis still sees its
 * initializer (`null`) down here — and optional chaining on that gives `never`. The declared type is
 * the truth at this point; saying so once beats casting at every read.
 */
const finalSummary = summary as SummaryRecord | null;
const fps = finalSummary?.fps_processed ?? 0;
const framesProcessed = finalSummary?.frames ?? frames.length;
const syntheticRun = selfTest;
const problems: string[] = [...contractProblems];
if (!syntheticRun && finalSummary !== null && finalSummary.camera !== null && framesProcessed > 0) {
  // The camera read loop is the ceiling; the detector must not be the bottleneck.
  const cameraFps = (finalSummary.camera.fps_measured as number | undefined) ?? 0;
  if (cameraFps > 0 && fps < cameraFps * 0.5) {
    problems.push(`处理帧率 ${fps} 明显低于抓帧帧率 ${cameraFps}：检测耗时吃掉了余量`);
  }
}
if (!syntheticRun && framesProcessed > 0 && fps > 0 && fps < qualityFloorFps) {
  problems.push(`处理帧率 ${fps} < 门槛 ${qualityFloorFps} fps（真实摄像头路径必须跟得上抓帧）`);
}
if (requireTransition && transitions.length === 0) {
  problems.push(
    '要求至少有 1 次真实的状态转换，但整个运行期只有启动状态：人是否真的站在镜头前？' +
      '（镜头朝向无人时 0 次转换是正确结果；要验证「有人能被检出」请用 --self-test 或让真人站到镜头前）',
  );
}

const payload = {
  db: dbFile,
  db_choice: explicitDb !== undefined ? 'explicit --db' : selfTest ? 'self-test ledger (synthetic frames)' : 'field-test ledger (real camera)',
  db_note: selfTest
    ? `自检帧是合成的：本运行写入 ${explicitDb === undefined ? '专用自检库 data/perception/self-test.sqlite' : `显式指定的库 ${dbFile}`}，` +
      '它的 presence 事件不是关于房间的证据，消费方不要把自检库当成现场台账。'
    : '真实摄像头台账：每条 presence.changed 都来自本机摄像头的一帧。',
  seconds,
  mode: syntheticRun ? 'self-test (generated frames, not a real person)' : 'real camera',
  python,
  frames_processed: framesProcessed,
  frames_with_signal: frames.filter((frame) => frame.signal).length,
  fps_processed: fps,
  camera: finalSummary?.camera ?? null,
  detector: {
    face_backend: finalSummary?.face_backend ?? null,
    detect_ms_mean: finalSummary?.detect_ms_mean ?? null,
    detect_ms_p95: finalSummary?.detect_ms_p95 ?? null,
    counters: finalSummary?.counters ?? null,
  },
  events_written_by_python: finalSummary?.events ?? null,
  events_in_log: eventList.length,
  startup_events: startupEvents.length,
  transitions: transitions.length,
  movement_evidence: movementEvidence,
  events: eventList,
  event_trail: transitions.map((event) => ({
    at: event.timestamp,
    present: (event.payload as { present: boolean }).present,
    confidence: event.confidence,
  })),
  /**
   * t109: where the rows in this run came from, read from the `mode=` marker the child now writes
   * into `source_detail`. Reported so a reader of this output never has to guess whether a
   * `present_confirmed` row was produced by real frames or by generated ones.
   */
  source_modes: {
    expected: syntheticRun ? 'synthetic' : 'camera',
    from_events: [
      ...new Set(
        eventList
          .map((event) => /(?:^|\s)mode=(\w+)/.exec(String((event.payload as { source_detail?: string | null }).source_detail ?? ''))?.[1])
          .filter((value): value is string => value !== undefined),
      ),
    ],
    unmarked_events: eventList.filter(
      (event) => !/(?:^|\s)mode=\w+/.test(String((event.payload as { source_detail?: string | null }).source_detail ?? '')),
    ).length,
  },
  world_state: projection,
  privacy: finalSummary?.privacy ?? null,
  semantic_analysis: finalSummary?.semantic_analysis ?? null,
  events_delta: after - before,
  contract_problems: contractProblems,
  problems,
  verdict: problems.length === 0 ? 'PASS' : 'FAIL',
};

printEvidence('摄像头在场检测验收（真实摄像头 → 本地检测 → presence.changed → world_state）', payload);

if (problems.length > 0) {
  console.error(`\n摄像头在场检测验收 FAILED：${problems.length} 个问题`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
if (eventList.length === 0 || transitions.length === 0) {
  const noEvidence = movementEvidence.frames_with_signal === 0 && (movementEvidence.motion_ratio_max ?? 0) === 0;
  console.log(
    `\n摄像头在场检测 PASS（${eventList.length} 条状态记录，0 次真实转换，且没有任何问题）。\n` +
      (syntheticRun
        ? `自检写入的是${explicitDb === undefined ? '专用自检库' : '你显式指定的库'}：${dbFile}\n`
        : '') +
      // t99: distinguish "we looked and the room was empty" from "no picture ever arrived".
      (noEvidence && !syntheticRun
        ? '注意：这次运行**没有任何运动证据**（motion_ratio 全 0）。房间真的没人、和驱动回传空帧，' +
          '在事件日志里长得一样——先把画面本身验一下：\n' +
          '  python -m perception_edge.run --probe-frames 10   # 在 services/perception-edge 下跑，逐帧亮度 + 中文结论\n'
        : '注意：当前摄像头画面里没有人，所以「0 次转换」是正确结果，不是遗漏。\n') +
      '要验收「人在镜头前能被检出」，二选一：\n' +
      '  node scripts/verify-camera-presence.ts --self-test        # 用生成的「脸 + 移动」帧跑同一条写库路径（写入自检库）\n' +
      '  node scripts/verify-camera-presence.ts --seconds 40 --require-transition   # 让真人站到镜头前',
  );
} else {
  console.log(
    `\n摄像头在场检测验收 PASS：${transitions.length} 次状态转换（${transitions
      .map((event) => ((event.payload as { present: boolean }).present ? '有人' : '无人'))
      .join(' → ')}）；最终投影 ${String(projection?.value)}（stale=${String(projection?.stale)}）；写入 ${dbFile}`,
  );
}
