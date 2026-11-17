/**
 * n8n node for the Inheco TEC Control instrument API (design C15, FR-14).
 *
 * One resource ("Controller") with the fifteen operations of FR-14.2. Each operation sends one
 * HTTPS request (`transport.ts`) and returns the API response as soon as it arrives; the node has
 * no polling or temperature loop of its own (FR-14.3). A workflow that must reach a temperature
 * uses the README poll pattern (Check At Target in an n8n loop).
 *
 * The node reaches the API only over HTTPS and imports no code from `api/` (FR-1.3). API and
 * transport errors are mapped by `errors.ts` to a `NodeOperationError` built from body fields only,
 * with the token redacted as a second guard (FR-14.5, FR-14.8).
 */

import {
  NodeConnectionTypes,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeProperties,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';

import {
  INHECO_TEC_CREDENTIAL_NAME,
  type InhecoTecCredentialData,
} from '../../credentials/InhecoTecApi.credentials';
import { toNodeOperationError } from './errors';
import {
  buildOperationRequest,
  DEFAULT_ACTUAL_TEMPERATURE_SELECTOR,
  DEFAULT_CONTROLLER_ID,
  DEFAULT_DEVICE_SLOT,
  DEFAULT_SLOT_ID,
  isInhecoTecOperation,
  OPERATION_IDS,
  OPERATIONS,
  OperationParameterError,
  type InhecoTecOperation,
  type OperationParameters,
} from './operations';
import { DEFAULT_REQUEST_TIMEOUT_MS, sendInhecoTecRequest, type TransportOptions } from './transport';

/** Largest timer delay Node.js accepts (2^31 - 1 ms); `transport.ts` does not clamp (T21-C1). */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Operations that name a controller. */
const CONTROLLER_OPERATIONS: InhecoTecOperation[] = OPERATION_IDS.filter(
  (op) => op !== 'getStatus' && op !== 'stopAll',
);

/** Operations that name a slot (1-6). */
const SLOT_OPERATIONS: InhecoTecOperation[] = [
  'setTargetTemperature',
  'startTemperatureControl',
  'stopTemperatureControl',
  'getActualTemperature',
  'getTargetTemperature',
  'checkAtTarget',
];

export const EMERGENCY_OFF_CONFIRM_DESCRIPTION =
  'Must be true to send Emergency Off. Emergency Off switches off all slot power outputs of the ' +
  'controller. Normal operation then needs Connect (re-initialize) or Reacquire Controller.';

function shownFor(operations: InhecoTecOperation[]): INodeProperties['displayOptions'] {
  return { show: { resource: ['controller'], operation: operations } };
}

function selectorProperty(
  operation: InhecoTecOperation,
  defaultValue: number,
  minValue: number,
  maxValue: number,
  description: string,
): INodeProperties {
  return {
    displayName: 'Selector',
    name: 'selector',
    type: 'number',
    default: defaultValue,
    typeOptions: { minValue, maxValue, numberPrecision: 0 },
    displayOptions: shownFor([operation]),
    description,
  };
}

const properties: INodeProperties[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    noDataExpression: true,
    options: [{ name: 'Controller', value: 'controller' }],
    default: 'controller',
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['controller'] } },
    options: OPERATION_IDS.map((op) => ({
      name: OPERATIONS[op].name,
      value: op,
      description: OPERATIONS[op].description,
      action: OPERATIONS[op].name,
    })),
    default: 'getStatus',
  },
  {
    displayName: 'Controller ID',
    name: 'controllerId',
    type: 'number',
    default: DEFAULT_CONTROLLER_ID,
    typeOptions: { minValue: 0, maxValue: 7, numberPrecision: 0 },
    displayOptions: shownFor(CONTROLLER_OPERATIONS),
    description: 'Controller ID, 0-7',
  },
  {
    displayName: 'Slot ID',
    name: 'slotId',
    type: 'number',
    default: DEFAULT_SLOT_ID,
    typeOptions: { minValue: 1, maxValue: 6, numberPrecision: 0 },
    displayOptions: shownFor(SLOT_OPERATIONS),
    description: 'Slot ID, 1-6',
  },
  {
    displayName: 'Temperature (°C)',
    name: 'temperatureC',
    type: 'number',
    required: true,
    default: 20,
    typeOptions: { numberPrecision: 1 },
    displayOptions: shownFor(['setTargetTemperature']),
    description: "Target temperature in °C; the API refuses a value outside the slot's limits",
  },
  selectorProperty('getActualTemperature', DEFAULT_ACTUAL_TEMPERATURE_SELECTOR, 1, 3, 'Actual temperature selector, 1-3'),
  selectorProperty('getSensorValues', 0, 0, 8, 'Sensor value selector, 0-8'),
  selectorProperty('getFirmwareVersion', 0, 0, 4, 'Firmware version selector, 0-4'),
  {
    displayName: 'Tolerance (°C)',
    name: 'tolerance',
    type: 'number',
    default: 0,
    typeOptions: { minValue: 0, maxValue: 5, numberPrecision: 1 },
    displayOptions: shownFor(['checkAtTarget']),
    description: "Optional tolerance in °C (0.1-5.0). 0 uses the slot's configured tolerance.",
  },
  {
    displayName: 'Slot',
    name: 'deviceSlot',
    type: 'number',
    default: DEFAULT_DEVICE_SLOT,
    typeOptions: { minValue: 0, maxValue: 6, numberPrecision: 0 },
    displayOptions: shownFor(['getDeviceType']),
    description: 'Slot whose device type is read, 0-6 (0 = the controller itself)',
  },
  {
    displayName: 'Confirm',
    name: 'confirm',
    type: 'boolean',
    required: true,
    default: false,
    displayOptions: shownFor(['emergencyOff']),
    description: EMERGENCY_OFF_CONFIRM_DESCRIPTION,
  },
  {
    displayName: 'Timeout (ms)',
    name: 'timeoutMs',
    type: 'number',
    default: DEFAULT_REQUEST_TIMEOUT_MS,
    typeOptions: { minValue: 1, maxValue: MAX_TIMEOUT_MS, numberPrecision: 0 },
    displayOptions: { show: { resource: ['controller'] } },
    description: 'Deadline of one API request in milliseconds',
  },
];

