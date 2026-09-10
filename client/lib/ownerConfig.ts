// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client's read of the owner's disabled-app list (MICA-234).
 *
 * **UX, not authority.** The server refuses a disabled app's events whatever this says, and
 * the shell hides its tile from `shell:ownerConfig`; this only stops a client-side path that
 * names an app -- the `OpenApp` export, the server's `openApp` push -- from raising the device
 * onto a screen the shell will not show. A modified client that skips it reaches nothing the
 * server would not refuse anyway.
 *
 * A client sees the convar only when the owner sets it with `setr`; a plain `set` never leaves
 * the server, and `GetConvar` then answers the fallback. `''` parses to nothing disabled,
 * which is the right answer here rather than a gap: the shell and the server still refuse.
 * The same holds when there is no `GetConvar` at all, or it throws.
 *
 * Read on every call rather than cached. Both callers are rare -- an export another resource
 * invokes, a push the server sends -- so the native costs nothing that matters, and a `setr`
 * from the live console applies on the next call instead of the next resource start.
 *
 * The name is a literal at the call site: `server/__tests__/convars.test.ts` scans `client/`
 * for it and cannot resolve one imported from `shared/ownerConfig.ts`.
 */
import { parseDisabledApps } from '@mica/shared/ownerConfig';
import { parseDeepLink } from '@mica/shared/deepLink';

const disabledApps = (): string[] => {
  if (typeof GetConvar !== 'function') return [];
  try {
    // Rejected entries are not reported here: the server parses the same value and names
    // them once at start, and a client warning would repeat on every open.
    return parseDisabledApps(GetConvar('mica_disabled_apps', '')).value;
  } catch {
    return [];
  }
};

/**
 * Whether the owner has disabled the app a destination names. Takes a bare id or the
 * `app?key=value` deep-link shape, since the `openApp` push documents both; a destination
 * that is not an app at all is not this function's to refuse, and answers `false`.
 */
export const isAppDisabled = (destination: string): boolean => {
  const app = parseDeepLink(destination)?.app;
  return app !== undefined && disabledApps().includes(app);
};
