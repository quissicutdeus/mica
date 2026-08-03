import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useSound } from './useSound';
import { audio, soundMuted, soundVolume } from '../../shell/state/audio';

describe('useSound', () => {
  beforeEach(() => {
    soundMuted.set(false);
    soundVolume.set(0.5);
  });

  afterEach(() => vi.restoreAllMocks());

  it('reaches the shell sound service', () => {
    // The whole point of the hook. It existed as a working service that apps had no
    // legal import path to, so "does the call actually arrive" is the regression.
    const play = vi.spyOn(audio, 'play').mockImplementation(() => {});

    useSound().play('click');

    expect(play).toHaveBeenCalledWith('click');
  });

  it('stays silent while the phone is muted', () => {
    // Asserted through the real service rather than the spy: an app must not be able to
    // route around mute, and that guarantee lives in `SoundService.play`, not here.
    const ctx = vi.fn();
    vi.stubGlobal('AudioContext', ctx);
    soundMuted.set(true);

    useSound().play('click');

    expect(ctx).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not throw where there is no audio device', () => {
    // jsdom has no AudioContext, and neither does CEF before a user gesture. A keypad
    // that throws on every tap would be worse than a silent one.
    expect(() => useSound().play('pop')).not.toThrow();
  });
});
