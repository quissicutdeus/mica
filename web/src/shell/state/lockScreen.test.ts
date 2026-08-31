// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  isLocked,
  autoLockPolicy,
  evaluateLockOnOpen,
  noteLockScreenClosed,
  unlock,
  AUTO_LOCK_TIMEOUT_MS
} from './lockScreen';
import { hasPasscode } from '../../services/passcode';

describe('lock screen display state (MICA-60)', () => {
  beforeEach(() => {
    isLocked.set(false);
    hasPasscode.set(false);
    autoLockPolicy.set('onClose');
  });

  it('never locks when no passcode is set, regardless of policy', () => {
    autoLockPolicy.set('onClose');
    evaluateLockOnOpen();
    expect(get(isLocked)).toBe(false);
  });

  it('locks on every open under the "onClose" policy', () => {
    hasPasscode.set(true);
    autoLockPolicy.set('onClose');
    evaluateLockOnOpen();
    expect(get(isLocked)).toBe(true);
  });

  it('never locks under the "never" policy, even with a passcode set', () => {
    hasPasscode.set(true);
    autoLockPolicy.set('never');
    evaluateLockOnOpen();
    expect(get(isLocked)).toBe(false);
  });

  it('does not lock the very first open of a session under "onTimeout" — nothing has closed yet', () => {
    hasPasscode.set(true);
    autoLockPolicy.set('onTimeout');
    evaluateLockOnOpen();
    expect(get(isLocked)).toBe(false);
  });

  it('locks under "onTimeout" only once enough time has passed since the last close', () => {
    hasPasscode.set(true);
    autoLockPolicy.set('onTimeout');

    vi.useFakeTimers();
    try {
      noteLockScreenClosed();

      vi.advanceTimersByTime(AUTO_LOCK_TIMEOUT_MS - 1000);
      evaluateLockOnOpen();
      expect(get(isLocked)).toBe(false);

      vi.advanceTimersByTime(2000);
      evaluateLockOnOpen();
      expect(get(isLocked)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unlock() clears the lock unconditionally', () => {
    isLocked.set(true);
    unlock();
    expect(get(isLocked)).toBe(false);
  });
});
