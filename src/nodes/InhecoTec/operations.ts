/**
 * Operation table of the Inheco TEC node (design C15, FR-14.2, FR-10.2).
 *
 * Pure: maps one operation and its parameters to the API request `{method, path, body}` that
 * `sendInhecoTecRequest` sends. Nothing here opens a socket or imports n8n runtime code.
 *
 * - There is one operation per API capability and no operation that accepts a raw command
 *   string (FR-10.2): every body is a fixed, closed shape.
 * - Every user-supplied path segment and query value is URL-encoded before it reaches
 *   `buildApiRequest`, which joins the base URL and the path raw (carry-forward T21-C3/T21-S3).
 * - Range checks (controller 0-7, slot 1-6, selectors, limits) belong to the API; this module only
 *   rejects values that are not well-formed numbers, so no `NaN` or `1.5` reaches a path.
 */

import type { HttpMethod, InhecoTecRequest } from './transport';

/** The fifteen operations of FR-14.2, by n8n option value. */
export const OPERATION_IDS = [
  'getStatus',
  'connect',
  'setTargetTemperature',
  'startTemperatureControl',
  'stopTemperatureControl',
  'stopAll',
  'getActualTemperature',
  'getTargetTemperature',
  'checkAtTarget',
  'getSensorValues',
  'getDeviceType',
  'getFirmwareVersion',
  'releaseController',
  'reacquireController',
  'emergencyOff',
] as const;

export type InhecoTecOperation = (typeof OPERATION_IDS)[number];

/** The parameters an operation may read; each operation uses only its own subset. */
export interface OperationParameters {
  /** Controller ID, 0-7 (default 0). */
  controllerId?: number;
  /** Slot ID, 1-6 (default 1). */
  slotId?: number;
  /** Target temperature in degrees C (Set Target Temperature). */
  temperatureC?: number;
  /** Selector of Get Actual Temperature (default 3), Get Sensor Values or Get Firmware Version. */
  selector?: number;
  /** Optional at-target tolerance in degrees C (Check At Target); omitted when undefined. */
  tolerance?: number;
  /** Slot of Get Device Type, 0-6 where 0 is the controller (default 0). */
  deviceSlot?: number;
  /** Emergency Off confirmation, sent as the `confirm` body field (default `false`, FR-14.7). */
  confirm?: boolean;
}

/** One row of the operation table. */
export interface OperationDefinition {
  name: string;
  description: string;
  method: HttpMethod;
  /** Path template, for documentation and tests; `{cid}` / `{sid}` are filled by `build`. */
  path: string;
  build: (params: OperationParameters) => InhecoTecRequest;
}

export const DEFAULT_CONTROLLER_ID = 0;
export const DEFAULT_SLOT_ID = 1;
export const DEFAULT_ACTUAL_TEMPERATURE_SELECTOR = 3;
export const DEFAULT_DEVICE_SLOT = 0;

/** A parameter value is not a well-formed number (or boolean) for its operation. */
export class OperationParameterError extends Error {
  readonly parameter: string;

  constructor(parameter: string, message: string) {
    super(message);
    this.name = 'OperationParameterError';
    this.parameter = parameter;
  }
}

function integer(name: string, value: number | undefined, fallback?: number): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved)) {
    throw new OperationParameterError(name, `Parameter ${name} must be an integer`);
  }
  return resolved;
}

function finite(name: string, value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OperationParameterError(name, `Parameter ${name} must be a finite number`);
  }
  return value;
}

/** A URL-encoded path segment or query value (carry-forward T21-C3). */
function enc(value: number): string {
  return encodeURIComponent(String(value));
}

function controllerPath(params: OperationParameters): string {
  return `/v1/controllers/${enc(integer('controllerId', params.controllerId, DEFAULT_CONTROLLER_ID))}`;
}

function slotPath(params: OperationParameters): string {
  return `${controllerPath(params)}/slots/${enc(integer('slotId', params.slotId, DEFAULT_SLOT_ID))}`;
}

function row(
  name: string,
  description: string,
  method: HttpMethod,
  path: string,
  build: (params: OperationParameters) => InhecoTecRequest,
): OperationDefinition {
  return { name, description, method, path, build };
}

