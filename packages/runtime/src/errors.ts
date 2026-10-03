/**
 * The runtime's own error type (V0.3 P0-A, Step C).
 *
 * Why it exists: `buildSpeechAudio` / `runVad` are runtime code now, so the error they throw on
 * failure cannot come from the console script (`scripts/field-test.ts`'s `ConsoleError`). The shape
 * is deliberately identical — `code` / `hint` / `status`, `status` defaulting to 400 — because the
 * HTTP entries print those three fields verbatim and the tests assert on the Chinese message.
 *
 * The console's `ConsoleError` **extends** this class (`scripts/field-test.ts`), so a runtime
 * failure caught by an entry is still an `Error` with the same fields, and `instanceof ConsoleError`
 * keeps working for everything the console itself throws.
 */
export class RuntimeError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly status: number;

  constructor(code: string, message: string, hint = '', status = 400) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

/**
 * Who asked for an image upload — the two values the audit record can carry.
 *
 * These two shapes moved here with Step B because `createModelComposer`'s `vision` / `onUpload`
 * seams are part of its public signature: the console implements them, so the types have to be
 * shared without the composer importing the console. The console's audit record
 * (`LookOnceRecord`, `recordLookOnce`) stays in the console — it writes to the store, not to the
 * runtime.
 */
export type LookOnceTrigger = 'manual' | 'auto';

export interface LookOnceUploadInfo {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}