/** Read one operation's parameters for item `itemIndex`. */
function readParameters(
  context: IExecuteFunctions,
  operation: InhecoTecOperation,
  itemIndex: number,
): OperationParameters {
  const number = (name: string, fallback: number): number =>
    context.getNodeParameter(name, itemIndex, fallback) as number;
  const params: OperationParameters = {};
  if (CONTROLLER_OPERATIONS.includes(operation)) params.controllerId = number('controllerId', DEFAULT_CONTROLLER_ID);
  if (SLOT_OPERATIONS.includes(operation)) params.slotId = number('slotId', DEFAULT_SLOT_ID);
  switch (operation) {
    case 'setTargetTemperature':
      params.temperatureC = context.getNodeParameter('temperatureC', itemIndex) as number;
      break;
    case 'getActualTemperature':
      params.selector = number('selector', DEFAULT_ACTUAL_TEMPERATURE_SELECTOR);
      break;
    case 'getSensorValues':
    case 'getFirmwareVersion':
      params.selector = number('selector', 0);
      break;
    case 'checkAtTarget': {
      const tolerance = number('tolerance', 0);
      // 0 (the default) means "not set": the API then uses the slot's configured tolerance.
      if (tolerance !== 0) params.tolerance = tolerance;
      break;
    }
    case 'getDeviceType':
      params.deviceSlot = number('deviceSlot', DEFAULT_DEVICE_SLOT);
      break;
    case 'emergencyOff':
      params.confirm = context.getNodeParameter('confirm', itemIndex, false) as boolean;
      break;
    default:
      break;
  }
  return params;
}

/** The output item of one API response. */
function toJson(response: unknown): IDataObject {
  return response !== null && typeof response === 'object' && !Array.isArray(response)
    ? (response as IDataObject)
    : { result: response as IDataObject[keyof IDataObject] };
}

export class InhecoTec implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Inheco TEC',
    name: 'inhecoTec',
    icon: 'file:inhecoTec.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Control Inheco TEC temperature controllers through the Inheco TEC API',
    defaults: { name: 'Inheco TEC' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: INHECO_TEC_CREDENTIAL_NAME, required: true }],
    properties,
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = (await this.getCredentials(INHECO_TEC_CREDENTIAL_NAME)) as unknown as InhecoTecCredentialData;
    const secrets = [credentials.token];
    const output: INodeExecutionData[] = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const operation = this.getNodeParameter('operation', itemIndex) as string;
        if (!isInhecoTecOperation(operation)) {
          throw new OperationParameterError('operation', 'Unknown Inheco TEC operation');
        }
        const request = buildOperationRequest(operation, readParameters(this, operation, itemIndex));
        const options: TransportOptions = {
          timeoutMs: this.getNodeParameter('timeoutMs', itemIndex, DEFAULT_REQUEST_TIMEOUT_MS) as number,
        };
        // One request per item; the result is returned as soon as the API responds (FR-14.3).
        const response = await sendInhecoTecRequest(credentials, request, options);
        output.push({ json: toJson(response), pairedItem: { item: itemIndex } });
      } catch (error) {
        const nodeError = toNodeOperationError(this.getNode(), error, itemIndex, secrets);
        if (this.continueOnFail()) {
          output.push({ json: { error: nodeError.message }, pairedItem: { item: itemIndex } });
          continue;
        }
        throw nodeError;
      }
    }
    return [output];
  }
}
