/**
 * Trust boundary for remote (dynamically loaded) gPhone apps.
 *
 * Nothing here makes a remote app's *code* safe once it runs — see
 * `web/src/sdk/capability.ts`, which is explicit that permissions are a disclosure, not a
 * sandbox: every app shares the shell's own JS context. This module only decides two
 * narrower questions, both answered *before* a single line of fetched code executes: is
 * the bundle coming from somewhere the operator chose to trust, and is it the exact bytes
 * the operator published.
 */

/**
 * Hosts a remote app bundle may be fetched from. Empty by default — nothing installs from
 * anywhere until an operator explicitly trusts their own catalog host.
 */
let trustedHosts: string[] = [];

/** Configure the allowlist. Call this once, e.g. from the phone's own bootstrap. */
export function setTrustedRemoteAppHosts(hosts: string[]): void {
  trustedHosts = hosts.map((h) => h.toLowerCase());
}

export function getTrustedRemoteAppHosts(): readonly string[] {
  return trustedHosts;
}

/**
 * HTTPS, and a hostname on the operator's allowlist.
 *
 * `data:` URLs are exempt: they carry no host to check, because the code is already
 * embedded in the string rather than fetched over the network. What makes a `data:`-sourced
 * install safe is that nothing produces one from untrusted input — `installFromCatalog`
 * only ever builds one internally, from bytes it has already hash-verified.
 */
export function isTrustedRemoteUrl(url: string): boolean {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('data:')) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  return trustedHosts.includes(parsed.hostname.toLowerCase());
}

/** Lowercase hex SHA-256 of `text`, via the Web Crypto API every NUI-hosting browser ships. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Whether `text` hashes to `expectedSha256` (case-insensitive hex compare). */
export async function matchesHash(text: string, expectedSha256: string): Promise<boolean> {
  if (typeof expectedSha256 !== 'string' || !expectedSha256) return false;
  const actual = await sha256Hex(text);
  return actual === expectedSha256.toLowerCase();
}
