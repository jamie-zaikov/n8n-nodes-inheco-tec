/**
 * Suite for the Inheco TEC operation table (Task 22, FR-10.2, FR-14.2, FR-14.7, design C15).
 *
 * Offline: the method, path and body come from the pure table, and the auth header is checked by
 * passing each built request through the real transport with a fake `requestFn`, so no socket is
 * opened, no port is bound and no real HTTPS call is made. The token is a short placeholder.
 *
 * Paths are checked against the route-contract snapshot `contract/api-routes.json` (method, path
 * template and query names of every functional route). The paired API repo commits the same
 * snapshot and tests its routes against it, so a route rename on either side fails a suite.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildOperationRequest,
  isInhecoTecOperation,
  OPERATION_IDS,
  OPERATIONS,
  OperationParameterError,
  type InhecoTecOperation,
  type OperationParameters,
} from './operations';
import { sendInhecoTecRequest, type HttpsRequestFn } from './transport';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.resolve(here, '../../../contract/api-routes.json');

const TOK = 'test-tok';
const CREDS = { baseUrl: 'https://tec.example:8743', token: TOK };

/** Distinctive IDs so the `{cid}` / `{sid}` segments can be mapped back to the template. */
const CID = 3;
const SID = 5;

/** Parameters that every operation accepts (each reads only its own subset). */
const FULL: OperationParameters = {
  controllerId: CID,
  slotId: SID,
  temperatureC: 37.5,
  selector: 2,
  tolerance: 0.5,
  deviceSlot: 4,
  confirm: true,
};

/** The expected C15 table: method, path template and body for the FULL parameters. */
const EXPECTED: Record<InhecoTecOperation, { method: string; path: string; body?: unknown }> = {
  getStatus: { method: 'GET', path: '/v1/status' },
  connect: { method: 'POST', path: '/v1/controllers/3/connect' },
  setTargetTemperature: { method: 'PUT', path: '/v1/controllers/3/slots/5/target', body: { temperature_c: 37.5 } },
  startTemperatureControl: { method: 'POST', path: '/v1/controllers/3/slots/5/start' },
  stopTemperatureControl: { method: 'POST', path: '/v1/controllers/3/slots/5/stop' },
  stopAll: { method: 'POST', path: '/v1/stop-all' },
  getActualTemperature: { method: 'GET', path: '/v1/controllers/3/slots/5/temperature?selector=2' },
  getTargetTemperature: { method: 'GET', path: '/v1/controllers/3/slots/5/target' },
  checkAtTarget: { method: 'GET', path: '/v1/controllers/3/slots/5/at-target?tolerance_c=0.5' },
  getSensorValues: { method: 'GET', path: '/v1/controllers/3/sensor-values?selector=2' },
  getDeviceType: { method: 'GET', path: '/v1/controllers/3/device-type?slot=4' },
  getFirmwareVersion: { method: 'GET', path: '/v1/controllers/3/firmware-version?selector=2' },
  releaseController: { method: 'POST', path: '/v1/controllers/3/release' },
  reacquireController: { method: 'POST', path: '/v1/controllers/3/reacquire' },
  emergencyOff: { method: 'POST', path: '/v1/controllers/3/emergency-off', body: { confirm: true } },
};

interface ContractRoute {
  method: string;
  path: string;
  query: string[];
}

/** The routes of the snapshot; a malformed entry fails the suite. */
function contractRoutes(): ContractRoute[] {
  const document = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { schema: unknown; routes: unknown };
  expect(document.schema).toBe(1);
  expect(Array.isArray(document.routes)).toBe(true);
  const routes = document.routes as ContractRoute[];
  for (const route of routes) {
    expect(Object.keys(route).sort()).toEqual(['method', 'path', 'query']);
    expect(typeof route.method === 'string' && typeof route.path === 'string').toBe(true);
    expect(Array.isArray(route.query) && route.query.every((q) => typeof q === 'string')).toBe(true);
  }
  return routes;
}

/** `METHOD template` of every functional route of the snapshot. */
function apiRoutes(): Set<string> {
  return new Set(contractRoutes().map((route) => `${route.method} ${route.path}`));
}

