/**
 * Console-level tests for the two user-visible seams of t42:
 *
 *   1. **multi-segment replies (ADR-0010)** — the plan a page/terminal plays one-by-one, with
 *      the real pause, and the source badge (`回应你` vs `主动开口`);
 *   2. **the proactive engine's knobs (ADR-0009)** — switch, strength, quiet hours, the live
 *      gate table, the audit record, and "one click off really stops it".
 *
 * Both are driven through the real HTTP surface: `createFieldServer` for the console and a
 * spawned `serve-chat.ts --fake` for the trial page (no key, no network, no cost).
 *
 * Run: `npm run test:console` (also part of `npm test`).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_PROACTIVITY, parseProactiveSettings, proactiveThreshold } from '@xixi/conversation';

import { REPO_ROOT, loadConfig } from '../../scripts/lib/harness.ts';
import { startTrialPage } from './serve-chat-fixture.ts';
import {
  PROACTIVE_PANEL_IDS,
  applyAndPersistProactivePatch,
  applyProactiveSettingsPatch,
  createFakeProbeRunner,
  createFieldServer,
  effectiveProactivity,
  persistProactiveSettings,
  proactiveConsoleState,
  proactiveDrill,
  proactiveGateRows,
  proactivePanelHtml,
  proactivePanelScript,
  restoreProactiveSettings,
  segmentPlan,
} from '../../scripts/field-test.ts';
import { openXixiStore } from '@xixi/domain';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The window the console needs to answer a request; generous because the machine is shared. */
const HTTP_TIMEOUT_MS = 30_000;

test('a reply longer than one segment is planned as N pieces with the documented pause', () => {
  const short = segmentPlan('嗯，我在。', undefined);
  assert.equal(short.total, 1, 'a short reply stays one segment');
  assert.match(short.summary, /只有一段/);

  const long = segmentPlan(
    '明天要降温，白天也就十来度。你出门记得多穿一件外套，别像上次那样冻着手回来。我把伞放在门口了，晚上回来别忘了带进屋，阳台的窗户也记得关一下。',
    undefined,
  );
  assert.ok(long.total >= 2, `expected the long reply to split, got ${long.total}`);
  assert.equal(long.gapMs, 450, 'the pause comes from ADR-0010 的默认值');
  assert.equal(
    long.segments.join(''),
    '明天要降温，白天也就十来度。你出门记得多穿一件外套，别像上次那样冻着手回来。我把伞放在门口了，晚上回来别忘了带进屋，阳台的窗户也记得关一下。',
    'M4: 拼接必须与原文一致',
  );
  assert.match(long.summary, /分 \d+ 段说出/);
  assert.match(long.playbackHint, /每段之间 450ms/);
  assert.deepEqual(segmentPlan(null, undefined).segments, [], 'nothing to play is an empty plan, not a crash');
});

test('the gate table marks passed / blocked / skipped from the single reason code', () => {
  const passed = proactiveGateRows('PASSED');
  assert.equal(passed.length, 14, 'every reason code has a row');
  assert.ok(passed.every((row) => row.status === 'passed'), 'PASSED means every gate let it through');

  const quiet = proactiveGateRows('QUIET_HOURS');
  const blocked = quiet.filter((row) => row.status === 'blocked');
  assert.deepEqual(
    blocked.map((row) => row.code),
    ['QUIET_HOURS'],
    'exactly one gate is reported as blocking (the engine reports the first hit)',
  );
  assert.ok(quiet.findIndex((row) => row.code === 'QUIET_HOURS') > quiet.findIndex((row) => row.code === 'DND_ACTIVE'));
  assert.ok(quiet.slice(quiet.findIndex((row) => row.code === 'QUIET_HOURS') + 1).every((row) => row.status === 'skipped'), 'later gates are "not evaluated", never a fake pass');

  const disabled = proactiveGateRows('DISABLED');
  assert.equal(disabled[0]?.status, 'blocked');
  assert.ok(disabled.slice(1).every((row) => row.status === 'skipped'));
});

