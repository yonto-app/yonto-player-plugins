export const Code = {
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  CONTRACT_VERSION: 'CONTRACT_VERSION',
  MISSING_EXPORT: 'MISSING_EXPORT',
  BUILD_FAILED: 'BUILD_FAILED',
  CONFIG_MISSING: 'CONFIG_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
  METHOD_THREW: 'METHOD_THREW',
  RESULT_INVALID: 'RESULT_INVALID',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',
  REQUEST_FAILED: 'REQUEST_FAILED',
  REQUEST_INVALID: 'REQUEST_INVALID',
  REDIRECT_REFUSED: 'REDIRECT_REFUSED',
  STORE_REFUSED: 'STORE_REFUSED',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  EMPTY_RESULT: 'EMPTY_RESULT',
  TIMEOUT: 'TIMEOUT',
  NO_FIXTURE: 'NO_FIXTURE',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  UNAVAILABLE: 'UNAVAILABLE',
  MISCONFIGURED: 'MISCONFIGURED',
  UNREACHABLE: 'UNREACHABLE',
  CHALLENGED: 'CHALLENGED',
};

/**
 * A host function's refusal in a sentence written for the plugin, the one message besides a
 * `PluginError`'s that the engine passes through (`HostRefusal` on the device). Anything else a
 * host function throws reaches the plugin as a sentence of the engine's, never in Node's words.
 */
export class HostRefusal extends Error {}

export class PluginError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
    this.detail = detail;
  }
}
