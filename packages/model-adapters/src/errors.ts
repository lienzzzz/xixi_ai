/** Stable model-client failures; callers branch on `code`. */
export type ModelErrorCode =
  | 'MISSING_KEY'
  | 'AUTH'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'BAD_REQUEST'
  | 'PROVIDER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly status: number | null;
  readonly detail: string;

  constructor(code: ModelErrorCode, message: string, options: { status?: number | null; detail?: string } = {}) {
    const detail = options.detail ?? '';
    super(detail.length > 0 ? `${message} (${detail})` : message);
    this.name = 'ModelError';
    this.code = code;
    this.status = options.status ?? null;
    this.detail = detail;
  }
}

/** Map an HTTP status onto a failure the caller can act on (§21.1 故障降级). */
export function classifyStatus(status: number): ModelErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 402) return 'QUOTA';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 404 || status === 422) return 'BAD_REQUEST';
  return status >= 500 ? 'PROVIDER' : 'INVALID_RESPONSE';
}
