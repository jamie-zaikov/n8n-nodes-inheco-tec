/**
 * Suite for the Inheco TEC n8n node class (Task 22, FR-1.3, FR-10.2, FR-14.2, FR-14.3, FR-14.5,
 * FR-14.7, FR-14.8, design C15).
 *
 * Offline: `sendInhecoTecRequest` is replaced by a mock (the error classes stay real), so the
 * node never opens a socket, binds a port or makes a real HTTPS call. The n8n execute context is
 * a small fake. The token is a short placeholder.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IExecuteFunctions, INode, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport')>();
  return { ...actual, sendInhecoTecRequest: vi.fn() };
});

import { INHECO_TEC_CREDENTIAL_NAME } from '../../credentials/InhecoTecApi.credentials';
import { EMERGENCY_OFF_CONFIRM_DESCRIPTION, InhecoTec, MAX_TIMEOUT_MS } from './InhecoTec.node';
import { OPERATION_IDS, type InhecoTecOperation } from './operations';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  InhecoTecApiError,
  InhecoTecTransportError,
  sendInhecoTecRequest,
} from './transport';

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE_SOURCE = readFileSync(path.join(here, 'InhecoTec.node.ts'), 'utf8');
const SOURCES = ['InhecoTec.node.ts', 'operations.ts', 'errors.ts', 'transport.ts'].map((file) => ({
  file,
  text: readFileSync(path.join(here, file), 'utf8'),
}));

const TOK = 'test-tok';
const CREDS = { baseUrl: 'https://tec.example:8743', token: TOK };

const send = vi.mocked(sendInhecoTecRequest);

const NODE: INode = {
  id: 'n1',
  name: 'Inheco TEC',
  type: 'n8n-nodes-inheco-tec.inhecoTec',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

type Params = Record<string, unknown>;

/** A fake n8n execute context: one parameter map per item. */
function context(items: Params[], options: { continueOnFail?: boolean } = {}) {
  const getCredentials = vi.fn(async () => CREDS);
  const ctx = {
    getInputData: () => items.map(() => ({ json: {} })),
    getCredentials,
    getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
      const value = items[itemIndex]![name];
      if (value === undefined) {
        if (fallback === undefined) throw new Error(`parameter ${name} has no value`);
        return fallback;
      }
      return value;
    },
    getNode: () => NODE,
    continueOnFail: () => options.continueOnFail ?? false,
  };
  return { ctx: ctx as unknown as IExecuteFunctions, getCredentials };
}

function run(items: Params[], options: { continueOnFail?: boolean } = {}) {
  const { ctx, getCredentials } = context(items, options);
  return { promise: new InhecoTec().execute.call(ctx), getCredentials };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected execute to reject');
}

const description = new InhecoTec().description;

function property(name: string, operation?: InhecoTecOperation): INodeProperties {
  const found = description.properties.find(
    (p) =>
      p.name === name &&
      (operation === undefined || (p.displayOptions?.show?.operation as string[] | undefined)?.includes(operation)),
  );
  if (found === undefined) throw new Error(`node property ${name} is missing`);
  return found;
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ ok: true });
});

describe('node description (FR-14.2, design C15)', () => {
  it('test_fr14_2_node_identity_and_credential', () => {
    expect(description.name).toBe('inhecoTec');
    expect(description.icon).toBe('file:inhecoTec.svg');
    expect(description.credentials).toEqual([{ name: INHECO_TEC_CREDENTIAL_NAME, required: true }]);
    expect(property('resource').options).toEqual([{ name: 'Controller', value: 'controller' }]);
  });

  it('test_fr14_2_operation_options_list_all_fifteen_operations', () => {
    const options = property('operation').options as { value: string }[];
    expect(options.map((o) => o.value)).toEqual([...OPERATION_IDS]);
  });

  it('test_fr14_2_parameter_defaults_and_ranges', () => {
    expect(property('controllerId')).toMatchObject({ default: 0, typeOptions: { minValue: 0, maxValue: 7 } });
    expect(property('slotId')).toMatchObject({ default: 1, typeOptions: { minValue: 1, maxValue: 6 } });
    expect(property('selector', 'getActualTemperature')).toMatchObject({ default: 3 });
    expect(property('temperatureC').required).toBe(true);
  });

  it('test_fr14_2_timeout_max_value_is_a_valid_node_timer_delay', () => {
    const timeout = property('timeoutMs');
    expect(timeout.default).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(MAX_TIMEOUT_MS).toBeLessThanOrEqual(2_147_483_647);
    expect(timeout.typeOptions?.maxValue).toBeLessThanOrEqual(2_147_483_647);
    expect(timeout.typeOptions?.minValue).toBeGreaterThanOrEqual(1);
  });
});

