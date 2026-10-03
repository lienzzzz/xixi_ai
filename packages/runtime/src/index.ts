/**
 * `@xixi/runtime` — Xixi's production runtime, assembled out of `scripts/field-test.ts`.
 *
 * V0.3 P0-A (pack `04_RUNTIME_CONSOLIDATION.md` §1) moves the code that every live entry
 * shares here, one step at a time. `scripts/field-test.ts` keeps a compatibility re-export
 * for each symbol until its last caller has moved, so nothing breaks in between.
 *
 * Step A: `buildToolChain` + `CONVERSATION_SCOPE` (see `./tool-runtime.ts`).
 * Steps B and C (proactive runtime, voice runtime) follow in the same shape.
 */
export { buildToolChain, CONVERSATION_SCOPE, type ToolChainOptions } from './tool-runtime.ts';
