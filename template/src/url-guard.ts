/*
 * Verbatim copy of `hostMatchesAllowlist` from MuseCanvas
 * packages/providers/src/core/url-guard.ts (c6616dd).
 *
 * The spec requires plugins to use this exact grammar instead of hand-written
 * `endsWith` checks; an uploaded bundle cannot import it, so it is inlined here.
 */
export function hostMatchesAllowlist(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some(pattern => {
    const p = pattern.toLowerCase().trim()
    if (!p) return false
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)
      return host.endsWith(suffix) && host.length > suffix.length
    }
    if (p.startsWith('*-')) {
      const suffix = p.slice(1)
      if (!host.endsWith(suffix) || host.length <= suffix.length) return false
      return !host.slice(0, host.length - suffix.length).includes('.')
    }
    return host === p
  })
}
