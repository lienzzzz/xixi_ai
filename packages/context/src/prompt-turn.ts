/**
 * 提示词里「上一轮说了什么」的最小形状。
 *
 * 定义在这里（而不是从 `@xixi/conversation` 导入）是为了让依赖只有一个方向：
 * `context` 只依赖 `domain`，`conversation` 依赖 `context`。反过来会让两个包互相导入，
 * 而 Node 的 ESM 在真实运行时确实会炸。
 *
 * 它与 `@xixi/conversation` 的 `PromptTurn` **结构兼容**（多出来的 `action` 字段可选），
 * 所以引擎手里的工作记忆可以原样传进来。
 */
export interface PromptTurnLike {
  readonly role: TurnRoleLike;
  readonly text: string;
  readonly action?: string;
}

export type TurnRoleLike = 'user' | 'assistant';
