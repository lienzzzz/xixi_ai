/**
 * Stable, machine-checkable contract failures.
 *
 * Codes are part of the contract: callers branch on `code`, never on the
 * message text. New codes may be added; existing codes never change meaning.
 */
export type ContractErrorCode =
  | 'INVALID_EVENT'
  | 'INVALID_PAYLOAD'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNSUPPORTED_SCHEMA_KEYWORD'
  | 'MALFORMED_SCHEMA';

export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly path: string;
  readonly problems: readonly string[];

  constructor(code: ContractErrorCode, message: string, options: { path?: string; problems?: readonly string[] } = {}) {
    const problems = options.problems ?? [];
    const detail = problems.length > 0 ? `: ${problems.join('; ')}` : '';
    super(`${message}${detail}`);
    this.name = 'ContractError';
    this.code = code;
    this.path = options.path ?? '';
    this.problems = problems;
  }
}
