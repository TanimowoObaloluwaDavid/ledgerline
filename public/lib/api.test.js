import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, request } from './api.js';

/**
 * The UI has exactly one way of talking to the server, so this is where a
 * regression would show up as a blank screen rather than a stack trace. The
 * tests pin the two things that matter: the request shape, and what happens
 * when the server says no.
 */
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('sends a JSON body and returns the parsed payload', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entry: { sequence: 7 } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await request('/v1/entries', { method: 'POST', body: { date: '2025-01-05' } });

    expect(result).toEqual({ entry: { sequence: 7 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/v1/entries');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ date: '2025-01-05' });
  });

  it('passes the idempotency key as a header, not in the body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entry: { sequence: 1 } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.postEntry({ date: '2025-01-05', postings: [] }, 'key-123');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['idempotency-key']).toBe('key-123');
    expect(init.body).not.toContain('key-123');
  });

  it('turns an error body into a typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'CLOSED_PERIOD',
              message: 'The period 2025-02-01..2025-02-28 is closed.',
              details: { from: '2025-02-01' },
            },
          },
          409,
        ),
      ),
    );

    const error = await request('/v1/entries', { method: 'POST', body: {} }).catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('CLOSED_PERIOD');
    expect(error.status).toBe(409);
    expect(error.message).toContain('is closed');
    expect(error.details).toEqual({ from: '2025-02-01' });
  });

  it('still fails usefully when the body is not the expected shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway timeout', { status: 504 })),
    );

    const error = await request('/v1/entries').catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('REQUEST_FAILED');
    expect(error.status).toBe(504);
  });
});

describe('api', () => {
  it('omits empty query parameters instead of sending blanks', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ entries: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api.entries('2025-01-01', '', '');
    expect(fetchMock.mock.calls[0][0]).toBe('/v1/entries?from=2025-01-01');

    await api.incomeStatement(undefined, '2025-01-31');
    expect(fetchMock.mock.calls[1][0]).toBe('/v1/reports/income-statement?to=2025-01-31');
  });

  it('escapes an account code into the path', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ report: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await api.accountStatement('1100', '2025-01-01', '2025-01-31');
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/v1/reports/accounts/1100?from=2025-01-01&to=2025-01-31',
    );
  });
});
