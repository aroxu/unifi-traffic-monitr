import {UnifiHttpError} from '@utm/unifi';

// Socket and TLS failures reach us as fetch TypeErrors whose cause carries a code.
const causeCodes: Record<string, string> = {
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls_hostname_mismatch',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_untrusted_certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls_untrusted_certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_untrusted_certificate',
  UNABLE_TO_GET_ISSUER_CERT: 'tls_untrusted_certificate',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls_untrusted_certificate',
  CERT_HAS_EXPIRED: 'tls_certificate_expired',
  CERT_NOT_YET_VALID: 'tls_certificate_not_yet_valid',
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_reset',
  ENOTFOUND: 'dns_lookup_failed',
  EAI_AGAIN: 'dns_lookup_failed',
  EHOSTUNREACH: 'host_unreachable',
  ENETUNREACH: 'host_unreachable',
  ETIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
};

/** Error code shown on the status page for a failed UniFi request or response. */
export function classifyUnifiError(error: unknown): string {
  if (error instanceof UnifiHttpError) return `http_${error.status}`;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code && causeCodes[code]) return causeCodes[code];
    current = (current as Error & {cause?: unknown}).cause;
  }
  return 'fetch_validation_or_database_error';
}

/** A cycle failure whose code was already recorded in collector_runs. */
export class RecordedCycleError extends Error {
  constructor(readonly code: string, cause: unknown) {
    super(code, {cause});
  }
}