/** The C15 operation table, keyed by operation ID. */
export const OPERATIONS: Readonly<Record<InhecoTecOperation, OperationDefinition>> = {
  getStatus: row('Get Status', 'Status of every controller and slot', 'GET', '/v1/status', () => ({
    method: 'GET',
    path: '/v1/status',
  })),
  connect: row(
    'Connect',
    'Connect, reconnect after a loss, or re-initialize after Emergency Off',
    'POST',
    '/v1/controllers/{cid}/connect',
    (p) => ({ method: 'POST', path: `${controllerPath(p)}/connect` }),
  ),
  setTargetTemperature: row(
    'Set Target Temperature',
    'Set the target temperature of a slot; returns when the API responds',
    'PUT',
    '/v1/controllers/{cid}/slots/{sid}/target',
    (p) => ({
      method: 'PUT',
      path: `${slotPath(p)}/target`,
      body: { temperature_c: finite('temperatureC', p.temperatureC) },
    }),
  ),
  startTemperatureControl: row(
    'Start Temperature Control',
    'Switch temperature control of a slot on; returns when the API responds',
    'POST',
    '/v1/controllers/{cid}/slots/{sid}/start',
    (p) => ({ method: 'POST', path: `${slotPath(p)}/start` }),
  ),
  stopTemperatureControl: row(
    'Stop Temperature Control',
    'Switch temperature control of a slot off',
    'POST',
    '/v1/controllers/{cid}/slots/{sid}/stop',
    (p) => ({ method: 'POST', path: `${slotPath(p)}/stop` }),
  ),
  stopAll: row('Stop All', 'Switch temperature control of every configured slot off', 'POST', '/v1/stop-all', () => ({
    method: 'POST',
    path: '/v1/stop-all',
  })),
  getActualTemperature: row(
    'Get Actual Temperature',
    'Read the actual temperature of a slot',
    'GET',
    '/v1/controllers/{cid}/slots/{sid}/temperature?selector=',
    (p) => ({
      method: 'GET',
      path: `${slotPath(p)}/temperature?selector=${enc(
        integer('selector', p.selector, DEFAULT_ACTUAL_TEMPERATURE_SELECTOR),
      )}`,
    }),
  ),
  getTargetTemperature: row(
    'Get Target Temperature',
    'Read the target temperature of a slot',
    'GET',
    '/v1/controllers/{cid}/slots/{sid}/target',
    (p) => ({ method: 'GET', path: `${slotPath(p)}/target` }),
  ),
  checkAtTarget: row(
    'Check At Target',
    'One instantaneous check whether a slot is at its target temperature',
    'GET',
    '/v1/controllers/{cid}/slots/{sid}/at-target[?tolerance_c=]',
    (p) => ({
      method: 'GET',
      path:
        p.tolerance === undefined
          ? `${slotPath(p)}/at-target`
          : `${slotPath(p)}/at-target?tolerance_c=${enc(finite('tolerance', p.tolerance))}`,
    }),
  ),
  getSensorValues: row(
    'Get Sensor Values',
    'Read controller sensor values',
    'GET',
    '/v1/controllers/{cid}/sensor-values?selector=',
    (p) => ({
      method: 'GET',
      path: `${controllerPath(p)}/sensor-values?selector=${enc(integer('selector', p.selector))}`,
    }),
  ),
  getDeviceType: row(
    'Get Device Type',
    'Read the device type of the controller (slot 0) or of a slot',
    'GET',
    '/v1/controllers/{cid}/device-type?slot=',
    (p) => ({
      method: 'GET',
      path: `${controllerPath(p)}/device-type?slot=${enc(integer('deviceSlot', p.deviceSlot, DEFAULT_DEVICE_SLOT))}`,
    }),
  ),
  getFirmwareVersion: row(
    'Get Firmware Version',
    'Read the controller firmware version',
    'GET',
    '/v1/controllers/{cid}/firmware-version?selector=',
    (p) => ({
      method: 'GET',
      path: `${controllerPath(p)}/firmware-version?selector=${enc(integer('selector', p.selector))}`,
    }),
  ),
  releaseController: row(
    'Release Controller',
    'Release the controller so that another program (VENUS) can use it',
    'POST',
    '/v1/controllers/{cid}/release',
    (p) => ({ method: 'POST', path: `${controllerPath(p)}/release` }),
  ),
  reacquireController: row(
    'Reacquire Controller',
    'Reacquire a released controller',
    'POST',
    '/v1/controllers/{cid}/reacquire',
    (p) => ({ method: 'POST', path: `${controllerPath(p)}/reacquire` }),
  ),
  emergencyOff: row(
    'Emergency Off',
    'Switch off all slot power outputs of the controller',
    'POST',
    '/v1/controllers/{cid}/emergency-off',
    (p) => {
      if (p.confirm !== undefined && typeof p.confirm !== 'boolean') {
        throw new OperationParameterError('confirm', 'Parameter confirm must be a boolean');
      }
      // Default false: the API refuses anything but `true` (FR-14.7, FR-17.2).
      return { method: 'POST', path: `${controllerPath(p)}/emergency-off`, body: { confirm: p.confirm ?? false } };
    },
  ),
};

export function isInhecoTecOperation(value: unknown): value is InhecoTecOperation {
  return typeof value === 'string' && (OPERATION_IDS as readonly string[]).includes(value);
}

/** The API request for `operation` with `params` (design C15 table). */
export function buildOperationRequest(operation: InhecoTecOperation, params: OperationParameters = {}): InhecoTecRequest {
  if (!isInhecoTecOperation(operation)) {
    throw new OperationParameterError('operation', 'Unknown Inheco TEC operation');
  }
  return OPERATIONS[operation].build(params);
}
