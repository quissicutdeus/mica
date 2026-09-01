// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isTrustedNuiSource } from './nuiGuard';

/**
 * Critical 1 fix, MICA-16 step 4: without this check `Shell.svelte`'s NUI listener
 * routed any `{ action, data }` message regardless of where it came from, so a
 * sandboxed add-on could reach `installApp`/`uninstallApp`/`openApp`/`notify` — every
 * permission `IframeHostServer` enforces, bypassed by simply not going through it.
 */
describe('isTrustedNuiSource', () => {
  it('trusts a null source — real CEF delivers SendNUIMessage this way', () => {
    expect(isTrustedNuiSource({ source: null } as unknown as MessageEvent)).toBe(true);
  });

  it('trusts an undefined source', () => {
    expect(isTrustedNuiSource({ source: undefined } as unknown as MessageEvent)).toBe(true);
  });

  it('trusts window itself — how the dev harness posts its fixtures', () => {
    expect(isTrustedNuiSource({ source: window } as unknown as MessageEvent)).toBe(true);
  });

  it('trusts window.top — how real CEF actually delivers SendNUIMessage', () => {
    expect(isTrustedNuiSource({ source: window.top } as unknown as MessageEvent)).toBe(true);
  });

  it("refuses any other source, such as an iframe's contentWindow", () => {
    expect(isTrustedNuiSource({ source: {} } as unknown as MessageEvent)).toBe(false);
  });
});
