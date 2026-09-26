/**
 * The HTTP client.
 *
 * Every call goes through {@link request}, so there is exactly one place that
 * knows how the API reports failure: a body of `{ error: { code, message,
 * details } }`. The UI shows `code` and `message`; `details` is kept for the
 * balance numbers in an `UNBALANCED_ENTRY`, which is the one case where the
 * server is more precise than a sentence.
 */

export class ApiError extends Error {
  /**
   * @param {{ code: string, message: string, details?: Record<string, unknown> }} error
   * @param {number} status
   */
  constructor(error, status) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.status = status;
    this.details = error.details ?? {};
  }
}

/** @param {string} path @param {RequestInit & { idempotencyKey?: string }} [options] */
export async function request(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  /** @type {unknown} */
  let payload = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error =
      /** @type {{error?: {code?: string, message?: string, details?: Record<string, unknown>}}} */ (
        payload
      )?.error;
    throw new ApiError(
      {
        code: error?.code ?? 'REQUEST_FAILED',
        message: error?.message ?? `The request failed with ${response.status}.`,
        details: error?.details ?? {},
      },
      response.status,
    );
  }

  return payload;
}

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
};

export const api = {
  health: () => request('/health'),
  verify: () => request('/v1/verify'),
  accounts: (type) => request(`/v1/accounts${query({ type })}`),
  account: (code) => request(`/v1/accounts/${encodeURIComponent(code)}`),
  createAccount: (body) => request('/v1/accounts', { method: 'POST', body }),
  updateAccount: (code, body) =>
    request(`/v1/accounts/${encodeURIComponent(code)}`, { method: 'PATCH', body }),
  entries: (from, to, reference) => request(`/v1/entries${query({ from, to, reference })}`),
  postEntry: (body, idempotencyKey) =>
    request('/v1/entries', { method: 'POST', body, idempotencyKey }),
  reverseEntry: (id, body) =>
    request(`/v1/entries/${encodeURIComponent(id)}/reversal`, { method: 'POST', body }),
  rates: () => request('/v1/fx/rates'),
  recordRate: (body) => request('/v1/fx/rates', { method: 'POST', body }),
  rules: () => request('/v1/recurring'),
  createRule: (body) => request('/v1/recurring', { method: 'POST', body }),
  runRecurring: (until) => request('/v1/recurring/run', { method: 'POST', body: { until } }),
  occurrences: (id, until) =>
    request(`/v1/recurring/${encodeURIComponent(id)}/occurrences${query({ until })}`),
  trialBalance: (to) => request(`/v1/reports/trial-balance${query({ to })}`),
  balanceSheet: (to) => request(`/v1/reports/balance-sheet${query({ to })}`),
  incomeStatement: (from, to) => request(`/v1/reports/income-statement${query({ from, to })}`),
  accountStatement: (code, from, to) =>
    request(`/v1/reports/accounts/${encodeURIComponent(code)}${query({ from, to })}`),
  periods: () => request('/v1/periods'),
  closePeriod: (body) => request('/v1/periods/close', { method: 'POST', body }),
};
