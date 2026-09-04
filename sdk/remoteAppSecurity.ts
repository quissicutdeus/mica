// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Trust boundary for remote (Store-installed) micaOS add-ons.
 *
 * This module decides two questions, both answered *before* a bundle is booted: is it
 * coming from somewhere the operator chose to trust, and is it the exact bytes the
 * operator published (the shell hash-verifies the fetched text against the catalog entry
 * before handing it to `bootAddOn`). Since `MICA-16` Step 4, the bundle it clears also
 * runs in a sandboxed `<iframe sandbox="allow-scripts" srcdoc>` — opaque origin, no shell
 * DOM or NUI — so a host/hash match is no longer the only thing standing between a
 * fetched bundle and the shell; `sdk/permissions.ts` is what still gates each
 * individual host call once the frame is running.
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
 *
 * That means this predicate is only safe to hand untrusted external input (an NUI message,
 * for instance) if the caller applies its own `data:` rejection first — see
 * `nuiMessages.ts`'s `installApp` handler. This function does not do it for you.
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
