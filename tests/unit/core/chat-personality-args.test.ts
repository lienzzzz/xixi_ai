import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FakeBrainAdapter } from '@xixi/brain-adapter';
import { ConversationEngine } from '@xixi/conversation';
import { fixedClock, openXixiStore, type XixiConfig } from '@xixi/domain';

import { parsePersonalityArgs } from '../../../scripts/chat.ts';

/**
 * `--personality` is the one command the README/captain point a user at to watch
 * "personality changes behaviour" (the 2.4× length gap). It used to do nothing at
 * all: the parser filtered for tokens *starting with* `--personality` (so the
 * separate value token was dropped) and split `--personality=a=b` on the first
 * `=`, yielding `a`. Both documented forms were silent no-ops — a promise the CLI
 * never kept, which is worse than a missing feature.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const CONFIG: XixiConfig = {
  identity: { name: '西西', language: 'zh-CN', timezone: 'Asia/Shanghai', place: null },
  models: {
    llm: { provider: 'fake', model: 'fake-1', thinking_realtime: false },
    asr: { provider: 'fake', model: 'fake-asr' },
    tts: { provider: 'fake', model: 'fake-tts' },
  },
  // Mirrors the shipped `personality.base` (config/xixi.example.yaml): the「话痨」factory tier,
  // both values inside prompt.ts's top band. Only the values below are overridden per test.
  personality: { base: { verbosity: 0.7, talkativeness: 0.75, silence_tolerance: 0.7 } },
  proactive: {},
  memory: {},
  privacy: {},
  features: {},
};

test('both documented forms parse to the same override', () => {
  const separate = parsePersonalityArgs(['--fake', '--personality', 'verbosity=0.1,talkativeness=0.2']);
  const inline = parsePersonalityArgs(['--fake', '--personality=verbosity=0.1,talkativeness=0.2']);

  assert.deepEqual(separate.problems, []);
  assert.deepEqual(inline.problems, []);
  assert.deepEqual(separate.values, { verbosity: 0.1, talkativeness: 0.2 });
  assert.deepEqual(inline.values, separate.values, 'the two forms must be equivalent');

  // The inline form must not be split on its first '=' (that produced `verbosity`
  // as a *name* and dropped the value entirely).
  assert.deepEqual(parsePersonalityArgs(['--personality=silence_tolerance=1']).values, { silence_tolerance: 1 });
});

test('one property, several flags and repeated keys behave predictably', () => {
  assert.deepEqual(parsePersonalityArgs(['--personality=verbosity=0.1']).values, { verbosity: 0.1 });
  assert.deepEqual(parsePersonalityArgs(['--personality', 'verbosity=0.1']).values, { verbosity: 0.1 });
  // Several flags merge, and the last value of a key wins (command-line order).
  assert.deepEqual(parsePersonalityArgs(['--personality', 'verbosity=0.1', '--personality', 'warmth=0.9']).values, {
    verbosity: 0.1,
    warmth: 0.9,
  });
  assert.deepEqual(parsePersonalityArgs(['--personality', 'verbosity=0.1,verbosity=0.9']).values, { verbosity: 0.9 });
  // Boundary values are legal.
  assert.deepEqual(parsePersonalityArgs(['--personality', 'verbosity=0,warmth=1']).values, { verbosity: 0, warmth: 1 });
  assert.deepEqual(parsePersonalityArgs(['--fake']).values, {});
  assert.deepEqual(parsePersonalityArgs([]).problems, []);
});

test('an unknown property is refused by name, with the list of usable ones', () => {
  const result = parsePersonalityArgs(['--personality', 'verbosityy=0.1']);
  assert.deepEqual(result.values, {});
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? '', /未知的人格属性「verbosityy」/);
  assert.match(result.problems[0] ?? '', /verbosity/);
  assert.match(result.problems[0] ?? '', /silence_tolerance/);
});

test('out-of-range, empty and non-numeric values are refused with their range', () => {
  const tooHigh = parsePersonalityArgs(['--personality', 'verbosity=9']);
  assert.match(tooHigh.problems[0] ?? '', /超出允许范围 \[0, 1\]/);
  assert.deepEqual(tooHigh.values, {});

  const tooLow = parsePersonalityArgs(['--personality', 'verbosity=-0.5']);
  assert.match(tooLow.problems[0] ?? '', /超出允许范围/);

  const empty = parsePersonalityArgs(['--personality=verbosity=']);
  assert.match(empty.problems[0] ?? '', /值为空/);

  const notANumber = parsePersonalityArgs(['--personality', 'verbosity=许多']);
  assert.match(notANumber.problems[0] ?? '', /不是数字/);

  const missingEquals = parsePersonalityArgs(['--personality', 'verbosity']);
  assert.match(missingEquals.problems[0] ?? '', /缺少「=」/);

  const dangling = parsePersonalityArgs(['--personality']);
  assert.match(dangling.problems[0] ?? '', /缺少设置/);

  const emptyInline = parsePersonalityArgs(['--personality=']);
  assert.match(emptyInline.problems[0] ?? '', /空项/);

  const trailingComma = parsePersonalityArgs(['--personality', 'verbosity=0.1,']);
  assert.match(trailingComma.problems[0] ?? '', /空项/);
});

test('a partly valid specification is refused as a whole, never half-applied', () => {
  const result = parsePersonalityArgs(['--personality', 'verbosity=0.1,nosuch=0.5']);
  assert.deepEqual(result.values, {}, 'one bad key must not leave the other applied silently');
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? '', /nosuch/);
});

test('the parsed override reaches the prompt the model actually sees', async () => {
  const store = openXixiStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'xixi-chat-personality-')), 'x.sqlite'),
    clock: fixedClock(new Date('2026-09-30T10:00:00+08:00'), 1_000),
  });
  try {
    // Same order as `main()`: seed the baseline, then apply the override, then
    // build the engine (so the window and the prompt both see the new values).
    store.seedSelfProfile(CONFIG.personality.base);
    const { values, problems } = parsePersonalityArgs(['--personality', 'verbosity=0.1,silence_tolerance=1']);
    assert.deepEqual(problems, []);
    store.overrideSelfProfile(values, 'cli:override');

    const engine = new ConversationEngine({
      adapter: new FakeBrainAdapter(),
      store,
      config: CONFIG,
      clock: fixedClock(new Date('2026-09-30T10:00:00+08:00'), 1_000),
      offsetMinutes: 480,
      fsm: { lingerMs: 30_000 },
    });
    const session = store.createSession();
    const prompt = engine.buildPrompt({ sessionId: session.sessionId, text: '预览' });

    // The low-verbosity directive only appears for the overridden value…
    assert.match(prompt.system, /回答尽量短：通常 1 句，最多 2 句。/);
    assert.doesNotMatch(prompt.system, /可以多说一点（3~5 句）/);
    // …and the raw parameters carry the override, not the seeded 0.7.
    assert.match(prompt.system, /verbosity=0\.1/);
    assert.doesNotMatch(prompt.system, /verbosity=0\.7/);
    // silence_tolerance drives the follow-up window too, so the engine must show it.
    assert.equal(engine.silenceTolerance, 1);
    assert.equal(engine.lingerMs, 45_000);
  } finally {
    store.close();
  }
});

test('importing the CLI module has no side effects (no banner, no store, no REPL)', () => {
  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'scripts', 'chat.ts')).href;
  const probe = `import(${JSON.stringify(moduleUrl)}).then((m) => { console.log('IMPORT_OK', typeof m.parsePersonalityArgs, typeof m.main); });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(result.status, 0, `importing chat.ts must not run the CLI: ${result.stderr}`);
  assert.match(result.stdout, /IMPORT_OK function function/);
  assert.doesNotMatch(result.stdout, /西西（/, 'importing must not print the startup banner');
  assert.doesNotMatch(result.stdout, /人格已按命令行覆盖/, 'importing must not apply an override');
});

test('the CLI refuses an invalid override with a non-zero exit code instead of ignoring it', () => {
  const result = spawnSync(process.execPath, ['scripts/chat.ts', '--fake', '--personality', 'verbosity=9'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });
  assert.equal(result.status, 2, 'an unusable override must fail loudly');
  assert.match(result.stderr, /参数错误/);
  assert.match(result.stderr, /超出允许范围 \[0, 1\]/);
  assert.doesNotMatch(result.stdout, /西西（/, 'it must not start the session with a broken override');
});
