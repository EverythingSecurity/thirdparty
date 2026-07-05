import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiFetch, ApiError, setTokenProvider } from './api';

const g = globalThis as unknown as { fetch: typeof fetch };

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const isJson = typeof body === 'object' && body !== null && !(body instanceof ArrayBuffer);
  g.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? headers['content-type'] ?? (isJson ? 'application/json' : 'text/plain') : null),
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(String(body)),
  } as unknown as Response);
}

beforeEach(() => {
  setTokenProvider(() => null);
});

describe('apiFetch', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch(200, { ok: true });
    const r = await apiFetch<{ ok: boolean }>('/health');
    expect(r).toEqual({ ok: true });
  });

  it('attaches Bearer token when provider returns one', async () => {
    setTokenProvider(() => 'the-token');
    mockFetch(200, {});
    await apiFetch('/me');
    expect(g.fetch).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer the-token' }),
      }),
    );
  });

  it('does not attach Authorization when no token is set', async () => {
    setTokenProvider(() => null);
    mockFetch(200, {});
    await apiFetch('/health');
    const call = (g.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((call![1] as { headers: Record<string, string> }).headers.Authorization).toBeUndefined();
  });

  it('throws ApiError with parsed envelope on 4xx', async () => {
    mockFetch(400, {
      error: {
        code: 'validation_error',
        message: 'Invalid request',
        fields: { justification: 'required' },
      },
    });
    await expect(apiFetch('/vendor/responses/x')).rejects.toMatchObject({
      statusCode: 400,
      code: 'validation_error',
      message: 'Invalid request',
      fields: { justification: 'required' },
    });
  });

  it('throws ApiError with generic code on non-JSON error', async () => {
    mockFetch(500, 'server exploded', { 'content-type': 'text/plain' });
    try {
      await apiFetch('/anything');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).statusCode).toBe(500);
    }
  });

  it('returns undefined for 204 No Content', async () => {
    g.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      headers: { get: () => null },
    } as unknown as Response);
    const r = await apiFetch<void>('/vendor/evidence/x', { method: 'DELETE' });
    expect(r).toBeUndefined();
  });

  it('JSON-encodes plain-object bodies and sets Content-Type', async () => {
    mockFetch(200, {});
    await apiFetch('/x', { method: 'POST', body: { a: 1 } });
    const call = (g.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((call![1] as { headers: Record<string, string> }).headers['Content-Type']).toBe(
      'application/json',
    );
    expect((call![1] as { body: string }).body).toBe('{"a":1}');
  });

  it('does not set Content-Type for FormData bodies (browser sets boundary)', async () => {
    mockFetch(200, {});
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'x.pdf');
    await apiFetch('/vendor/evidence/q', { method: 'POST', body: fd });
    const call = (g.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(
      (call![1] as { headers: Record<string, string> }).headers['Content-Type'],
    ).toBeUndefined();
  });
});
