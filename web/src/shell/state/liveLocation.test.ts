// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { applyLiveShare, liveLocationSharing } from './liveLocation';
import { deliverAppEvent } from './appEvents';

describe('liveLocationSharing (MICA-244)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    applyLiveShare({ active: false });
    vi.useRealTimers();
  });

  it('follows the server’s places:live_share push', () => {
    deliverAppEvent({
      app: 'places',
      event: 'live_share',
      payload: { active: true, expires_at: Date.now() + 60_000 },
      at: Date.now()
    });
    expect(get(liveLocationSharing)).toBe(true);

    deliverAppEvent({ app: 'places', event: 'live_share', payload: { active: false }, at: 0 });
    expect(get(liveLocationSharing)).toBe(false);
  });

  it('clears itself at the expiry even if no end push arrives', () => {
    applyLiveShare({ active: true, expires_at: Date.now() + 1_000 });
    expect(get(liveLocationSharing)).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(get(liveLocationSharing)).toBe(false);
  });

  it('ignores a malformed or already-expired payload', () => {
    applyLiveShare({ active: true });
    expect(get(liveLocationSharing)).toBe(false);
    applyLiveShare({ active: true, expires_at: Date.now() - 1 });
    expect(get(liveLocationSharing)).toBe(false);
    applyLiveShare('nonsense');
    expect(get(liveLocationSharing)).toBe(false);
  });
});