test('every gate of a drill is a row, and a blocked drill explains the next step', async () => {
  const root = tempDir('xixi-t42-core-');
  const store = openXixiStore({ dataDir: root });
  try {
    const now = new Date();
    const open = parseProactiveSettings({ enabled: true, base_cooldown_min: 0, quiet_hours: { start: '00:00', end: '00:00' } });
    const passed = await proactiveDrill({ store, settings: open, now, conversationState: 'IDLE', proactivity: 0.55, request: {} });
    assert.equal(passed.reasonCode, 'PASSED');
    assert.equal(passed.speak, true);
    assert.ok(passed.score >= passed.threshold, `score ${passed.score} should clear ${passed.threshold}`);
    assert.ok(passed.segments.length >= 2, 'the drill line is deliberately longer than one segment');
    assert.ok(passed.eventSequence !== null, 'an accepted consideration is written to the log');
    assert.equal(passed.gates.filter((row) => row.status === 'blocked').length, 0);

    const quiet = parseProactiveSettings({ enabled: true, base_cooldown_min: 0, quiet_hours: { start: '00:00', end: '23:59' } });
    const blocked = await proactiveDrill({ store, settings: quiet, now: new Date(now.getTime() + 60_000), conversationState: 'IDLE', proactivity: 0.55, request: {} });
    assert.equal(blocked.reasonCode, 'QUIET_HOURS');
    assert.equal(blocked.speak, false);
    assert.equal(blocked.segments.length, 0);
    assert.ok(blocked.nextStep.length > 0, 'a blocked candidate must tell the user what to do');

    const off = parseProactiveSettings({ enabled: false });
    const switchedOff = await proactiveDrill({ store, settings: off, now, conversationState: 'IDLE', proactivity: 0.55, request: {} });
    assert.equal(switchedOff.reasonCode, 'DISABLED');
    assert.equal(switchedOff.delivered, false);
    assert.equal(switchedOff.eventSequence, null, 'a switched-off engine logs no decision');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('settings changed on the page are persisted, restored, and validated field by field', () => {
  const root = tempDir('xixi-t42-settings-');
  const store = openXixiStore({ dataDir: root });
  try {
    const config = loadConfig();
    const before = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);
    assert.equal(before.source, 'config', 'nothing saved yet → the value comes from config/xixi.yaml');

    const patched = applyProactiveSettingsPatch(before.settings, {
      // `before + 1`, never a literal: t77 moved the shipped cooldown to 5 minutes, and a literal
      // that happens to equal the current default turns this patch into a silent no-op.
      baseCooldownMinutes: before.settings.baseCooldownMinutes + 1,
      maxPerDay: '3',
      quietStart: '21:15',
      quietEnd: 'nonsense',
      triggers: { random_smalltalk: true },
    });
    assert.equal(patched.settings.baseCooldownMinutes, before.settings.baseCooldownMinutes + 1);
    assert.equal(patched.settings.maxPerDay, 3, 'a numeric string is accepted');
    assert.equal(patched.settings.quietHours.startMinutes, 21 * 60 + 15);
    assert.equal(patched.settings.quietHours.endMinutes, before.settings.quietHours.endMinutes, 'a bad clock string keeps the current value');
    assert.equal(patched.settings.triggers.random_smalltalk, true);
    assert.ok(patched.rejected.some((row) => row.includes('quietEnd')), 'the page is told what was ignored');
    assert.ok(patched.changes.some((row) => row.includes('打扰代价衰减')), 'changes are described in Chinese for the audit trail');
    assert.ok(patched.changes.some((row) => row.includes('静默时段')));

    const event = persistProactiveSettings(store, patched.settings, patched.changes);
    assert.equal((event.payload as Record<string, unknown>).service, 'proactive-settings');
    const after = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);
    assert.equal(after.source, 'console', 'the saved value wins over the config file');
    assert.equal(after.settings.baseCooldownMinutes, before.settings.baseCooldownMinutes + 1);
    assert.equal(after.settings.quietHours.startMinutes, 21 * 60 + 15);
    assert.deepEqual(after.changes, patched.changes, 'the audit row keeps what changed');

    // A patch that asks for the value that is already in effect must stay a no-op.
    const noop = applyProactiveSettingsPatch(after.settings, { baseCooldownMinutes: after.settings.baseCooldownMinutes });
    assert.equal(noop.changes.length, 0, 'saving the same value writes nothing');
    assert.equal(noop.rejected.length, 0, 'a no-op is not a rejection either');

    const state = proactiveConsoleState({ store, settings: after.settings, source: after.source, updatedAt: after.updatedAt, changes: after.changes, now: new Date(), personality: { proactivity: 0.6, talkativeness: 0.45, verbosity: 0.4 } });
    assert.equal(state.audit.length, 1);
    assert.equal(state.triggerLabels.length, 6);
    assert.equal(state.threshold, proactiveThreshold(0.6));
    assert.equal(state.quietHours.start, '21:15');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('the panel exposes the personality controls (proactivity / talkativeness / verbosity)', () => {
  const html = proactivePanelHtml();
  assert.ok(html.includes(`id="${PROACTIVE_PANEL_IDS.proactivity}"`), 'the panel has the 主动性总强度 control');
  assert.ok(html.includes(`id="${PROACTIVE_PANEL_IDS.proactivityNow}"`), 'and shows the value in effect');
  assert.match(html, /主动性总强度（人格 proactivity）/, 'labelled so nobody confuses it with the quota knobs');
  assert.match(html, /self_profile/, 'and says where it is written');
  assert.match(html, /硬底线一道都不会被跳过/, 'and that it cannot skip a hard floor gate');
  assert.match(html, /模型也可以对建议说「不说」/, 'and that the model may decline a recommendation');
  // t74: the two talkativeness knobs use the same write + audit path.
  assert.ok(html.includes(`id="${PROACTIVE_PANEL_IDS.talkativeness}"`), 'the panel has 话痨程度');
  assert.ok(html.includes(`id="${PROACTIVE_PANEL_IDS.verbosity}"`), 'and 话的长度');
  assert.ok(html.includes(`id="${PROACTIVE_PANEL_IDS.talkativenessNow}"`), 'with its value in effect');
  assert.ok(html.includes(`id="${PROACTIVE_PANEL_IDS.verbosityNow}"`), 'and the same for verbosity');
  assert.match(html, /话痨程度（人格 talkativeness）/, 'labelled by property name');
  assert.match(html, /话的长度（人格 verbosity）/);
  assert.match(html, /step="0\.05"/, 'the sliders step by 0.05');

  const script = proactivePanelScript('/api/field');
  assert.match(script, /personalityFields = \['proactivity', 'talkativeness', 'verbosity'\]/, 'the page sends all three personality values');
  assert.match(script, /patch\[name\] = Number\(raw\)/, 'each one as a number');
  assert.match(script, /String\(raw\)\.trim\(\) !== ''/, 'and never sends an empty box as 0');
});

test('a patch that changes proactivity writes self_profile and moves the threshold', () => {
  const root = tempDir('xixi-t63-proactivity-');
  const store = openXixiStore({ dataDir: root });
  try {
    const config = loadConfig();
    // The acceptance's scenario: an entry whose stored persona still says 0.55 (seeded before
    // the default moved), i.e. threshold 0.585 today.
    store.seedSelfProfile({ ...config.personality.base, proactivity: 0.55 });
    const before = effectiveProactivity(store.selfProfile());
    assert.equal(before, 0.55);
    assert.equal(proactiveThreshold(before), 0.585, 'the 旧库 state');
    const snapshot = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);

    const applied = applyAndPersistProactivePatch({
      store,
      settings: snapshot.settings,
      patch: { proactivity: 0.7 },
      personalityBefore: { proactivity: before },
    });
    assert.equal(applied.rejected.length, 0, 'proactivity is a known field now');
    assert.ok(applied.changes.some((row) => row.includes('主动性总强度')), `changes: ${JSON.stringify(applied.changes)}`);
    assert.deepEqual(applied.personality.proactivity, { before, after: 0.7 });
    assert.ok(applied.auditSequence !== null, 'the change left an audit row');

    // Written to the personality table (and its history), not just returned to the caller.
    assert.equal(store.selfProfile().proactivity, 0.7);
    const history = store.selfProfileHistory?.('proactivity') ?? [];
    assert.ok(
      history.some((row: { sourceType?: string }) => row.sourceType === 'console:personality'),
      'the override is attributed in self_profile_history',
    );

    // ...and the entry's threshold is the documented function of that value.
    const state = proactiveConsoleState({ store, settings: applied.settings, source: 'console', updatedAt: applied.auditAt, changes: applied.changes, now: new Date(), personality: store.selfProfile() });
    assert.equal(state.proactivity, 0.7);
    assert.equal(state.threshold, 0.54, '0.45 + 0.30 × (1 − 0.70)');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('unknown patch fields are reported in Chinese instead of being dropped', () => {
  const root = tempDir('xixi-t63-unknown-');
  const store = openXixiStore({ dataDir: root });
  try {
    const config = loadConfig();
    const snapshot = restoreProactiveSettings(store, config.proactive as unknown as Record<string, unknown>);
    const applied = applyAndPersistProactivePatch({
      store,
      settings: snapshot.settings,
      patch: { max_per_day: 3, proactivityy: 0.7, quietStart: '21:30' },
      personalityBefore: { proactivity: 0.55 },
    });
    assert.equal(applied.changes.length, 1, 'only the known field changed');
    assert.equal(applied.rejected.length, 2, `both unknown keys are reported: ${JSON.stringify(applied.rejected)}`);
    for (const row of applied.rejected) {
      assert.match(row, /不是这个接口认识的字段/, 'the rejection is explained in Chinese');
      assert.match(row, /已忽略/, 'and says what happened to it');
    }
    assert.ok(applied.rejected.some((row) => row.includes('max_per_day')), 'a snake_case typo is named');
    assert.ok(applied.rejected.some((row) => row.includes('proactivityy')), 'so is a misspelled proactivity');
    assert.equal(store.selfProfile().proactivity, undefined, 'a rejected proactivity writes nothing');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('the panel markup and script expose every knob, the gate table and the segment player', () => {
  const html = proactivePanelHtml();
  for (const id of [PROACTIVE_PANEL_IDS.enabled, PROACTIVE_PANEL_IDS.cooldown, PROACTIVE_PANEL_IDS.per6h, PROACTIVE_PANEL_IDS.perDay, PROACTIVE_PANEL_IDS.quietStart, PROACTIVE_PANEL_IDS.quietEnd, PROACTIVE_PANEL_IDS.save, PROACTIVE_PANEL_IDS.off, PROACTIVE_PANEL_IDS.drill, PROACTIVE_PANEL_IDS.gates, PROACTIVE_PANEL_IDS.log, PROACTIVE_PANEL_IDS.audit]) {
    assert.ok(html.includes(`id="${id}"`), `panel is missing #${id}`);
  }
  assert.match(html, /硬底线由程序判定/, 'the panel must say the knobs cannot widen the hard floor');
  assert.match(html, /由模型读空气决定说不说/, 'and that above the floor the model decides');
  assert.match(html, /不是禁止/, 'and that the graded signals are not vetoes');
  assert.match(html, /立即生效/, 'the panel must say changes take effect immediately');

  const script = proactivePanelScript('/api/field');
  assert.match(script, /"\/api\/field"/, 'the script is parameterised by API base');
  assert.match(script, /function pxPlaySegments/, 'the page plays segments one-by-one');
  assert.match(script, /setTimeout\(step, gapMs\)/, 'the pause between segments is real, not a comment');
  assert.match(script, /'\/proactive\/settings'/);
  assert.match(script, /'\/proactive\/drill'/);
  assert.match(script, /主动开口/, 'the drill result is labelled as a proactive message');

  // The panel evaluates the *engine's* reason codes: a code the engine can emit but the page
  // does not know how to explain would silently show an empty next-step.
  assert.match(proactivePanelScript('/api'), /reasonCode/);
});

test('the console serves the proactive card, its state, and obeys the switch over HTTP', { timeout: HTTP_TIMEOUT_MS * 3 }, async () => {
  const root = tempDir('xixi-t42-http-');
  const handle = await createFieldServer({
    port: 0,
    offline: true,
    ttsEnabled: false,
    voiceDir: join(root, 'voice'),
    dataDir: join(root, 'data'),
    presenceDataDir: join(root, 'presence'),
    reportDir: join(root, 'recon'),
    autoPrune: false,
    probeRunner: createFakeProbeRunner(),
    log: () => {},
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    const pageResponse = await fetch(handle.url);
    const page = await pageResponse.text();
    // Guard against exactly the t42 bug: a page-builder crash used to answer HTTP 200 with an
    // empty/truncated body, so marker assertions alone were not enough.
    assert.equal(pageResponse.status, 200, `the console page must build:\n${page.slice(0, 300)}`);
    assert.ok(page.length > 3000, `the console page looks truncated (${page.length} bytes)`);
    assert.ok(page.includes('现场测试控制台'), 'and is the real page, not an error JSON');
    assert.ok(page.includes(`id="${PROACTIVE_PANEL_IDS.card}"`), 'the console page shows the proactive card');
    assert.ok(page.includes('pxPlaySegments'), 'and the shared segment player');

    const state = (await (await fetch(`${handle.url}/api/field/proactive`)).json()) as Record<string, any>;
    assert.equal(state.ok, true);
    assert.equal(state.gateOrder.length, 14);
    assert.equal(state.triggerLabels.length, 6);
    assert.equal(state.source, 'config');
    assert.equal(state.enabled, true);

    // t42 acceptance item 3: the page must say which database it uses, that the four entry
    // points do not share one, and that TTS is still whole-reply (text is what is segmented).
    const fieldState = (await (await fetch(`${handle.url}/api/field/state`)).json()) as Record<string, any>;
    assert.equal(fieldState.database?.path, join(root, 'data'), 'the console reports the store it is really using');
    assert.ok(Array.isArray(fieldState.database?.entries) && fieldState.database.entries.length >= 4, 'all entry points are listed');
    assert.equal(fieldState.segmentPlayback?.textSegmented, true);
    assert.equal(fieldState.segmentPlayback?.ttsSegmented, false, 'the honest state: TTS is not segmented yet');
    assert.match(String(fieldState.segmentPlayback?.note ?? ''), /整条回复一次合成/);
    assert.ok(page.includes('本页用的是哪个数据库'), 'the console shows the database block prominently');
    assert.ok(page.includes('data/field-test'), 'and its own path');
    assert.ok(page.includes('不会'), 'and warns that another entry point\'s persona/history is not here');
    assert.ok(page.includes('整条回复一次合成'), 'and states the TTS granularity honestly');

    // The shipped default quiet window is 23:30–07:30 (config/xixi.example.yaml), so a drill that is
    // required to be deliverable fails every night between those hours. Pin an empty window first:
    // this assertion must not depend on the wall clock. (t1 found the suite red at 23:43 for exactly
    // this, with an empty `git diff HEAD` — a false alarm the whole team would have judged as a bug.)
    const pinned = await post('/api/field/proactive/settings', { quietStart: '00:00', quietEnd: '00:00' });
    assert.equal(pinned.ok, true, `pinning the quiet window failed: ${JSON.stringify(pinned)}`);

    const drill = await post('/api/field/proactive/drill', { trigger: 'presence_arrived' });
    assert.equal(drill.ok, true);
    assert.equal(drill.drill.reasonCode, 'PASSED');
    assert.ok(drill.drill.segments.length >= 2, 'the drill speaks in segments');
    assert.equal(drill.drill.gapMs, 450);
    assert.ok(drill.drill.eventSequence !== null, 'the decision is logged (auditable)');
    assert.equal(drill.state.lastDecision.reasonCode, 'PASSED');

    const saved = await post('/api/field/proactive/settings', { enabled: false, maxPerDay: 1, quietStart: '23:00' });
    assert.equal(saved.ok, true);
    assert.ok(saved.changes.some((row: string) => row.includes('主动开口')), `changes: ${JSON.stringify(saved.changes)}`);
    assert.equal(saved.state.settings.enabled, false, 'the change is applied immediately (state comes back with the new value)');
    assert.ok(saved.state.audit.length >= 1, 'and it is written to the audit trail');
    assert.equal(saved.state.source, 'console');

    // t63: the 主动性总强度 control. A fresh store starts at the config default (0.70 → 0.54);
    // moving it away and back must show up in `changes` and move the threshold each time.
    const lowered = await post('/api/field/proactive/settings', { proactivity: 0.55 });
    assert.equal(lowered.rejected.length, 0, 'proactivity is a known field');
    assert.ok(lowered.changes.some((row: string) => row.includes('主动性总强度')), `changes: ${JSON.stringify(lowered.changes)}`);
    assert.equal(lowered.state.proactivity, 0.55);
    assert.equal(lowered.state.threshold, 0.585, '0.45 + 0.30 × (1 − 0.55)');

    const raised = await post('/api/field/proactive/settings', { proactivity: 0.7 });
    assert.equal(raised.rejected.length, 0);
    assert.deepEqual(raised.personality.proactivity, { before: 0.55, after: 0.7 });
    assert.equal(raised.state.proactivity, 0.7);
    assert.equal(raised.state.threshold, 0.54, '调到 0.70 后 threshold 必须是 0.54');

    // t63: an unknown key must come back as a Chinese rejection, not as silence.
    const typo = await post('/api/field/proactive/settings', { max_per_day: 3 });
    assert.equal(typo.changes.length, 0, 'nothing understood, nothing changed');
    assert.equal(typo.rejected.length, 1, `an unknown field must be reported: ${JSON.stringify(typo.rejected)}`);
    assert.match(String(typo.rejected[0]), /不是这个接口认识的字段/);
    assert.match(String(typo.rejected[0]), /max_per_day/);

    const afterOff = await post('/api/field/proactive/drill', { trigger: 'presence_arrived' });
    assert.equal(afterOff.drill.reasonCode, 'DISABLED', '一键关闭后确实不再主动开口');
    assert.equal(afterOff.drill.speak, false);
    assert.equal(afterOff.drill.segments.length, 0);
    assert.ok(String(afterOff.drill.nextStep).includes('打开'), 'and the page says how to turn it back on');

    const quietState = (await (await fetch(`${handle.url}/api/field/proactive`)).json()) as Record<string, any>;
    assert.equal(quietState.settings.enabled, false, 'a reload keeps the saved value');
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('the trial page shows segments in order, labels the source, and carries the same knobs', { timeout: HTTP_TIMEOUT_MS * 4 }, async () => {
  const root = tempDir('xixi-t42-web-');
  // t96: one shared fixture waits for the *service* (an answered request), not for a log line, and
  // reaps the process — this is the test that used to go red now and then on a loaded machine.
  const page = await startTrialPage({ dataDir: root });
  const base = page.base;
  const post = async (path: string, body: unknown): Promise<Record<string, any>> =>
    (await (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })).json()) as Record<string, any>;
  try {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('addSegmented'), 'the page renders a reply segment by segment');
    assert.ok(html.includes('回应你'), 'and labels who is speaking');
    assert.ok(html.includes('主动开口'), 'proactive messages are labelled differently');
    assert.ok(html.includes(`id="${PROACTIVE_PANEL_IDS.card}"`), 'the trial page carries the same proactive card');
    assert.ok(html.includes('data/web-chat'), 'the trial page names its own database');
    assert.ok(html.includes('整条回复一次合成'), 'and discloses that TTS is not segmented yet');

    const webState = (await (await fetch(base + '/api/state')).json()) as Record<string, any>;
    assert.equal(webState.database?.path, root, 'the trial page reports the store it is really using');
    assert.ok(Array.isArray(webState.database?.entries) && webState.database.entries.length >= 4, 'all entry points are listed');
    assert.equal(webState.segmentPlayback?.ttsSegmented, false);

    // The switch and the strength first: cooldown 0 makes the *next* gate reachable below,
    // which is also how this test shows a knob change taking effect immediately. The quiet window is
    // pinned empty in the same request: the shipped default (23:30–07:30) would otherwise make the
    // drill below fail every night, i.e. the assertion would depend on the wall clock.
    const tuned = await post('/api/proactive/settings', { baseCooldownMinutes: 0, quietStart: '00:00', quietEnd: '00:00' });
    assert.equal(tuned.state.settings.baseCooldownMinutes, 0, 'the new cooldown is in effect without a restart');

    // With the engine on and the session idle, a drill is deliverable.
    const fresh = await post('/api/proactive/drill', { trigger: 'presence_arrived' });
    assert.equal(fresh.drill.reasonCode, 'PASSED');
    assert.ok(fresh.drill.segments.length >= 2, 'a proactive message is played in segments too');

    // A long turn comes back as the engine's own segment plan (ADR-0010), with the source label.
    const long = '这是一句很长的测试输入用来触发多段回复的切分逻辑因为单段最多六十个字符超过之后就会被引擎切成两段或者三段好让页面逐条显示';
    const turn = await post('/api/turn', { text: long, speak: false });
    assert.equal(turn.action, 'SPEAK');
    assert.equal(turn.source, 'reply');
    assert.equal(turn.sourceLabel, '回应你');
    assert.ok(Array.isArray(turn.segments) && turn.segments.length >= 2, `expected segments, got ${JSON.stringify(turn.segments)}`);
    assert.equal(turn.segments.join(''), `模拟回复：${long}`, 'the segments are the reply, in order and complete');
    assert.equal(turn.segmentGapMs, 450);

    // The session is open now, so a *different* candidate (new topic_ref, cooldown already 0)
    // is blocked by CONVERSATION_ACTIVE — that is the gate table doing its job.
    const inConversation = await post('/api/proactive/drill', { trigger: 'presence_arrived', topicRef: 'arrived-again' });
    assert.equal(inConversation.drill.reasonCode, 'CONVERSATION_ACTIVE');
    assert.equal(inConversation.drill.gates.filter((row: { status: string }) => row.status === 'blocked').length, 1);

    const off = await post('/api/proactive/settings', { enabled: false });
    assert.equal(off.state.settings.enabled, false);
    const blocked = await post('/api/proactive/drill', { trigger: 'presence_arrived' });
    assert.equal(blocked.drill.reasonCode, 'DISABLED');
    assert.equal(blocked.drill.speak, false);

    // t63 on the trial page too: the proactivity control must do the same thing here.
    const tweaked = await post('/api/proactive/settings', { proactivity: 0.55 });
    assert.ok(tweaked.changes.some((row: string) => row.includes('主动性总强度')), `changes: ${JSON.stringify(tweaked.changes)}`);
    assert.equal(tweaked.state.threshold, 0.585);
    const back = await post('/api/proactive/settings', { proactivity: 0.7 });
    assert.equal(back.state.threshold, 0.54);
    const unknown = await post('/api/proactive/settings', { quiet_hours: { start: '22:00' } });
    assert.equal(unknown.changes.length, 0);
    assert.equal(unknown.rejected.length, 1, `nested objects are not a shortcut: ${JSON.stringify(unknown.rejected)}`);
  } finally {
    await page.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('the terminal prints a reply segment by segment, with the real pause', { timeout: HTTP_TIMEOUT_MS }, async () => {
  const root = tempDir('xixi-t42-chat-');
  const long = '这是一句很长的测试输入用来触发多段回复的切分逻辑因为单段最多六十个字符超过之后就会被引擎切成两段或者三段好让终端逐条显示';
  const child = spawn(process.execPath, ['scripts/chat.ts', '--fake'], {
    cwd: REPO_ROOT,
    // Its own store: a test must not append to the user's chat history.
    env: { ...process.env, XIXI_CHAT_DATA_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(`${long}\n`);
  child.stdin.end();
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    out += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  try {
    assert.equal(code, 0, `chat --fake should exit 0:\n${out}`);
    assert.match(out, /西西【第 1\/\d+ 段】：/, 'the first segment is labelled');
    assert.match(out, /（停 \d+ms 再说下一段…）/, 'the pause is announced, not silent');
    assert.match(out, /西西【第 2\/\d+ 段】：/, 'the second segment really is printed separately');
    assert.match(out, /分\d+段\/间隔\d+ms/, 'the timing line reports the segmentation');
    const first = out.indexOf('【第 1/');
    const second = out.indexOf('【第 2/');
    assert.ok(first >= 0 && second > first, 'and they are printed in order');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});

test('the console feeds the card the same proactivity the engine will use', () => {
  const profile = { proactivity: 0.9 };
  assert.equal(effectiveProactivity(profile), 0.9, 'the persisted profile wins');
  const config = loadConfig();
  assert.ok(effectiveProactivity(config.personality.base) > 0);
  // The fallback is the engine's own constant, so this assertion cannot rot when the default
  // moves again (t58 raised it 0.55 → 0.70; a literal here would have needed editing a second
  // time). What *is* worth pinning is that the engine constant and the shipped config agree:
  // ADR-0009 calls the config the baseline, so a mismatch means the two halves disagree.
  assert.equal(effectiveProactivity({}), DEFAULT_PROACTIVITY, 'a silent profile falls back to the engine default');
  assert.equal(config.personality.base.proactivity, DEFAULT_PROACTIVITY, 'engine default and config/xixi.example.yaml must agree');
});
