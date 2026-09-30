/**
 * Stable adapter failures; callers branch on `code`.
 *
 * The codes mirror the failure classes §21 降级 needs to tell apart: a missing
 * credential must not look like a rate limit, and a rate limit must not look
 * like a provider fault, because each gets a different fallback.
 */
export type BrainErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'TRANSPORT_FAILED'
  | 'PROVIDER_FAILED'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'BAD_REQUEST';

/** Provider-side error codes this adapter understands when re-labelling a failure. */
export type BrainErrorCauseCode =
  | 'MISSING_KEY'
  | 'AUTH'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'BAD_REQUEST'
  | 'PROVIDER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class BrainError extends Error {
  readonly code: BrainErrorCode;
  /** Milestone that will implement this capability, when the failure is a gap rather than a fault. */
  readonly milestone: string | null;
  readonly detail: string;
  /**
   * The provider-layer code this failure was translated from (`ModelError.code`,
   * or the harness's own error code on the DSH path), or null for failures
   * native to this layer.
   *
   * Keeping it means the classification survives a lossy mapping: §21 降级 can
   * branch on `code` without losing the original reason.
   */
  readonly originalCode: BrainErrorCauseCode | null;

  constructor(
    code: BrainErrorCode,
    message: string,
    options: { milestone?: string; detail?: string; originalCode?: BrainErrorCauseCode | null } = {},
  ) {
    const detail = options.detail ?? '';
    super(detail ? `${message} (${detail})` : message);
    this.name = 'BrainError';
    this.code = code;
    this.milestone = options.milestone ?? null;
    this.detail = detail;
    this.originalCode = options.originalCode ?? null;
  }
}

/**
 * The one place a provider/manifest failure code becomes a `BrainError` code.
 *
 * Both real paths (direct MiMo and DSH) call this, so the classes §21.1 needs —
 * credential, rate limit, quota, bad request, timeout, provider fault — cannot
 * drift apart between them. A code this table does not know still becomes
 * `PROVIDER_FAILED`, and the caller keeps the original code in `detail` (and in
 * `originalCode` whenever it fits the closed set above).
 */
export function brainErrorCodeFor(providerCode: string): { code: BrainErrorCode; isKnown: boolean } {
  switch (providerCode) {
    case 'AUTH':
      return { code: 'AUTH', isKnown: true };
    case 'RATE_LIMIT':
      return { code: 'RATE_LIMIT', isKnown: true };
    case 'QUOTA':
      return { code: 'QUOTA', isKnown: true };
    case 'BAD_REQUEST':
      return { code: 'BAD_REQUEST', isKnown: true };
    case 'TIMEOUT':
      return { code: 'TIMEOUT', isKnown: true };
    case 'INVALID_RESPONSE':
      return { code: 'INVALID_RESPONSE', isKnown: true };
    // Configuration and network faults are transport problems here, not
    // model-provider faults.
    case 'MISSING_KEY':
    case 'MISSING_CREDENTIAL':
    case 'NETWORK':
      return { code: 'TRANSPORT_FAILED', isKnown: true };
    case 'PROVIDER':
      return { code: 'PROVIDER_FAILED', isKnown: true };
    default:
      return { code: 'PROVIDER_FAILED', isKnown: false };
  }
}

/** Narrow a provider code to the closed set this package records, when possible. */
export function toBrainErrorCauseCode(providerCode: string): BrainErrorCauseCode | null {
  switch (providerCode) {
    case 'MISSING_KEY':
    case 'AUTH':
    case 'QUOTA':
    case 'RATE_LIMIT':
    case 'BAD_REQUEST':
    case 'PROVIDER':
    case 'NETWORK':
    case 'TIMEOUT':
    case 'INVALID_RESPONSE':
      return providerCode;
    default:
      return null;
  }
}
