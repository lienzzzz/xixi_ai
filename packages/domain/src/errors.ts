/** Stable domain failures. Like contracts, callers branch on `code`. */
export type DomainErrorCode =
  | 'UNKNOWN_SESSION'
  | 'SESSION_ALREADY_ENDED'
  | 'DUPLICATE_EVENT'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_FAILED'
  | 'UNKNOWN_PERSONALITY_PROPERTY'
  | 'PROPERTY_OUT_OF_RANGE'
  | 'INVALID_WORLD_STATE'
  | 'INVALID_CONFIG';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly detail: string;

  constructor(code: DomainErrorCode, message: string, detail = '') {
    super(detail ? `${message} (${detail})` : message);
    this.name = 'DomainError';
    this.code = code;
    this.detail = detail;
  }
}
