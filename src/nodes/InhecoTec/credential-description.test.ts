/**
 * Suite for the `inhecoTecApi` n8n credential (Task 21, FR-14.1, DD-8).
 *
 * Planned path: `src/credentials/InhecoTecApi.credentials.test.ts`. The tester's harness denies
 * writes under any `credentials/` directory (a secret-store guard), so the suite lives next to the
 * transport instead; it imports the credential module unchanged.
 *
 * Pure and offline: the credential is a static description plus a base-URL guard, so nothing
 * here opens a socket. Test values are short placeholders, never real credentials.
 */
import { describe, expect, it } from 'vitest';

import {
  assertHttpsBaseUrl,
  INHECO_TEC_CREDENTIAL_NAME,
  InhecoTecApi,
} from '../../credentials/InhecoTecApi.credentials';

const credential = new InhecoTecApi();

function property(name: string) {
  const found = credential.properties.find((p) => p.name === name);
  if (found === undefined) throw new Error(`credential property ${name} is missing`);
  return found;
}

describe('InhecoTecApi credential description (FR-14.1)', () => {
  it('test_fr14_1_credential_name_is_inhecoTecApi', () => {
    expect(credential.name).toBe('inhecoTecApi');
    expect(INHECO_TEC_CREDENTIAL_NAME).toBe(credential.name);
    expect(credential.displayName).toBeTruthy();
  });

  it('test_fr14_1_token_is_a_required_password_field', () => {
    const tokenField = property('token'); // pragma: allowlist secret (field name, not a value)
    expect(tokenField.type).toBe('string');
    expect(tokenField.typeOptions?.password).toBe(true);
    expect(tokenField.required).toBe(true);
  });

  it('test_fr14_1_base_url_is_a_required_string_field', () => {
    const baseUrl = property('baseUrl');
    expect(baseUrl.type).toBe('string');
    expect(baseUrl.required).toBe(true);
  });

  it('test_dd8_ca_certificate_is_an_optional_multiline_field', () => {
    const ca = property('caCertificate');
    expect(ca.type).toBe('string');
    expect(ca.required).not.toBe(true);
    expect(ca.typeOptions?.rows ?? 0).toBeGreaterThan(1);
  });

  it('test_dd8_has_exactly_the_three_documented_options', () => {
    expect(credential.properties.map((p) => p.name).sort()).toEqual(['baseUrl', 'caCertificate', 'token']);
  });

  it('test_dd8_no_option_disables_certificate_verification', () => {
    for (const p of credential.properties) {
      expect(p.type).not.toBe('boolean');
      expect(`${p.name} ${p.displayName}`).not.toMatch(
        /reject|unauthori[sz]ed|insecure|verif|ignore|skip|allow.*cert|ssl|tls/i,
      );
    }
    expect(JSON.stringify(credential)).not.toMatch(/rejectUnauthorized|allowUnauthorizedCerts/i);
  });
});

describe('assertHttpsBaseUrl (FR-1.3, FR-14.1)', () => {
  it.each(['https://tec.example:8743', 'https://tec.example:8743/', 'https://203.0.113.5:8743'])(
    'test_fr14_1_accepts_https_url %s',
    (url) => {
      expect(() => assertHttpsBaseUrl(url)).not.toThrow();
    },
  );

  it.each([
    'http://tec.example:8743',
    'ftp://tec.example',
    'ws://tec.example:8743',
    'tec.example:8743',
    '//tec.example:8743',
    'https//tec.example',
    '',
    '   ',
    'not a url',
  ])('test_fr14_1_rejects_non_https_base_url %j', (url) => {
    expect(() => assertHttpsBaseUrl(url)).toThrow(Error);
  });

  it('test_fr14_1_rejection_message_does_not_echo_the_value', () => {
    const value = 'http://user-pw-xyz@tec.example:8743';
    let caught: unknown;
    try {
      assertHttpsBaseUrl(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(value);
    expect((caught as Error).message).not.toContain('user-pw-xyz');
  });
});
