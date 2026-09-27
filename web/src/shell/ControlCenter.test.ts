// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import ControlCenter from './ControlCenter.svelte';
import {
  closeControlCenter,
  openControlCenter,
  registerContributedToggle,
  resetControlCenterLayout
} from './state/controlCenter';
import { appRegistryStore } from './state/registry';

// jsdom has no Web Animations API and this sheet's `transition:fly` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const toggle = (id: string, over: Partial<{ active: boolean; onToggle: () => void }> = {}) => ({
  id,
  label: 'Airplane', // deliberately the same label a built-in already uses
  icon: 'airplane', // and the same icon name — see the spoofing test below
  active: false,
  onToggle: () => {},
  ...over
});

beforeEach(() => {
  resetControlCenterLayout();
  closeControlCenter();
});

describe('ControlCenter', () => {
  it('renders nothing at all while closed', () => {
    const { container } = render(ControlCenter);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  /**
   * MICA-247 review: a headerless first section reads as "the one true system section",
   * which gives a spoofed add-on section something to imitate by omission. The built-ins
   * now carry the same kind of header every add-on section does.
   */
  it('heads the built-ins with their own section label', () => {
    openControlCenter();
    const { getByTestId } = render(ControlCenter);
    expect(getByTestId('control-center-section-__builtin__').textContent?.trim()).toBe('Controls');
  });

  it("heads a contributed section with the owning app's registered name", () => {
    const appName = get(appRegistryStore).find((a) => a.id === 'contacts')?.name;
    expect(
      appName,
      'contacts must be a registered core app for this test to mean anything'
    ).toBeTruthy();

    const off = registerContributedToggle('contacts', toggle('lights'));
    openControlCenter();
    const { getByTestId } = render(ControlCenter);
    expect(getByTestId('control-center-section-contacts').textContent?.trim()).toBe(appName);
    off();
  });

  /**
   * The core of the review finding: an add-on can give its toggle any `label` and
   * `icon` it likes — including a built-in's, as this fixture does on purpose — and
   * still cannot make the accessible name lie about which app it belongs to.
   */
  it('names a spoofed-looking contributed toggle by its owning app, not by its claimed label', () => {
    const appName = get(appRegistryStore).find((a) => a.id === 'contacts')?.name;
    const off = registerContributedToggle('contacts', toggle('fake-airplane'));
    openControlCenter();
    const { getByTestId } = render(ControlCenter);
    // The add-on's own chosen label survives, but the app is named alongside it.
    expect(getByTestId('cc-toggle-contacts:fake-airplane').getAttribute('aria-label')).toBe(
      `Airplane, from ${appName}`
    );
    // The real built-in keeps its plain, unqualified name.
    expect(getByTestId('cc-toggle-airplane').getAttribute('aria-label')).toBe('Airplane');
    off();
  });

  afterEach(() => {
    closeControlCenter();
  });
});
