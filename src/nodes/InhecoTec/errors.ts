/**
 * Error mapping of the Inheco TEC node (design C15 errors, FR-14.5, FR-14.8).
 *
 * An API error (`InhecoTecApiError`: HTTP status + parsed unified error body) becomes one message
 * built only from body fields:
 *
 *   `Inheco TEC API <status> <kind>: <message>` plus `; firmware code <code> (<code_description>)`
 *   or `; transport failure <failure>`.
 *
 * For `stop_not_delivered` the API message (which starts "Stop was NOT delivered" or
 * "Emergency-off was NOT delivered") is kept; if a body ever lacks it, a fixed "Stop was NOT
 * delivered" text is used so the message always states it (FR-14.8).
 *
 * The request options and headers are never read here, so the token cannot reach a message
 * (FR-14.5). The node additionally passes the token as a redaction value (defence in depth).
 */

import { NodeOperationError, type INode } from 'n8n-workflow';

import { OperationParameterError } from './operations';
import { InhecoTecApiError, InhecoTecTransportError } from './transport';

/** Longest body field copied into a message. */
const MAX_FIELD_LENGTH = 300;

const NOT_DELIVERED_FALLBACK = 'Stop was NOT delivered';

interface ApiErrorFields {
  kind: string;
  message: string | undefined;
  code: string | undefined;
  codeDescription: string | undefined;
  failure: string | undefined;
}

/** A body field as one short printable line, or `undefined` when absent or not a string/number. */
function field(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (text === '') return undefined;
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}...` : text;
}

/** The `error` object of the unified body `{"error": {...}}`, or an empty object. */
function errorObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') return {};
  const inner = (body as { error?: unknown }).error;
  return inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
}

function fieldsOf(body: unknown): ApiErrorFields {
  const error = errorObject(body);
  const kind = field(error.kind);
  return {
    // A kind is a snake_case word; anything else is not trusted as one.
    kind: kind !== undefined && /^[a-z_]{1,64}$/.test(kind) ? kind : 'unknown_error',
    message: field(error.message),
    code: field(error.code),
    codeDescription: field(error.code_description),
    failure: field(error.failure),
  };
}

/** The node error message of an API error response (FR-14.5, FR-14.8). */
export function formatApiErrorMessage(statusCode: number, body: unknown): string {
  const fields = fieldsOf(body);
  let message = fields.message ?? 'no error message';
  if (fields.kind === 'stop_not_delivered' && !message.includes('NOT delivered')) {
    message = `${NOT_DELIVERED_FALLBACK}: ${message}`;
  }
  let text = `Inheco TEC API ${statusCode} ${fields.kind}: ${message}`;
  if (fields.code !== undefined) {
    text += `; firmware code ${fields.code} (${fields.codeDescription ?? 'no description'})`;
  } else if (fields.failure !== undefined) {
    text += `; transport failure ${fields.failure}`;
  }
  return text;
}

/** The node error message of a transport failure (no API response). */
export function formatTransportErrorMessage(error: InhecoTecTransportError): string {
  return `Inheco TEC API request failed (${error.reason}): ${error.message}`;
}

/** The node error message of any error raised while running one operation. */
export function errorMessageOf(error: unknown): string {
  if (error instanceof InhecoTecApiError) return formatApiErrorMessage(error.statusCode, error.body);
  if (error instanceof InhecoTecTransportError) return formatTransportErrorMessage(error);
  if (error instanceof OperationParameterError) return `Inheco TEC parameter error: ${error.message}`;
  return 'Inheco TEC operation failed with an unexpected error';
}

/** Replace every occurrence of each non-empty value of `redactValues` in `text`. */
export function redact(text: string, redactValues: readonly (string | undefined)[]): string {
  let result = text;
  for (const value of redactValues) {
    if (typeof value === 'string' && value.length > 0) result = result.split(value).join('[redacted]');
  }
  return result;
}

/**
 * The `NodeOperationError` for `error`. It is built from a message string only, so the original
 * error object (and anything it might reference) is never attached to the n8n error.
 */
export function toNodeOperationError(
  node: INode,
  error: unknown,
  itemIndex: number,
  redactValues: readonly (string | undefined)[] = [],
): NodeOperationError {
  return new NodeOperationError(node, redact(errorMessageOf(error), redactValues), { itemIndex });
}