describe('Emergency Off confirmation parameter (FR-14.7)', () => {
  it('test_fr14_7_confirm_is_a_required_boolean_defaulting_to_false', () => {
    const confirm = property('confirm');
    expect(confirm.type).toBe('boolean');
    expect(confirm.required).toBe(true);
    expect(confirm.default).toBe(false);
    expect(confirm.displayOptions?.show?.operation).toEqual(['emergencyOff']);
  });

  it('test_fr14_7_confirm_description_states_power_off_and_recovery', () => {
    const text = property('confirm').description ?? '';
    expect(text).toBe(EMERGENCY_OFF_CONFIRM_DESCRIPTION);
    expect(text).toMatch(/switches off all slot power outputs/i);
    expect(text).toMatch(/Connect/);
    expect(text).toMatch(/re-initiali[sz]e/i);
    expect(text).toMatch(/Reacquire/);
  });

  it('test_fr14_7_emergency_off_sends_confirm_false_when_unset', async () => {
    const { promise } = run([{ operation: 'emergencyOff', controllerId: 1 }]);
    await promise;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toEqual({
      method: 'POST',
      path: '/v1/controllers/1/emergency-off',
      body: { confirm: false },
    });
  });

  it('test_fr14_7_emergency_off_sends_confirm_true_when_set', async () => {
    const { promise } = run([{ operation: 'emergencyOff', controllerId: 0, confirm: true }]);
    await promise;
    expect(send.mock.calls[0]![1]).toMatchObject({ body: { confirm: true } });
  });
});

