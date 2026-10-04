/**
 * V0.3 t22：**分小节提取**（①）与**疑问句守卫**（③）的回归用例。
 *
 * 背景（t15 独立复验，pack Phase 1 旗舰场景按原句不成立）：
 *   * `我不喝绿茶，平时喜欢茉莉花茶。` 是极自然的一句话，而提取按**整句**匹配，于是
 *     「我」后面接的是「不喝绿茶」，`我…喜欢` 接不上、`我平时喜欢` 也因为前面没有「我」接不上
 *     —— 一句话**一条记忆都没写**（真模型与离线探针两次实测）；
 *   * 守卫 `statement.includes('？')` 对当时那条正则**恒为假**（字符类已把问号排除在 `match[0]` 之外），
 *     于是 `你还记得我喜欢喝什么茶吗？` 被写成 `preference: 我喜欢喝什么茶吗`（active、0.9）。
 *
 * 修法（这一层）：按标点切小节；第一人称在**同一句内**向后继承（跨句不继承）；
 * 疑问句在写之前就被拦下，而且判的是**原始那句话**。
 *
 * Run: `npm test`（tests/unit 在默认门禁里）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TurnMemoryExtractor, type PostTurnJob } from '@xixi/conversation';
import { MemoryStore, openXixiStore, SelfModel, type XixiStore } from '@xixi/domain';

import { firstPersonCandidate, looksLikeQuestion, splitUserClauses } from '../../../packages/conversation/src/extractor.ts';

const AT = new Date(2026, 9, 3, 20, 0, 0);

function tempStore(): XixiStore {
  const dir = mkdtempSync(join(tmpdir(), 'xixi-semantic-clause-'));
  const store = openXixiStore({ dbPath: join(dir, 'x.sqlite'), clock: () => AT });
  store.seedSelfProfile({ proactivity: 0.85, talkativeness: 0.75, verbosity: 0.7, follow_up_probability: 0.5 });
  return store;
}

interface Harness {
  readonly store: XixiStore;
  readonly memory: MemoryStore;
  readonly extract: (text: string, sourceEventId?: string) => readonly string[];
}

function harness(): Harness {
  const store = tempStore();
  const memory = new MemoryStore(store);
  const extractor = new TurnMemoryExtractor({ store, selfModel: new SelfModel(store), memory, scheduler: () => {} });
  const sessionId = store.createSession().sessionId;
  let sequence = 0;
  return {
    store,
    memory,
    extract: (text, sourceEventId) => {
      sequence += 1;
      const job: PostTurnJob = {
        sessionId,
        userText: text,
        replyText: null,
        at: AT,
        userEventId: sourceEventId ?? `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        inferredCode: null,
      };
      return extractor.runJob(job).semantic.map((row) => `${row.property}:${row.statement}`);
    },
  };
}

test('分小节：旗舰句「我不喝绿茶，平时喜欢茉莉花茶。」写出那条偏好（第一人称继承）', () => {
  const h = harness();
  try {
    const written = h.extract('我不喝绿茶，平时喜欢茉莉花茶。');
    assert.deepEqual(written, ['routine:我平时喜欢茉莉花茶'], `一句话要真的写出记忆：${JSON.stringify(written)}`);
    assert.deepEqual(
      h.memory.activeSemantic().map((row) => row.statement),
      ['我平时喜欢茉莉花茶'],
    );
  } finally {
    h.store.close();
  }
});

test('第一人称只在本句内继承：跨句不继承，纯第三方的句子一条都不写', () => {
  const h = harness();
  try {
    // 同一句里前面出现过「我」→ 后面的小节补主语。
    assert.equal(firstPersonCandidate(splitUserClauses('我不喝绿茶，平时喜欢茉莉花茶。')[1]!)?.startsWith('我'), true);
    // 换一句之后就不继承了：`他喜欢喝绿茶` 不该被写成「我」的事（这是这条继承规则的安全边界）。
    const written = h.extract('我很喜欢喝茉莉花茶。他喜欢喝绿茶。');
    assert.deepEqual(written, ['preference:我很喜欢喝茉莉花茶'], `第三方那一句不许写成我的事：${JSON.stringify(written)}`);
    // 纯第三方整句：一条都不写。
    assert.deepEqual(h.extract('他喜欢喝绿茶。'), []);
    assert.deepEqual(h.extract('老弟最近爱喝普洱。'), []);
  } finally {
    h.store.close();
  }
});

test('标点后的第二个小节也算：「也/还」开头的接续小节照样能补出主语', () => {
  const h = harness();
  try {
    const written = h.extract('我喜欢喝茶，也喜欢下棋。');
    assert.deepEqual(
      [...written].sort(),
      ['preference:我喜欢喝茶', 'preference:我喜欢下棋'].sort(),
      `接续小节要跟上（开头的接续词摘掉再补主语）：${JSON.stringify(written)}`,
    );
  } finally {
    h.store.close();
  }
});

/**
 * 疑问句守卫：判的是**原始那句话**（旧写法判的是 `match[0]`，而那个字符类里没有问号，
 * 条件恒为假 —— 这就是 t15 抓到的缺陷）。四种字面形态都要被拦住，而且**不能**把陈述句误伤。
 */
