/**
 * The `inhecoTecApi` n8n credential (design C15, FR-14.1, FR-1.3).
 *
 * It holds the HTTPS base URL of the Inheco TEC API, the bearer token (an n8n password field), and
 * an optional CA certificate (public PEM) that verifies the API's TLS certificate. No option turns
 * off certificate verification. The node sends requests itself over `node:https` (DD-8), so this
 * credential declares no `authenticate` or `test` block that would route through the n8n request
 * helpers without the per-credential CA.
 */

import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/** The credential type name the node references. */
export const INHECO_TEC_CREDENTIAL_NAME = 'inhecoTecApi';

/** The values the credential stores, as the transport reads them. */
export interface InhecoTecCredentialData {
  baseUrl: string;
  token: string;
  caCertificate?: string;
}

/**
 * Fail unless `baseUrl` is an absolute `https://` URL (FR-1.3: the API is reached over HTTPS only).
 *
 * The error message never echoes the value: a mistyped credential field could hold the token.
 */
export function assertHttpsBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error('Inheco TEC API base URL is not a valid URL; it must start with https://');
  }
  if (parsed.protocol !== 'https:' || !baseUrl.trim().toLowerCase().startsWith('https://')) {
    throw new Error('Inheco TEC API base URL must start with https://');
  }
}

export class InhecoTecApi implements ICredentialType {
  name = INHECO_TEC_CREDENTIAL_NAME;

  displayName = 'Inheco TEC API';

  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://<host>:8743',
      description:
        'HTTPS base URL of the Inheco TEC API. It must start with https://; plain HTTP is rejected.',
    },
    {
      displayName: 'Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Bearer token of the Inheco TEC API, sent in the bearer Authorization header',
    },
    {
      displayName: 'CA Certificate',
      name: 'caCertificate',
      type: 'string',
      typeOptions: { rows: 6 },
      default: '',
      placeholder: '-----BEGIN CERTIFICATE-----',
      description:
        'Optional PEM of the CA that issued the API certificate (public data). When empty, the system trust store verifies the certificate. Certificate verification is always on.',
    },
  ];
}
