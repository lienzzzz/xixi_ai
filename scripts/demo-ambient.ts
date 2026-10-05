/** Software-only endpoint demo. Every store is temporary; no API or hardware is opened. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, dirname } from 'node:path';
import { FakeBrainAdapter, type ToolRegistry } from '@xixi/brain-adapter';
import { openXixiStore } from '@xixi/domain';
import { AmbientRuntime, loadEndpointProfile, REPLAY_CONFIG, REPO_ROOT, type AmbientEvent } from '@xixi/runtime';

const START = Date.parse('2026-10-05T08:00:00+08:00');
const config = { ...REPLAY_CONFIG, proactive: { enabled: true, new_session_min_gap_min: 0,
  triggers: { presence_arrived: true, future_hook_due: true, conversation_dangling: false, topic_pool: false, random_smalltalk: false } } };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const profileIndex = args.indexOf('--profile');
  let profilePath = join(REPO_ROOT, 'config/ambient.example.json');
  if (profileIndex !== -1) {
    const value = args[profileIndex + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('用法：--profile 设备档案.json');
    profilePath = resolve(value);
    args.splice(profileIndex, 2);
  }
  if (args.length > 0 && (args.length !== 2 || args[0] !== '--recover')) throw new Error('用法：npm run demo:ambient（离线临时库演示）');
  const { devices, roomId } = loadEndpointProfile(profilePath);
  const camera = devices.find((d) => d.kind === 'camera')!.id;
  const microphones = devices.filter((d) => d.kind === 'microphone');
  const mic1 = microphones[0]!.id;
  const mic2 = microphones[1]?.id ?? mic1;
  const speaker = devices.find((d) => d.kind === 'speaker')!.id;
  const child = args[0] === '--recover';
  const dir = child ? resolve(args[1] ?? '') : mkdtempSync(join(tmpdir(), 'xixi-ambient-demo-'));
  if (child && (dirname(dir).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(dir).startsWith('xixi-ambient-demo-'))) throw new Error('恢复子进程只允许演示创建的临时目录');
  let at = new Date(START + (child ? 80_000 : 0));
  let store = openXixiStore({ dataDir: dir, clock: () => at, offsetMinutes: 480 });
  store.seedSelfProfile({ proactivity: 0.85, silence_tolerance: 0.7 });
  const open = () => AmbientRuntime.open({ store, config, devices, roomId, clock: () => at, consent: true, offsetMinutes: 480,
    modelFactory: (registry: ToolRegistry) => new FakeBrainAdapter({ registry, now: () => at }),
    decide: (_input, scene) => ({ speak: !scene.busy, reasonCode: scene.busy ? 'user_busy' : 'good_moment' }),
  });
  let runtime = open();
  let serial = 0;
  const send = async (seconds: number, kind: AmbientEvent['kind'], values: Record<string, unknown> = {}) => {
    at = new Date(START + seconds * 1000);
    return runtime.dispatch({ schemaVersion: 1, eventId: `demo-${++serial}`, roomId, at: at.toISOString(), kind, ...values } as AmbientEvent);
  };
  try {
    if (child) {
      assert.equal(store.reminders().length, 1);
      assert.ok(store.semanticMemories().some((m) => m.statement.includes('茉莉')));
      assert.equal(runtime.snapshot().presence, 'unknown');
      assert.ok(runtime.snapshot().outputs.every((o) => o.status === 'completed' || o.status === 'interrupted'));
      console.log(JSON.stringify({ schemaVersion: 1, childRecovery: true, pendingReminders: store.reminders().filter((r) => r.status === 'pending').length }));
      return;
    }
    console.log('西西单主人软件模拟：不调用 API，不访问摄像头/麦克风/扬声器。');
    console.log('模型与读空气使用脚本替身；实际设备识别与听感未验证。');
    await send(0, 'presence', { deviceId: camera, occupants: ['father'] });
    await send(0, 'scene', { busy: true });
    assert.equal((await send(1, 'tick')).reasonCode, 'MODEL_DECLINED');
    console.log('① 主人进入但正在忙：读空气选择暂缓。');
    await send(2, 'scene', { busy: false });
    const greet = await send(3, 'tick');
    assert.equal(greet.reasonCode, 'PASSED');
    await send(4, 'playback', { deviceId: speaker, outputId: greet.outputId, action: 'complete' });
    console.log('② 空闲后主动问候：进入模拟扬声器账本并确认播放完成。');
    await send(5, 'speech', { deviceId: mic1, utteranceId: 'owner-preference', actor: 'father', address: 'direct', text: '我喜欢喝茉莉花茶' });
    const facts = store.semanticMemories().length;
    assert.ok(facts > 0);
    await send(10, 'presence', { deviceId: camera, occupants: ['father', 'guest'] });
    await send(11, 'speech', { deviceId: mic1, utteranceId: 'guest-preference', actor: 'guest', address: 'direct', text: '我喜欢喝咖啡' });
    const guestMemoryWrites = store.semanticMemories().length - facts;
    assert.equal(guestMemoryWrites, 0);
    console.log('③ 访客交流：不写入主人的长期偏好。');
    await send(13, 'presence', { deviceId: camera, occupants: ['father'] });
    const speech = { utteranceId: 'owner-reminder', actor: 'father', address: 'direct', text: '提醒我喝水' };
    await send(14, 'speech', { ...speech, deviceId: mic1 });
    const duplicate = await send(15, 'speech', { ...speech, deviceId: mic2 });
    assert.equal(duplicate.reasonCode, 'DUPLICATE_INPUT');
    assert.equal(store.reminders().length, 1);
    await send(16, 'speech', { deviceId: mic1, utteranceId: 'barge', actor: 'father', address: 'direct', text: '等等，先别说' });
    assert.ok(runtime.snapshot().outputs.some((o) => o.reasonCode === 'BARGE_IN'));
    console.log(microphones.length > 1 ? '④ 双麦克风同一句只处理一次；插话停止旧播放。' : '④ 同一麦克风的重复事件只处理一次；插话停止旧播放。');
    await runtime.close(); store.close();
    const recovered = JSON.parse(execFileSync(process.execPath, ['scripts/demo-ambient.ts', '--recover', dir, '--profile', profilePath], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15_000 })) as { childRecovery: boolean };
    assert.equal(recovered.childRecovery, true);
    at = new Date(START + 81_000);
    store = openXixiStore({ dataDir: dir, clock: () => at, offsetMinutes: 480 });
    runtime = open();
    console.log('⑤ 独立新进程确认记忆与提醒保留；在途输出不重播，在场状态回到未知。');
    await send(82, 'presence', { deviceId: camera, occupants: ['father'] });
    const due = await send(83, 'tick');
    assert.equal(due.reasonCode, 'PASSED');
    assert.equal(store.reminders()[0]?.status, 'candidate');
    await send(84, 'playback', { deviceId: speaker, outputId: due.outputId, action: 'complete' });
    assert.equal(store.reminders()[0]?.status, 'delivered');
    const reminderId = store.reminders()[0]?.id;
    await send(85, 'acknowledge', { actor: 'father', reminderId });
    assert.equal(store.reminders()[0]?.status, 'acknowledged');
    console.log('⑥ 提醒到期、完成模拟播放、主人确认：状态 acknowledged。');
    console.log(JSON.stringify({ schemaVersion: 1, duplicateInputs: 1, guestMemoryWrites, reminderStatus: store.reminders()[0]?.status,
      childRecovery: recovered.childRecovery, outputs: runtime.snapshot().outputs.length, roomId, deviceCount: devices.length, hardwareVerified: false }));
    console.log('软件模拟验收通过。');
  } finally {
    await runtime.close();
    store.close();
    if (!child) rmSync(dir, { recursive: true, force: true });
  }
}

await main();
