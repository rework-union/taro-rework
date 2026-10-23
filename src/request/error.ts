export type ErrorKind = 'http' | 'network' | 'timeout' | 'abort' | 'unknown';

export class RequestError<T = unknown> extends Error {
  readonly name = 'RequestError';

  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly statusCode = 0,
    readonly data: T | undefined = undefined,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function normalizeError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const detail = error as { errMsg?: string; message?: string } | undefined;
  const message = detail?.errMsg || detail?.message || '请求失败';
  const kind = /abort|cancel/i.test(message) ? 'abort' : /timeout|timed out/i.test(message) ? 'timeout' : 'network';
  return new RequestError(message, kind, 0, undefined, error);
}

export function httpError(response: { statusCode: number; data: unknown }): RequestError {
  const body = response.data as { detail?: unknown; message?: unknown } | null;
  const detail = body && typeof body === 'object' ? body.detail ?? body.message : undefined;
  return new RequestError(
    typeof detail === 'string' ? detail : `请求失败（${response.statusCode}）`,
    'http', response.statusCode, response.data,
  );
}
