/**
 * 入口共用的「一轮之后的记忆提取」装配（V0.3 P1-b / pack §5 §8）。
 *
 * 为什么要有这个文件：`afterTurn` 在过去只有**两个**入口接了线（现场控制台与试用页），
 * 命令行 `chat` 与 `voice-turn` 从来没接过 —— 于是「用文字聊过的事她记得，用语音说的不记得」
 * 这种不一致会一直存在（审计与 handoff 都记过这一条）。接线本身只有三行，但**三行抄三遍**
 * 就会出现第三种写法；所以装配只在这里做一次，三个入口各自调它。
 *
 * 它只做三件事：
 *   1. 建 `TurnMemoryExtractor`（默认已经带上 pack §5 的纠错闭环）；
 *   2. 给出 `afterTurn`（**只入队、不 await**，所以回复速度与「她要不要写记忆」无关）；
 *   3. 给出 `drain`：关库之前把排队与在飞的活跑完（Tier 2 是 async 的，`flush()` 会等它）。
 */

import { type StructuredMemoryExtractor } from '@xixi/context';
import { TurnMemoryExtractor, type PostTurnJob } from '@xixi/conversation';
import { MemoryStore, SelfModel, parseSelfModelSettings, type XixiConfig, type XixiStore } from '@xixi/domain';

export interface TurnExtractionOptions {
  readonly store: XixiStore;
  readonly config: XixiConfig;
  /** 出错时的一行日志（绝不影响已经说完的那句话）。 */
  readonly onError?: ((error: unknown) => void) | undefined;
  /**
   * pack §8 的 Tier 2（结构化的模型抽取）。省略 = 只有 Tier 1 的确定性提取。
   *
   * 传的是「怎么问模型」，不是「写不写记忆」：写入政策（值得记的门槛、类别白名单、schema 校验、
   * 置信阈值、永远不碰 SelfModel）都在 `@xixi/context` 的 `tier2-extraction.ts` 里，
   * 入口改不了它。
   */
  readonly structuredExtractor?: StructuredMemoryExtractor | undefined;
}

export interface TurnExtraction {
  readonly extractor: TurnMemoryExtractor;
  /** 交给 `ConversationEngine` 的 `afterTurn`。 */
  readonly afterTurn: (job: PostTurnJob) => void;
  /** 关库之前调它（同步 + 在飞的 Tier 2 都会跑完）。 */
  readonly drain: () => Promise<void>;
}

export function createTurnExtraction(options: TurnExtractionOptions): TurnExtraction {
  const memory = new MemoryStore(options.store);
  const onError =
    options.onError ??
    ((error: unknown) => {
      process.stderr.write(`[memory] 后台提取出错（不影响这一轮）：${error instanceof Error ? error.message : String(error)}\n`);
    });
  const extractor = new TurnMemoryExtractor({
    store: options.store,
    selfModel: new SelfModel(options.store, parseSelfModelSettings(options.config.selfModel)),
    memory,
    onError,
    ...(options.structuredExtractor === undefined ? {} : { structuredExtractor: options.structuredExtractor }),
  });
  return {
    extractor,
    afterTurn: (job) => extractor.enqueue(job),
    drain: async () => {
      await extractor.flush();
    },
  };
}