test('疑问句不写进记忆：问号 / 吗-呢-吧 收尾 / 明问记忆的句式（并且陈述句照写）', () => {
  const h = harness();
  try {
    for (const question of [
      '你还记得我喜欢喝什么茶吗？',
      '你还记得我喜欢喝什么茶吗',
      '我喜欢喝什么茶？',
      '我平时喜欢喝什么茶',
      '我说过我喜欢喝红茶吗',
      '我是不是不喜欢喝绿茶呢',
    ]) {
      assert.equal(looksLikeQuestion(question), true, `这句该被判成疑问：${question}`);
      const written = h.extract(question);
      assert.deepEqual(written, [], `疑问句不许写成事实：${question} → ${JSON.stringify(written)}`);
    }
    assert.deepEqual(
      h.memory.activeSemantic().map((row) => row.statement),
      [],
      '问了一圈之后库里一条偏好都不该有',
    );

    // 反向：陈述句仍然照写（守卫不能把正常句子一起拦掉）。
    assert.deepEqual(h.extract('我很喜欢喝茉莉花茶。'), ['preference:我很喜欢喝茉莉花茶']);
    assert.deepEqual(h.extract('我住在城东。'), ['place:我住在城东']);
    assert.deepEqual(h.extract('我每天六点起床。'), ['routine:我每天六点起床']);
  } finally {
    h.store.close();
  }
});

/**
 * 「无标记的疑问残句按陈述读」—— 这条**已知边界**钉在这里（V0.3 t24 / T23-D2）。
 *
 * 守卫是**字面**的：只有问号、`吗`-`呢`-`吧` 收尾、疑问词（什么/怎么/为什么/哪儿/哪里/几点/多少/什么时候）
 * 或明问记忆的句式才算疑问。所以**没有这些标记的残句会被当成陈述落库** ——
 * `我喜欢的茶` → `preference:我喜欢的茶`。这是刻意的取舍：判据只能字面，
 * 没有标记就不猜，宁可多记一条陈述，也不靠猜把正常的陈述误伤。
 *
 * 这条用例同时纠正一处注释口径（T23-D1）：**含疑问词的残句会被拦**（`我喜欢喝什么茶` 里有 `什么`），
 * 真正不拦的是**完全没有标记**的那一类（`我喜欢的茶`、`我爱喝的那种茶`）。
 * 两句的落库结果都由 `h.extract` 实跑给出。
 */
test('无标记的疑问残句按陈述读（已知边界，钉住它；含疑问词的残句仍会被拦）', () => {
  const h = harness();
  try {
    // 含疑问词 → 拦。它不是「无标记」的例子（旧注释举反了）。
    assert.equal(looksLikeQuestion('我喜欢喝什么茶'), true, '含「什么」就是疑问形态');
    assert.deepEqual(h.extract('我喜欢喝什么茶'), [], '含疑问词的残句会被拦下');

    // 真·无标记 → 按陈述读，真的落库（改了这个行为，下面两行就会红）。
    assert.equal(looksLikeQuestion('我喜欢的茶'), false, '没有任何疑问标记');
    assert.deepEqual(h.extract('我喜欢的茶'), ['preference:我喜欢的茶'], '无标记残句按陈述读：刻意的边界，不是漏网');
    assert.deepEqual(h.extract('我爱喝的那种茶'), ['preference:我爱喝的那种茶']);

    // 正常陈述当然也照写（同一条边界的两侧都在这里）。
    assert.equal(looksLikeQuestion('我住在城东'), false);
    assert.deepEqual(h.extract('我住在城东'), ['place:我住在城东']);
  } finally {
    h.store.close();
  }
});

test('分小节不影响既有的四条规则与判重：同一句话重复说不写第二遍', () => {
  const h = harness();
  try {
    assert.deepEqual(h.extract('我很喜欢喝茉莉花茶。'), ['preference:我很喜欢喝茉莉花茶']);
    assert.deepEqual(h.extract('我很喜欢喝茉莉花茶。'), [], '同一句话再说一遍不写第二条');
    // 已经存在、但状态不是 active 的那条也不重写（判重看全量视图）。
    const row = h.memory.activeSemantic()[0];
    assert.ok(row !== undefined);
    h.memory.revokeSemantic({ memoryId: row.memoryId, at: AT, reason: '用例：模拟被否定过' });
    assert.deepEqual(h.extract('我很喜欢喝茉莉花茶。'), [], '被否定过的那句不许因为「不再 active」而被重写');
  } finally {
    h.store.close();
  }
});

test('分小节的其它形状：逗号、分号、顿号、换行都算小节边界；疑问小节能与陈述小节共存', () => {
  const h = harness();
  try {
    // 疑问小节被跳过，陈述小节照写（同一条消息里两件事）。
    assert.deepEqual(h.extract('我喜欢喝什么茶，我平时喜欢茉莉花茶。'), ['routine:我平时喜欢茉莉花茶']);
    // 换行与分号也是边界（每一条用**不同**的内容：同一句话重复说不写第二条，那是另一条用例管的事）。
    assert.deepEqual([...h.extract('我住在城东；我很喜欢喝茉莉花茶。')].sort(), ['place:我住在城东', 'preference:我很喜欢喝茉莉花茶'].sort());
    assert.deepEqual([...h.extract('我住在城西\n我很喜欢听戏。')].sort(), ['place:我住在城西', 'preference:我很喜欢听戏'].sort());
  } finally {
    h.store.close();
  }
});
