/**
 * Small WAV helpers (PCM16 only, which is what every fixture and every MiMo
 * response uses). Shared by the fixture generator, the TTS output writer and the
 * voice loop's segment slicer.
 *
 * V0.3 P0-A Step C moved the implementation into `packages/runtime` (`src/wav.ts`) so the voice
 * runtime could use it without importing from the scripts directory. This file re-exports it, so
 * every existing import path (`./lib/wav.ts` from any script, `scripts/lib/wav.ts` from a test)
 * keeps working and there is exactly **one** implementation, not two copies that can drift.
 */
export { concatWav, readWav, readWavInfo, sliceWav, type WavInfo } from '@xixi/runtime';
