/**
 * HTTPS transport from the node to the Inheco TEC API (design C15, DD-8, FR-1.3, FR-14.1).
 *
 * The request descriptor (URL + bearer header) comes from the shared `n8n-node-core` base
 * (`buildApiRequest` / `buildAuthHeader`). The request is sent with `node:https` instead of the
 * n8n request helpers so that each credential can carry its own CA certificate; the server
 * certificate is always verified (`rejectUnauthorized: true`). The node reaches the API only
 * over HTTPS and never imports code from `api/`.
 *
 * Errors never carry the request options, the headers or the token: an API error holds only the
 * HTTP status and the parsed response body, and a transport error holds only a fixed reason and,
 * when present, the Node.js error code.
 */

import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import { buildApiRequest, InstrumentApiError, NodeCoreError } from 'n8n-node-core';

import {
  assertHttpsBaseUrl,
  type InhecoTecCredentialData,
} from '../../credentials/InhecoTecApi.credentials';

/**
 * Default "Timeout (ms)" for one request: above the API worst case for a two-transaction
 * operation plus one controller lock wait (design C15).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Upper bound on a response body; API responses are small JSON documents. */
export const MAX_RESPONSE_BYTES = 1_048_576;

export type HttpMethod = 'GET' | 'POST' | 'PUT';

/** One API call: method, path (with any query string) and an optional JSON body. */
export interface InhecoTecRequest {
  method: HttpMethod;
  path: string;
  body?: unknown;
}

/** The `node:https.request` call shape; tests inject a fake so no socket is opened. */
export type HttpsRequestFn = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface TransportOptions {
  /** Whole-request deadline in milliseconds; defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Request function; defaults to `node:https.request`. */
  requestFn?: HttpsRequestFn;
}

/**
 * The API answered with a non-2xx status. `body` is the parsed JSON response body (the unified
 * API error body), or `null` when the body is empty or not JSON.
 */
export class InhecoTecApiError extends InstrumentApiError {
  readonly body: unknown;

  constructor(statusCode: number, body: unknown) {
    super(statusCode, `Inheco TEC API returned HTTP ${statusCode}`);
    this.name = 'InhecoTecApiError';
    this.body = body;
  }
}

/** Why a request produced no usable API response. */
export type TransportFailure =
  | 'invalid_credentials'
  | 'invalid_timeout'
  | 'request_failed'
  | 'timeout'
  | 'response_too_large'
  | 'invalid_json';

/** The request did not produce a usable API response (network, TLS, timeout or bad JSON). */
export class InhecoTecTransportError extends NodeCoreError {
  readonly reason: TransportFailure;

  readonly code: string | undefined;

  constructor(reason: TransportFailure, message: string, code?: string) {
    super(code === undefined ? message : `${message} (${code})`);
    this.name = 'InhecoTecTransportError';
    this.reason = reason;
    this.code = code;
  }
}

interface RawResponse {
  statusCode: number;
  text: string;
}

/** Keep only a Node.js-style error code (for example `ECONNREFUSED`); never free text. */
function safeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

function exchange(
  requestFn: HttpsRequestFn,
  url: URL,
  options: RequestOptions,
  payload: string | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    const fail = (error: InhecoTecTransportError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new InhecoTecTransportError('timeout', `Inheco TEC API request timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    try {
      request = requestFn(url, options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            fail(new InhecoTecTransportError('response_too_large', 'Inheco TEC API response is too large'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', (error: unknown) => {
          fail(new InhecoTecTransportError('request_failed', 'Inheco TEC API response failed', safeErrorCode(error)));
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ statusCode: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
    } catch (error) {
      // A synchronous throw (for example an invalid header character) carries no response.
      fail(new InhecoTecTransportError('request_failed', 'Inheco TEC API request failed', safeErrorCode(error)));
      return;
    }

    request.on('timeout', () => {
      fail(new InhecoTecTransportError('timeout', `Inheco TEC API request timed out after ${timeoutMs} ms`));
    });
    request.on('error', (error: unknown) => {
      fail(new InhecoTecTransportError('request_failed', 'Inheco TEC API request failed', safeErrorCode(error)));
    });
    request.end(payload);
  });
}

/** Parse the body; an empty body is `null`, text that is not valid JSON gives `ok: false`. */
function parseBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Send one request to the Inheco TEC API and return the parsed JSON body of a 2xx response.
 *
 * Throws {@link InhecoTecApiError} (an `InstrumentApiError`) with the status and the parsed body
 * for a non-2xx response, and {@link InhecoTecTransportError} when no usable response arrives.
 */
export async function sendInhecoTecRequest(
  credentials: InhecoTecCredentialData,
  apiRequest: InhecoTecRequest,
  options: TransportOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new InhecoTecTransportError('invalid_timeout', 'Timeout (ms) must be a positive integer');
  }
  const baseUrl = typeof credentials.baseUrl === 'string' ? credentials.baseUrl.trim() : '';
  try {
    assertHttpsBaseUrl(baseUrl);
  } catch (error) {
    throw new InhecoTecTransportError('invalid_credentials', (error as Error).message);
  }
  const bearer = credentials.token;
  if (typeof bearer !== 'string' || bearer.length === 0) {
    throw new InhecoTecTransportError('invalid_credentials', 'Inheco TEC API credential has no token');
  }

  const descriptor = buildApiRequest({ baseUrl, bearerToken: bearer, timeoutMs }, apiRequest.method, apiRequest.path);
  const payload = apiRequest.body === undefined ? undefined : JSON.stringify(apiRequest.body);
  const headers: Record<string, string> = { ...descriptor.headers, Accept: 'application/json' };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  const requestOptions: RequestOptions = {
    method: descriptor.method,
    headers,
    ca: credentials.caCertificate?.trim() || undefined,
    rejectUnauthorized: true,
    timeout: descriptor.timeoutMs,
  };

  const response = await exchange(
    options.requestFn ?? httpsRequest,
    new URL(descriptor.url),
    requestOptions,
    payload,
    timeoutMs,
  );

  const parsed = parseBody(response.text);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    if (!parsed.ok) {
      throw new InhecoTecTransportError('invalid_json', 'Inheco TEC API returned a response that is not valid JSON');
    }
    return parsed.value;
  }
  throw new InhecoTecApiError(response.statusCode, parsed.ok ? parsed.value : null);
}