describe('execute (FR-14.2, FR-14.3)', () => {
  const cases: [InhecoTecOperation, Params, { method: string; path: string; body?: unknown }][] = [
    ['getStatus', {}, { method: 'GET', path: '/v1/status' }],
    ['connect', { controllerId: 2 }, { method: 'POST', path: '/v1/controllers/2/connect' }],
    [
      'setTargetTemperature',
      { controllerId: 1, slotId: 3, temperatureC: 4 },
      { method: 'PUT', path: '/v1/controllers/1/slots/3/target', body: { temperature_c: 4 } },
    ],
    ['startTemperatureControl', { slotId: 2 }, { method: 'POST', path: '/v1/controllers/0/slots/2/start' }],
    ['stopTemperatureControl', {}, { method: 'POST', path: '/v1/controllers/0/slots/1/stop' }],
    ['stopAll', {}, { method: 'POST', path: '/v1/stop-all' }],
    ['getActualTemperature', {}, { method: 'GET', path: '/v1/controllers/0/slots/1/temperature?selector=3' }],
    ['getTargetTemperature', { slotId: 6 }, { method: 'GET', path: '/v1/controllers/0/slots/6/target' }],
    ['checkAtTarget', {}, { method: 'GET', path: '/v1/controllers/0/slots/1/at-target' }],
    ['getSensorValues', {}, { method: 'GET', path: '/v1/controllers/0/sensor-values?selector=0' }],
    ['getDeviceType', {}, { method: 'GET', path: '/v1/controllers/0/device-type?slot=0' }],
    ['getFirmwareVersion', { selector: 4 }, { method: 'GET', path: '/v1/controllers/0/firmware-version?selector=4' }],
    ['releaseController', { controllerId: 7 }, { method: 'POST', path: '/v1/controllers/7/release' }],
    ['reacquireController', { controllerId: 7 }, { method: 'POST', path: '/v1/controllers/7/reacquire' }],
    ['emergencyOff', {}, { method: 'POST', path: '/v1/controllers/0/emergency-off', body: { confirm: false } }],
  ];

  it('test_fr14_2_cases_cover_all_operations', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual([...OPERATION_IDS].sort());
  });

  it.each(cases)('test_fr14_2_execute_sends_one_request_for_%s', async (operation, params, expected) => {
    const { promise, getCredentials } = run([{ operation, ...params }]);
    const result = await promise;
    expect(getCredentials).toHaveBeenCalledWith(INHECO_TEC_CREDENTIAL_NAME);
    expect(send).toHaveBeenCalledTimes(1);
    const [credentials, request, options] = send.mock.calls[0]!;
    expect(credentials).toEqual(CREDS);
    expect(request).toEqual(expected.body === undefined ? { method: expected.method, path: expected.path } : expected);
    expect(options).toEqual({ timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
    expect(result).toEqual([[{ json: { ok: true }, pairedItem: { item: 0 } }]]);
  });

  it('test_fr14_2_check_at_target_sends_a_non_zero_tolerance', async () => {
    const { promise } = run([{ operation: 'checkAtTarget', tolerance: 0.5 }]);
    await promise;
    expect(send.mock.calls[0]![1].path).toBe('/v1/controllers/0/slots/1/at-target?tolerance_c=0.5');
  });

  it('test_fr14_2_timeout_parameter_is_passed_to_the_transport', async () => {
    const { promise } = run([{ operation: 'getStatus', timeoutMs: 5000 }]);
    await promise;
    expect(send.mock.calls[0]![2]).toEqual({ timeoutMs: 5000 });
  });

  it('test_fr14_3_one_request_per_item_and_response_returned_as_is', async () => {
    send.mockResolvedValueOnce({ a: 1 }).mockResolvedValueOnce([1, 2]).mockResolvedValueOnce(null);
    const { promise } = run([
      { operation: 'setTargetTemperature', temperatureC: 10 },
      { operation: 'startTemperatureControl' },
      { operation: 'getStatus' },
    ]);
    const result = await promise;
    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toEqual([
      [
        { json: { a: 1 }, pairedItem: { item: 0 } },
        { json: { result: [1, 2] }, pairedItem: { item: 1 } },
        { json: { result: null }, pairedItem: { item: 2 } },
      ],
    ]);
  });

  it('test_fr14_3_set_target_and_start_return_when_the_api_responds', async () => {
    // A single resolved response ends the item: no re-poll, no second request.
    send.mockResolvedValue({ slot: 1, target_c: 4 });
    for (const operation of ['setTargetTemperature', 'startTemperatureControl'] as const) {
      send.mockClear();
      const { promise } = run([{ operation, temperatureC: 4 }]);
      await promise;
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('test_fr14_3_node_source_has_no_wait_or_sleep_loop', () => {
    // `await` is legal; only a wait/sleep/timer/while construct is forbidden.
    expect(NODE_SOURCE).not.toMatch(/\bwait\b|sleep|setTimeout|setInterval|\bwhile\b/i);
    const operationsSource = SOURCES.find((s) => s.file === 'operations.ts')!.text;
    expect(operationsSource).not.toMatch(/\bwait\b|sleep|setTimeout|setInterval|\bwhile\b/i);
  });
});

describe('errors (FR-14.5, FR-14.8)', () => {
  it('test_fr14_8_409_stop_not_delivered_raises_not_delivered', async () => {
    send.mockRejectedValue(
      new InhecoTecApiError(409, { error: { kind: 'stop_not_delivered', message: 'Stop was NOT delivered: released' } }),
    );
    for (const operation of ['stopTemperatureControl', 'stopAll', 'emergencyOff'] as const) {
      const error = await rejected(run([{ operation, confirm: true }]).promise);
      expect(error).toBeInstanceOf(NodeOperationError);
      expect(error.message).toContain('NOT delivered');
      expect(error.message).toContain('409');
    }
  });

  it('test_fr14_5_api_error_carries_status_code_and_description', async () => {
    send.mockRejectedValue(
      new InhecoTecApiError(502, {
        error: { kind: 'firmware_error', message: 'rejected', code: 'E05', code_description: 'out of range' },
      }),
    );
    const error = await rejected(run([{ operation: 'connect' }]).promise);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect(error.message).toBe('Inheco TEC API 502 firmware_error: rejected; firmware code E05 (out of range)');
  });

  it('test_fr14_5_transport_failure_is_mapped', async () => {
    send.mockRejectedValue(new InhecoTecTransportError('timeout', 'Inheco TEC API request timed out after 5 ms'));
    const error = await rejected(run([{ operation: 'getStatus' }]).promise);
    expect(error.message).toBe('Inheco TEC API request failed (timeout): Inheco TEC API request timed out after 5 ms');
  });

  it('test_fr14_5_no_error_message_contains_the_token', async () => {
    const failures: unknown[] = [
      new InhecoTecApiError(401, { error: { kind: 'unauthorized', message: `bad token ${TOK}` } }),
      new InhecoTecApiError(504, { error: { kind: 'device_timeout', message: 'm', failure: TOK } }),
      new InhecoTecTransportError('invalid_credentials', `token ${TOK}`),
      new Error(`unexpected ${TOK}`),
    ];
    for (const failure of failures) {
      send.mockRejectedValueOnce(failure);
      const error = await rejected(run([{ operation: 'getStatus' }]).promise);
      expect(error).toBeInstanceOf(NodeOperationError);
      expect(error.message).not.toContain(TOK);
      expect(JSON.stringify(error)).not.toContain(TOK);
      expect(String(error.stack)).not.toContain(TOK);

      send.mockRejectedValueOnce(failure);
      const items = await run([{ operation: 'getStatus' }], { continueOnFail: true }).promise;
      expect(JSON.stringify(items)).not.toContain(TOK);
    }
  });

  it('test_fr14_5_bad_parameter_is_a_node_error_without_a_request', async () => {
    const error = await rejected(run([{ operation: 'connect', controllerId: 1.5 }]).promise);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect(error.message).toContain('controllerId');
    expect(send).not.toHaveBeenCalled();
  });

  it('test_fr10_2_unknown_operation_is_refused_without_a_request', async () => {
    const error = await rejected(run([{ operation: 'sendCommand' }]).promise);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect(error.message).toContain('Unknown Inheco TEC operation');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('continueOnFail (design C15, D5)', () => {
  it('test_continue_on_fail_gives_an_error_item_and_continues', async () => {
    send
      .mockRejectedValueOnce(new InhecoTecApiError(409, { error: { kind: 'stop_not_delivered', message: 'Stop was NOT delivered' } }))
      .mockResolvedValueOnce({ ok: true });
    const result = await run([{ operation: 'stopAll' }, { operation: 'getStatus' }], { continueOnFail: true }).promise;
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      [
        { json: { error: 'Inheco TEC API 409 stop_not_delivered: Stop was NOT delivered' }, pairedItem: { item: 0 } },
        { json: { ok: true }, pairedItem: { item: 1 } },
      ],
    ]);
  });

  it('test_without_continue_on_fail_the_first_error_stops_execution', async () => {
    send.mockRejectedValueOnce(new InhecoTecTransportError('request_failed', 'Inheco TEC API request failed'));
    const error = await rejected(run([{ operation: 'getStatus' }, { operation: 'getStatus' }]).promise);
    expect(error).toBeInstanceOf(NodeOperationError);
    expect((error as NodeOperationError).context.itemIndex).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('package boundaries (FR-1.3, FR-10.2)', () => {
  it('test_fr1_3_node_sources_import_no_api_code', () => {
    for (const { file, text } of SOURCES) {
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const specifier of specifiers) {
        expect(specifier, `${file}: ${specifier}`).not.toMatch(/(^|\/)api(\/|$)|inheco_tec_api/);
      }
    }
  });

  it('test_fr1_3_node_imports_only_n8n_workflow_its_modules_and_the_credential', () => {
    const specifiers = [...NODE_SOURCE.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const specifier of specifiers) {
      expect(['n8n-workflow', './errors', './operations', './transport', '../../credentials/InhecoTecApi.credentials']).toContain(
        specifier,
      );
    }
    // The transport reaches the API over HTTPS only.
    const transport = SOURCES.find((s) => s.file === 'transport.ts')!.text;
    expect(transport).toMatch(/from 'node:https'/);
    // `node:http` may appear only as a type-only import (ClientRequest / IncomingMessage types).
    expect(transport).not.toMatch(/^import (?!type )[^;]*from 'node:http';/m);
    expect(transport).not.toMatch(/from 'node:net'|from 'node:child_process'/);
    expect(transport).toMatch(/from 'n8n-node-core'/);
  });

  it('test_fr10_2_node_has_no_raw_command_operation_or_string_parameter', () => {
    const options = property('operation').options as { name: string; value: string }[];
    for (const option of options) {
      expect(`${option.name} ${option.value}`.toLowerCase()).not.toMatch(/raw|command|send/);
    }
    const stringParams = description.properties.filter((p) => p.type === 'string');
    expect(stringParams).toEqual([]);
  });
});

describe('build output (optional)', () => {
  const bundle = path.resolve(here, '../../../dist/nodes/InhecoTec/InhecoTec.node.js');
  it.skipIf(!existsSync(bundle))('test_build_emits_the_node_bundle', () => {
    expect(existsSync(bundle)).toBe(true);
    expect(existsSync(path.resolve(here, '../../../dist/nodes/InhecoTec/inhecoTec.svg'))).toBe(true);
  });
});
