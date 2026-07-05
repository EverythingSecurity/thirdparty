/**
 * API client — thin fetch wrapper that:
 *   1. Prepends the API base URL (via Vite dev proxy in dev, absolute in prod).
 *   2. Attaches the current Authorization: Bearer token from the auth store.
 *   3. Parses the standard error envelope from blueprint §4 into a typed
 *      `ApiError` so consumers can switch on `code` / statusCode.
 *
 * Do NOT throw plain Error strings — the envelope carries structured info
 * (fields, code) that UI needs. Always throw `ApiError`.
 */
export interface ApiErrorFields {
  [field: string]: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    fields?: ApiErrorFields;
  };
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields: ApiErrorFields | undefined;

  constructor(statusCode: number, code: string, message: string, fields?: ApiErrorFields) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }
}

// The token provider is injected at boot from `AuthProvider` — this keeps the
// module import-cycle-free (api.ts doesn't need to know about React).
let tokenProvider: () => string | null = () => null;

export function setTokenProvider(fn: () => string | null): void {
  tokenProvider = fn;
}

interface RequestOpts extends Omit<RequestInit, 'body' | 'headers'> {
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Prefix requests with `/api` — Vite proxies to the API server in dev.
 * Production build uses the same-origin backend (see Sprint 7 deploy).
 */
export async function apiFetch<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const token = tokenProvider();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...opts.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) {
      body = opts.body;
      // Don't set Content-Type on FormData — the browser sets the boundary.
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(`/api${path}`, { ...opts, headers, body });
  if (res.status === 204) return undefined as T;

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    // Non-JSON — likely CSV export. Return the raw response for callers who
    // know they asked for a stream.
    if (!res.ok) throw new ApiError(res.status, 'network_error', res.statusText);
    return (await res.text()) as unknown as T;
  }

  const payload = (await res.json()) as ApiErrorEnvelope | T;

  if (!res.ok) {
    const env = payload as ApiErrorEnvelope;
    throw new ApiError(
      res.status,
      env.error?.code ?? 'unknown',
      env.error?.message ?? res.statusText,
      env.error?.fields,
    );
  }
  return payload as T;
}

/** Convenience helpers. */
export const api = {
  get<T>(path: string): Promise<T> {
    return apiFetch<T>(path, { method: 'GET' });
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return apiFetch<T>(path, { method: 'POST', body });
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return apiFetch<T>(path, { method: 'PATCH', body });
  },
  delete<T = void>(path: string): Promise<T> {
    return apiFetch<T>(path, { method: 'DELETE' });
  },
  upload<T>(path: string, formData: FormData): Promise<T> {
    return apiFetch<T>(path, { method: 'POST', body: formData });
  },
};
