/**
 * Suite for the Inheco TEC node error mapping (Task 22, FR-14.5, FR-14.8, design C15 errors).
 *
 * Pure and offline: errors are constructed directly; no request is sent. The token is a short
 * placeholder and must never appear in a mapped message.
 */
import { NodeOperationError, type INode } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import {
  errorMessageOf,
  formatApiErrorMessage,
  formatTransportErrorMessage,
  redact,
  toNodeOperationError,
} from './errors';
import { OperationParameterError } from './operations';
import { InhecoTecApiError, InhecoTecTransportError } from './transport';

const TOK = 'test-tok';

const NODE: INode = {
  id: 'n1',
  name: 'Inheco TEC',
  type: 'n8n-nodes-inheco-tec.inhecoTec',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

function body(error: Record<string, unknown>): unknown {
  return { error };
}

describe('API error message per kind (FR-14.5)', () => {
  it('test_fr14_5_firmware_code_kind_carries_status_kind_code_and_description', () => {
    const message = formatApiErrorMessage(
      502,
      body({ kind: 'firmware_error', message: 'Controller rejected the command', code: 'E05', code_description: 'value out of range' }),
    );
    expect(message).toBe(
      'Inheco TEC API 502 firmware_error: Controller rejected the command; firmware code E05 (value out of range)',
    );
  });

  it('test_fr14_5_numeric_firmware_code_without_description', () => {
    const message = formatApiErrorMessage(502, body({ kind: 'firmware_error', message: 'm', code: 7 }));
    expect(message).toBe('Inheco TEC API 502 firmware_error: m; firmware code 7 (no description)');
  });

  it('test_fr14_5_transport_failure_kind_carries_the_failure', () => {
    const message = formatApiErrorMessage(
      504,
      body({ kind: 'device_timeout', message: 'No reply from controller 0', failure: 'timeout' }),
    );
    expect(message).toBe('Inheco TEC API 504 device_timeout: No reply from controller 0; transport failure timeout');
  });

  it('test_fr14_5_code_takes_precedence_over_failure', () => {
    const message = formatApiErrorMessage(502, body({ kind: 'k', message: 'm', code: 'E1', code_description: 'd', failure: 'f' }));
    expect(message).toContain('firmware code E1 (d)');
    expect(message).not.toContain('transport failure');
  });

  it('test_fr14_5_plain_kind_without_code_or_failure', () => {
    expect(formatApiErrorMessage(422, body({ kind: 'validation_error', message: 'bad slot' }))).toBe(
      'Inheco TEC API 422 validation_error: bad slot',
    );
  });

  it('test_fr14_5_unknown_or_malformed_kind_becomes_unknown_error', () => {
    expect(formatApiErrorMessage(500, body({ message: 'x' }))).toBe('Inheco TEC API 500 unknown_error: x');
    expect(formatApiErrorMessage(500, body({ kind: 'Bad Kind!', message: 'x' }))).toBe(
      'Inheco TEC API 500 unknown_error: x',
    );
    expect(formatApiErrorMessage(500, body({ kind: 12, message: 'x' }))).toBe('Inheco TEC API 500 unknown_error: x');
  });

  it('test_fr14_5_missing_or_non_json_body_still_gives_status', () => {
    expect(formatApiErrorMessage(503, null)).toBe('Inheco TEC API 503 unknown_error: no error message');
    expect(formatApiErrorMessage(503, 'text')).toBe('Inheco TEC API 503 unknown_error: no error message');
    expect(formatApiErrorMessage(503, { error: 'flat' })).toBe('Inheco TEC API 503 unknown_error: no error message');
  });

  it('test_fr14_5_control_characters_are_stripped_and_fields_capped', () => {
    const message = formatApiErrorMessage(500, body({ kind: 'k', message: `line1\n\r\u0007line2${'x'.repeat(1000)}` }));
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(message).toContain('line1 line2');
    expect(message.length).toBeLessThan(400);
    expect(message.endsWith('...')).toBe(true);
  });

  it('test_fr14_5_only_body_error_fields_are_used', () => {
    const message = formatApiErrorMessage(401, {
      error: { kind: 'unauthorized', message: 'Missing or invalid bearer token' },
      headers: { Authorization: `Bearer ${TOK}` },
      token: TOK,
    });
    expect(message).toBe('Inheco TEC API 401 unauthorized: Missing or invalid bearer token');
    expect(message).not.toContain(TOK);
  });
});

describe('stop not delivered (FR-14.8)', () => {
  it('test_fr14_8_409_stop_not_delivered_keeps_the_api_message', () => {
    const message = formatApiErrorMessage(
      409,
      body({ kind: 'stop_not_delivered', message: 'Stop was NOT delivered: controller 0 is released' }),
    );
    expect(message).toBe('Inheco TEC API 409 stop_not_delivered: Stop was NOT delivered: controller 0 is released');
  });

  it('test_fr14_8_emergency_off_not_delivered_message_is_kept', () => {
    const message = formatApiErrorMessage(409, body({ kind: 'stop_not_delivered', message: 'Emergency-off was NOT delivered' }));
    expect(message).toContain('Emergency-off was NOT delivered');
  });

  it('test_fr14_8_not_delivered_is_stated_even_if_the_body_lacks_it', () => {
    for (const raw of [body({ kind: 'stop_not_delivered', message: 'controller busy' }), body({ kind: 'stop_not_delivered' })]) {
      const message = formatApiErrorMessage(409, raw);
      expect(message).toContain('409');
      expect(message).toContain('NOT delivered');
    }
  });

  it('test_fr14_8_node_error_for_409_contains_not_delivered', () => {
    const error = toNodeOperationError(
      NODE,
      new InhecoTecApiError(409, body({ kind: 'stop_not_delivered', message: 'Stop was NOT delivered' })),
      0,
      [TOK],
    );
    expect(error).toBeInstanceOf(NodeOperationError);
    expect(error.message).toContain('NOT delivered');
    expect(error.message).toContain('409');
  });
});

describe('transport and other errors (FR-14.5)', () => {
  it('test_fr14_5_transport_failure_message_carries_reason', () => {
    const error = new InhecoTecTransportError('request_failed', 'Inheco TEC API request failed', 'ECONNREFUSED');
    expect(formatTransportErrorMessage(error)).toBe(
      'Inheco TEC API request failed (request_failed): Inheco TEC API request failed (ECONNREFUSED)',
    );
    expect(errorMessageOf(error)).toBe(formatTransportErrorMessage(error));
  });

  it('test_fr14_5_parameter_and_unexpected_errors', () => {
    expect(errorMessageOf(new OperationParameterError('slotId', 'Parameter slotId must be an integer'))).toBe(
      'Inheco TEC parameter error: Parameter slotId must be an integer',
    );
    expect(errorMessageOf(new Error(`boom ${TOK}`))).toBe('Inheco TEC operation failed with an unexpected error');
    expect(errorMessageOf('string')).toBe('Inheco TEC operation failed with an unexpected error');
  });

  it('test_fr14_5_api_error_maps_through_error_message_of', () => {
    const error = new InhecoTecApiError(502, body({ kind: 'firmware_error', message: 'm', code: 'E2', code_description: 'd' }));
    expect(errorMessageOf(error)).toBe('Inheco TEC API 502 firmware_error: m; firmware code E2 (d)');
  });
});

describe('the token never reaches a message (FR-14.5)', () => {
  it('test_fr14_5_redact_replaces_every_occurrence', () => {
    expect(redact(`a ${TOK} b ${TOK}`, [TOK])).toBe('a [redacted] b [redacted]');
    expect(redact('nothing', [TOK, undefined, ''])).toBe('nothing');
    expect(redact('x', [])).toBe('x');
  });

  it('test_fr14_5_node_error_redacts_a_token_echoed_in_the_body', () => {
    const errors: unknown[] = [
      new InhecoTecApiError(401, body({ kind: 'unauthorized', message: `token ${TOK} is invalid`, code_description: TOK, code: 'E1' })),
      new InhecoTecApiError(504, body({ kind: 'device_timeout', message: 'm', failure: TOK })),
      new InhecoTecTransportError('invalid_credentials', `bad ${TOK}`),
      new OperationParameterError('x', `bad ${TOK}`),
      new Error(TOK),
    ];
    for (const raw of errors) {
      const error = toNodeOperationError(NODE, raw, 2, [TOK]);
      expect(error).toBeInstanceOf(NodeOperationError);
      expect(error.message).not.toContain(TOK);
      expect(String(error.description ?? '')).not.toContain(TOK);
      expect(JSON.stringify(error)).not.toContain(TOK);
      expect(String(error.stack)).not.toContain(TOK);
      expect(error.context.itemIndex).toBe(2);
    }
  });

  it('test_fr14_5_node_error_does_not_attach_the_original_error', () => {
    const raw = new InhecoTecApiError(500, body({ kind: 'internal_error', message: 'm' }));
    const error = toNodeOperationError(NODE, raw, 0, [TOK]);
    expect(error.cause).not.toBe(raw);
    expect(JSON.stringify(error)).not.toContain('InhecoTecApiError');
  });
});
