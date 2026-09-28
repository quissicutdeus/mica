// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { callOr } from '../nui/call';
import { shellContract } from '@mica/shared/contracts/shell';

/**
 * The origin this server's hosted photos are served from, or `null` (MICA-243).
 *
 * Read by the add-on sandbox and nothing else: a `core: false` frame's CSP lets `img-src`
 * reach this origin so an add-on handed a hosted photo can draw it
 * (`shell/addon/srcdoc.ts`). The core apps need nothing from it — they run in the shell's
 * own page, where `MediaThumb` draws an `https:` URL directly.
 *
 * `null` by default and on any doubt, so a missing answer leaves the sandbox exactly as
 * narrow as it was before image hosting existed.
 */
export const imageHostOrigin = writable<string | null>(null);

/** `https://<host>` and nothing else — no path, no port, no wildcard — or `null`. */
const ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * Ask the server. Checked here as well as there: this value is written into a CSP, and a
 * space or a `;` in it would add a source or a directive the server never meant to allow.
 */
export async function refreshImageHost(): Promise<void> {
  const res = await callOr(shellContract, 'imageHost', undefined, { origin: null });
  const origin = typeof res?.origin === 'string' ? res.origin.trim().toLowerCase() : '';
  imageHostOrigin.set(ORIGIN.test(origin) ? origin : null);
}
