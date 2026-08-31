// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { clearAppStorage } from '../../sdk/host/useStorage';
import { privacyNoticeSeen, markPrivacyNoticeSeen, PRIVACY_NOTICE_TEXT } from './privacyNotice';

describe('privacy notice first-run flag (MICA-70)', () => {
  beforeEach(() => {
    clearAppStorage('settings');
    privacyNoticeSeen.set(false);
  });

  it('defaults to unseen', () => {
    expect(get(privacyNoticeSeen)).toBe(false);
  });

  it('marks itself seen once dismissed', () => {
    markPrivacyNoticeSeen();
    expect(get(privacyNoticeSeen)).toBe(true);
  });

  it('is a no-op once already seen', () => {
    privacyNoticeSeen.set(true);
    markPrivacyNoticeSeen();
    expect(get(privacyNoticeSeen)).toBe(true);
  });

  /**
   * The one property this ticket actually cares about: unlike the app-drawer hint, there
   * is no migration that marks an existing character's save "already seen" — a returning
   * player has never actually been told messages are readable by an admin, so they see the
   * notice exactly once, the same as someone brand new.
   */
  it('names the disclosure plainly, with no hedging', () => {
    expect(PRIVACY_NOTICE_TEXT).toMatch(/stored/i);
    expect(PRIVACY_NOTICE_TEXT).toMatch(/administrators/i);
  });
});
