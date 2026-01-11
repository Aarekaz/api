export type JsonRecord = Record<string, unknown>;

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };
