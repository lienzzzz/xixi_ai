/** Stable adapter failures; callers branch on `code`. */
export type BrainErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'TRANSPORT_FAILED'
  | 'PROVIDER_FAILED'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'SESSION_MISMATCH';

export class BrainError extends Error {
  readonly code: BrainErrorCode;
  /** Milestone that will implement this capability, when the failure is a gap rather than a fault. */
  readonly milestone: string | null;
  readonly detail: string;

  constructor(code: BrainErrorCode, message: string, options: { milestone?: string; detail?: string } = {}) {
    const detail = options.detail ?? '';
    super(detail ? `${message} (${detail})` : message);
    this.name = 'BrainError';
    this.code = code;
    this.milestone = options.milestone ?? null;
    this.detail = detail;
  }
}
