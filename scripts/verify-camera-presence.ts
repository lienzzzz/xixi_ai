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
 * 退出码：0 = 通过；2 = 没有可用摄像头（明确失败，不是静默跳过）；3 = 缺模型；1 = 其它失败。
 * `--require-event` 时，一次都没产生 presence 事件也判失败（给「人真的站在镜头前」的实测用）。
 *
 * 相机朝向天花板、画面里没有人时，正常结果是「0 个事件」——那也是一种正确结果，
 * 所以默认**不**因为 0 事件而失败，只在 `--require-event` 下失败。真人实测属于用户自测步骤，
 * 见 `docs/design/perception.md`。
 *
 * 用法：
 *   node scripts/verify-camera-presence.ts --seconds 20
 *   node scripts/verify-camera-presence.ts --seconds 40 --require-event   # 人要站在镜头前
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { validateEvent, type EventEnvelope } from '@xixi/contracts';
import { PRESENCE_KEY, openXixiStore } from '@xixi/domain';

import { REPO_ROOT, printEvidence } from './lib/harness.ts';

const PERCEPTION_DIR = join(REPO_ROOT, 'services', 'perception-edge');
/**
 * Dedicated database for field tests, so a run of this script can never interfere with the
 * chat database (`data/xixi.sqlite`) that `npm run chat` uses. Override with `--db`.
 */
const DEFAULT_DB = join(REPO_ROOT, 'data', 'perception', 'field-test.sqlite');
const PROBE = 'import cv2, numpy; print(cv2.__version__)';

const args = process.argv.slice(2);
function argValue(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? (args[index + 1] as string) : fallback;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const seconds = Number(argValue('--seconds', '20'));
const dbPath = argValue('--db', DEFAULT_DB);
const requireTransition = hasFlag('--require-event') || hasFlag('--require-transition');
const qualityFloorFps = Number(argValue('--min-fps', '20'));

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
      '摄像头在场检测验收 FAILED：找不到带 OpenCV 的 Python 解释器。',
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

const pythonArgs = [
  '-m',
  'perception_edge.run',
  '--seconds',
  String(seconds),
  '--db',
  dbFile,
  '--append',
  '--quiet-frames',
  '--threads',
  '1',
];
if (hasFlag('--self-test')) {
  // No real person is needed (and no real person is present): play the generated
  // "person walks through the frame" scene through the *same* detect → emit → DB path.
  // This is explicitly NOT the real-face acceptance — that one needs a human and is
  // documented as a user step in docs/design/perception.md.
  pythonArgs.push('--source', 'synthetic', '--scenario', argValue('--scenario', 'long-occlusion'), '--frames', '2000');
}

console.log(
  hasFlag('--self-test')
    ? '自检模式：用生成帧（不是真人）跑通检测→事件→投影的写库路径'
    : `用真实摄像头跑 ${seconds} s：${python} -m perception_edge.run（摄像头 DSHOW，画面不出本机）`,
);
const frames: FrameRecord[] = [];
let summary: SummaryRecord | null = null;
let stderrTail = '';
const pythonExit = await new Promise<number>((resolve) => {
  const child = spawn(python, pythonArgs, { cwd: PERCEPTION_DIR, windowsHide: true });
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.record === 'frame') frames.push(record as unknown as FrameRecord);
      else if (record.record === 'summary') summary = record as unknown as SummaryRecord;
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

if (pythonExit === 2) {
  console.error(
    [
      '摄像头在场检测验收 FAILED：没有可用的摄像头。',
      stderrTail.trim(),
      '可能原因：设备不存在 / 被别的程序占用（相机 App、会议软件、另一个预览窗口）/ Windows 隐私设置禁止了相机。',
      '先关掉占用摄像头的程序，或换 --camera-index（环境变量 XIXI_PERCEPTION_PYTHON 可指定解释器）。',
    ].join('\n'),
  );
  process.exit(2);
}
if (pythonExit === 3) {
  console.error(`摄像头在场检测验收 FAILED：缺少模型文件。\n${stderrTail.trim()}`);
  process.exit(3);
}
if (pythonExit !== 0) {
  console.error(`摄像头在场检测验收 FAILED：perception-edge 退出码 ${pythonExit}\n${stderrTail.trim()}`);
  process.exit(1);
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
 * A startup record is a state announcement (`reason=camera_started`), not a transition the
 * detector observed. Keeping them apart matters: otherwise `--require-transition` would be
 * satisfied by the startup row and the check would prove nothing.
 */
const startupEvents = eventList.filter((event) =>
  String((event.payload as { source_detail?: string | null }).source_detail ?? '').includes('reason=camera_started'),
);
const transitions = eventList.filter((event) => !startupEvents.includes(event));
const fps = summary?.fps_processed ?? 0;
const framesProcessed = summary?.frames ?? frames.length;
const syntheticRun = hasFlag('--self-test');
const problems: string[] = [...contractProblems];
if (!syntheticRun && summary !== null && summary.camera !== null && framesProcessed > 0) {
  // The camera read loop is the ceiling; the detector must not be the bottleneck.
  const cameraFps = (summary.camera.fps_measured as number | undefined) ?? 0;
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
  seconds,
  mode: syntheticRun ? 'self-test (generated frames, not a real person)' : 'real camera',
  python,
  frames_processed: framesProcessed,
  frames_with_signal: frames.filter((frame) => frame.signal).length,
  fps_processed: fps,
  camera: summary?.camera ?? null,
  detector: {
    face_backend: summary?.face_backend ?? null,
    detect_ms_mean: summary?.detect_ms_mean ?? null,
    detect_ms_p95: summary?.detect_ms_p95 ?? null,
    counters: summary?.counters ?? null,
  },
  events_written_by_python: summary?.events ?? null,
  events_in_log: eventList.length,
  startup_events: startupEvents.length,
  transitions: transitions.length,
  events: eventList,
  event_trail: transitions.map((event) => ({
    at: event.timestamp,
    present: (event.payload as { present: boolean }).present,
    confidence: event.confidence,
  })),
  world_state: projection,
  privacy: summary?.privacy ?? null,
  semantic_analysis: summary?.semantic_analysis ?? null,
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
  console.log(
    `\n摄像头在场检测验收 PASS（${eventList.length} 条状态记录，0 次真实转换，且没有任何问题）。\n` +
      '注意：当前摄像头画面里没有人，所以「0 次转换」是正确结果，不是遗漏。\n' +
      '要验收「人在镜头前能被检出」，二选一：\n' +
      '  node scripts/verify-camera-presence.ts --self-test        # 用生成的「人脸 + 移动」帧跑同一条写库路径\n' +
      '  node scripts/verify-camera-presence.ts --seconds 40 --require-transition   # 让真人站到镜头前',
  );
} else {
  console.log(
    `\n摄像头在场检测验收 PASS：${transitions.length} 次状态转换（${transitions
      .map((event) => ((event.payload as { present: boolean }).present ? '有人' : '无人'))
      .join(' → ')}）；最终投影 ${String(projection?.value)}（stale=${String(projection?.stale)}）`,
  );
}