/** The query names of the snapshot route `METHOD template`. */
function contractQuery(key: string): string[] {
  const matches = contractRoutes().filter((route) => `${route.method} ${route.path}` === key);
  expect(matches, key).toHaveLength(1);
  return matches[0]!.query;
}

/** The route template of a built path: IDs back to `{cid}` / `{sid}`, query removed. */
function templateOf(builtPath: string): string {
  return builtPath
    .split('?')[0]!
    .replace(/^\/v1\/controllers\/\d+/, '/v1/controllers/{cid}')
    .replace(/\/slots\/\d+/, '/slots/{sid}');
}

interface Captured {
  url: URL;
  options: RequestOptions;
  payload: string | undefined;
}

/** A fake `https.request` that records the call and answers 200 `{}`; no socket is opened. */
function fakeRequestFn(): { requestFn: HttpsRequestFn; calls: Captured[] } {
  const calls: Captured[] = [];
  const requestFn: HttpsRequestFn = (url, options, callback) => {
    const call: Captured = { url, options, payload: undefined };
    calls.push(call);
    const req = new EventEmitter() as EventEmitter & { end: (p?: string) => void; destroy: () => void };
    req.destroy = () => undefined;
    req.end = (p?: string) => {
      call.payload = p;
      setImmediate(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode?: number };
        res.statusCode = 200;
        callback(res as unknown as IncomingMessage);
        res.emit('data', '{}');
        res.emit('end');
      });
    };
    return req as unknown as ClientRequest;
  };
  return { requestFn, calls };
}

