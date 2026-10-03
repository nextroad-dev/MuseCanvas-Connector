import type { NormalizedProviderErrorDiagnostic, ProviderErrorCode } from './host-types'

/*
 * NormalizedProviderError-compatible failures without importing the host class.
 *
 * An uploaded bundle cannot import `NormalizedProviderError` (zero runtime imports),
 * so `instanceof` never matches on the host side. The worker's `classifySubmitError`
 * handles exactly this shape: an Error whose `message` is the bare code and which
 * carries a `diagnostic` object. Keep `message === code` (the worker compares it
 * strictly) and only use codes from the kernel union.
 *
 * `sanitizeProviderDetail` mirrors packages/providers/src/core/errors.ts; the kernel
 * sanitizes too, but vendor text must never reach `detail` unsanitized.
 */

export type ProviderError = Error & { diagnostic: NormalizedProviderErrorDiagnostic }

export function sanitizeProviderDetail(value: string): string {
  if (!value) return ''
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 1200)
}

export function diagnostic(
  pluginId: string,
  version: string,
  code: ProviderErrorCode,
  detail: string,
  extra: Partial<NormalizedProviderErrorDiagnostic> = {},
): NormalizedProviderErrorDiagnostic {
  return {
    pluginId,
    version,
    code,
    detail: sanitizeProviderDetail(detail),
    occurredAt: new Date().toISOString(),
    ...extra,
  }
}

export function providerError(
  pluginId: string,
  version: string,
  code: ProviderErrorCode,
  detail: string,
  extra: Partial<NormalizedProviderErrorDiagnostic> = {},
): ProviderError {
  const error = new Error(code) as ProviderError
  error.name = 'NormalizedProviderError'
  error.diagnostic = diagnostic(pluginId, version, code, detail, extra)
  return error
}

/** Same classification as NormalizedProviderError.fromHttp: 429/5xx temporary, other 4xx rejected. */
export function diagnosticFromHttp(
  pluginId: string,
  version: string,
  response: { status: number; statusText: string; headers: Headers; url: string },
  bodyText: string,
): NormalizedProviderErrorDiagnostic {
  let endpoint = ''
  try {
    endpoint = new URL(response.url).pathname
  } catch {
    endpoint = response.url
  }
  const code: ProviderErrorCode = response.status === 429 || response.status >= 500 ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED'
  return diagnostic(pluginId, version, code, bodyText, {
    status: response.status,
    statusText: response.statusText,
    endpoint,
    providerReferenceId: response.headers.get('x-request-id') || undefined,
  })
}