describe('operation table (FR-14.2, design C15)', () => {
  it('test_fr14_2_offers_exactly_the_fifteen_operations', () => {
    expect(OPERATION_IDS).toHaveLength(15);
    expect(new Set(OPERATION_IDS).size).toBe(15);
    expect(Object.keys(OPERATIONS).sort()).toEqual([...OPERATION_IDS].sort());
    expect(OPERATION_IDS.map((op) => OPERATIONS[op].name)).toEqual([
      'Get Status',
      'Connect',
      'Set Target Temperature',
      'Start Temperature Control',
      'Stop Temperature Control',
      'Stop All',
      'Get Actual Temperature',
      'Get Target Temperature',
      'Check At Target',
      'Get Sensor Values',
      'Get Device Type',
      'Get Firmware Version',
      'Release Controller',
      'Reacquire Controller',
      'Emergency Off',
    ]);
  });

  it.each(OPERATION_IDS)('test_fr14_2_method_path_body_of_%s', (op) => {
    const expected = EXPECTED[op];
    const request = buildOperationRequest(op, FULL);
    expect(request.method).toBe(expected.method);
    expect(request.path).toBe(expected.path);
    expect(request.body).toEqual(expected.body);
    expect(OPERATIONS[op].method).toBe(expected.method);
  });

  it('test_fr14_2_every_operation_matches_a_real_api_route', () => {
    const routes = apiRoutes();
    // The snapshot holds exactly the fifteen functional routes the node maps to.
    expect(routes.size).toBe(15);
    const used = new Set<string>();
    for (const op of OPERATION_IDS) {
      const request = buildOperationRequest(op, FULL);
      const key = `${request.method} ${templateOf(request.path)}`;
      expect(routes, `${op} -> ${key}`).toContain(key);
      used.add(key);
    }
    expect(used).toEqual(routes);
  });

  it('test_fr14_2_query_names_match_the_api_route_signatures', () => {
    expect(contractQuery('GET /v1/controllers/{cid}/slots/{sid}/temperature')).toEqual(['selector']);
    expect(contractQuery('GET /v1/controllers/{cid}/slots/{sid}/at-target')).toEqual(['tolerance_c']);
    expect(contractQuery('GET /v1/controllers/{cid}/sensor-values')).toEqual(['selector']);
    expect(contractQuery('GET /v1/controllers/{cid}/device-type')).toEqual(['slot']);
    expect(contractQuery('GET /v1/controllers/{cid}/firmware-version')).toEqual(['selector']);
    // Every operation sends exactly the query names of its snapshot route.
    for (const op of OPERATION_IDS) {
      const request = buildOperationRequest(op, FULL);
      const sent = [...new URLSearchParams(request.path.split('?')[1] ?? '').keys()].sort();
      expect(sent, op).toEqual(contractQuery(`${request.method} ${templateOf(request.path)}`));
    }
    const query = (op: InhecoTecOperation) => new URLSearchParams(buildOperationRequest(op, FULL).path.split('?')[1]);
    expect([...query('getActualTemperature').keys()]).toEqual(['selector']);
    expect([...query('checkAtTarget').keys()]).toEqual(['tolerance_c']);
    expect([...query('getSensorValues').keys()]).toEqual(['selector']);
    expect([...query('getDeviceType').keys()]).toEqual(['slot']);
    expect([...query('getFirmwareVersion').keys()]).toEqual(['selector']);
  });

  it('test_fr14_2_defaults_controller_0_slot_1_selector_3_device_slot_0', () => {
    expect(buildOperationRequest('connect').path).toBe('/v1/controllers/0/connect');
    expect(buildOperationRequest('startTemperatureControl').path).toBe('/v1/controllers/0/slots/1/start');
    expect(buildOperationRequest('getActualTemperature').path).toBe('/v1/controllers/0/slots/1/temperature?selector=3');
    expect(buildOperationRequest('getDeviceType').path).toBe('/v1/controllers/0/device-type?slot=0');
  });

  it('test_fr14_2_check_at_target_omits_tolerance_when_undefined', () => {
    expect(buildOperationRequest('checkAtTarget', { controllerId: 1, slotId: 2 }).path).toBe(
      '/v1/controllers/1/slots/2/at-target',
    );
  });

  it('test_fr14_2_ids_selectors_and_temperatures_must_be_well_formed_numbers', () => {
    const bad: [InhecoTecOperation, OperationParameters, string][] = [
      ['connect', { controllerId: 1.5 }, 'controllerId'],
      ['connect', { controllerId: Number.NaN }, 'controllerId'],
      ['stopTemperatureControl', { slotId: Number.POSITIVE_INFINITY }, 'slotId'],
      ['setTargetTemperature', {}, 'temperatureC'],
      ['setTargetTemperature', { temperatureC: Number.NaN }, 'temperatureC'],
      ['getSensorValues', {}, 'selector'],
      ['getFirmwareVersion', { selector: 0.5 }, 'selector'],
      ['checkAtTarget', { tolerance: Number.NaN }, 'tolerance'],
      ['getDeviceType', { deviceSlot: 2.5 }, 'deviceSlot'],
    ];
    for (const [op, params, parameter] of bad) {
      let thrown: unknown;
      try {
        buildOperationRequest(op, params);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${op} ${parameter}`).toBeInstanceOf(OperationParameterError);
      expect((thrown as OperationParameterError).parameter).toBe(parameter);
    }
  });

  it('test_fr14_2_unknown_operation_is_rejected', () => {
    expect(isInhecoTecOperation('getStatus')).toBe(true);
    expect(isInhecoTecOperation('sendCommand')).toBe(false);
    expect(isInhecoTecOperation(42)).toBe(false);
    expect(() => buildOperationRequest('sendCommand' as InhecoTecOperation)).toThrow(OperationParameterError);
  });
});

describe('URL-encoding of path and query values (carry-forward T21-C3)', () => {
  it('test_t21_c3_injected_strings_never_reach_a_path', () => {
    // A string smuggled past the n8n number type is rejected, never joined raw into the path.
    const hostile = ['1/../../v1/stop-all', '0?x=1', '0#frag', '%2e%2e', '1 2'];
    for (const value of hostile) {
      const asNumber = value as unknown as number;
      expect(() => buildOperationRequest('connect', { controllerId: asNumber })).toThrow(OperationParameterError);
      expect(() => buildOperationRequest('stopTemperatureControl', { slotId: asNumber })).toThrow(
        OperationParameterError,
      );
      expect(() => buildOperationRequest('getSensorValues', { selector: asNumber })).toThrow(OperationParameterError);
      expect(() => buildOperationRequest('getDeviceType', { deviceSlot: asNumber })).toThrow(OperationParameterError);
      expect(() => buildOperationRequest('checkAtTarget', { tolerance: asNumber })).toThrow(OperationParameterError);
    }
  });

  it('test_t21_c3_every_path_has_only_safe_characters', () => {
    const samples: OperationParameters[] = [
      FULL,
      { ...FULL, controllerId: -1, slotId: -2, selector: -3, deviceSlot: -4, tolerance: -0.25 },
      { ...FULL, tolerance: 1e-7, temperatureC: -1e-7 },
    ];
    for (const params of samples) {
      for (const op of OPERATION_IDS) {
        const built = buildOperationRequest(op, params).path;
        expect(built, `${op}`).toMatch(/^\/v1\/[A-Za-z0-9/._-]*(\?[a-z_]+=[A-Za-z0-9.%-]+)?$/);
        // The query value decodes back to the number it encodes.
        const q = built.split('?')[1];
        if (q !== undefined) {
          const value = q.split('=')[1]!;
          expect(Number(decodeURIComponent(value))).not.toBeNaN();
        }
      }
    }
  });
});

describe('Emergency Off confirmation (FR-14.7)', () => {
  it('test_fr14_7_emergency_off_sends_confirm_false_by_default', () => {
    const request = buildOperationRequest('emergencyOff', { controllerId: 2 });
    expect(request).toEqual({ method: 'POST', path: '/v1/controllers/2/emergency-off', body: { confirm: false } });
    expect(buildOperationRequest('emergencyOff').body).toEqual({ confirm: false });
  });

  it('test_fr14_7_emergency_off_sends_the_confirm_value', () => {
    expect(buildOperationRequest('emergencyOff', { confirm: true }).body).toEqual({ confirm: true });
    expect(buildOperationRequest('emergencyOff', { confirm: false }).body).toEqual({ confirm: false });
  });

  it('test_fr14_7_emergency_off_rejects_a_non_boolean_confirm', () => {
    expect(() =>
      buildOperationRequest('emergencyOff', { confirm: 'true' as unknown as boolean }),
    ).toThrow(OperationParameterError);
  });
});

describe('no raw-command operation (FR-10.2)', () => {
  it('test_fr10_2_no_operation_accepts_a_raw_command_string', () => {
    for (const op of OPERATION_IDS) {
      const text = `${op} ${OPERATIONS[op].name} ${OPERATIONS[op].path}`.toLowerCase();
      expect(text, op).not.toMatch(/raw|command|send|firmware-command|passthrough/);
    }
    // OperationParameters has no string field: every parameter is a number or a boolean.
    const params = buildOperationRequest('setTargetTemperature', { temperatureC: 20 });
    expect(Object.keys(params.body as object)).toEqual(['temperature_c']);
  });

  it('test_fr10_2_bodies_are_fixed_shapes_and_ignore_extra_fields', () => {
    const extra = { ...FULL, command: '0AEO', raw: '1STT100' } as OperationParameters;
    for (const op of OPERATION_IDS) {
      const { body, path: builtPath } = buildOperationRequest(op, extra);
      expect(builtPath).not.toMatch(/AEO|STT|command|raw/);
      if (body !== undefined) {
        expect(Object.keys(body as object)).toEqual(op === 'emergencyOff' ? ['confirm'] : ['temperature_c']);
      }
    }
  });
});

describe('auth header per operation via the transport (FR-14.2, FR-14.8 acceptance)', () => {
  it.each(OPERATION_IDS)('test_fr14_2_auth_header_method_url_body_on_the_wire_%s', async (op) => {
    const { requestFn, calls } = fakeRequestFn();
    const request = buildOperationRequest(op, FULL);
    const result = await sendInhecoTecRequest(CREDS, request, { requestFn });
    expect(result).toEqual({});
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const headers = call.options.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOK}`);
    expect(call.options.method).toBe(EXPECTED[op].method);
    expect(call.url.protocol).toBe('https:');
    expect(`${call.url.pathname}${call.url.search}`).toBe(EXPECTED[op].path);
    if (EXPECTED[op].body === undefined) {
      expect(call.payload).toBeUndefined();
    } else {
      expect(JSON.parse(call.payload!)).toEqual(EXPECTED[op].body);
      expect(headers['Content-Type']).toBe('application/json');
    }
  });
});
