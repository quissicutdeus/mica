// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { fade, fly, prefersReducedMotion } from './motion';

/**
 * MICA-66.
 *
 * `duration` is the number Svelte hands straight to `element.animate`, so reading it back
 * off the returned config is reading the real mechanism rather than a proxy for it. That
 * is the honest limit of what jsdom can say here: there is no layout and no compositor,
 * so nothing in this file can claim the drawer stopped moving — only that the animation it
 * would run is instantaneous.
 */
describe('motion-aware transitions', () => {
  const node = () => document.createElement('div');

  afterEach(() => {
    delete document.documentElement.dataset.reducedMotion;
  });

  it('leaves a transition alone when nothing has asked for less motion', () => {
    expect(prefersReducedMotion()).toBe(false);
    expect(fade(node(), { duration: 250 }).duration).toBe(250);
    expect(fly(node(), { y: -20, duration: 300, delay: 40 }).duration).toBe(300);
    expect(fly(node(), { y: -20, duration: 300, delay: 40 }).delay).toBe(40);
  });

  it('collapses duration and delay once the document says to reduce motion', () => {
    document.documentElement.dataset.reducedMotion = 'true';

    expect(prefersReducedMotion()).toBe(true);
    expect(fade(node(), { duration: 250 }).duration).toBe(0);

    const flown = fly(node(), { y: -20, duration: 300, delay: 40 });
    expect(flown.duration).toBe(0);
    // A delay is motion the player is made to wait through, not a separate concern.
    expect(flown.delay).toBe(0);
  });

  it('keeps the rest of the transition intact, so only the timing changes', () => {
    document.documentElement.dataset.reducedMotion = 'true';
    const config = fly(node(), { y: -20, duration: 300, opacity: 0.5 });

    // Still a fly, still described by a `css` function — Svelte just runs it in no time.
    expect(typeof config.css).toBe('function');
  });

  it('is read per transition, not captured once', () => {
    expect(fade(node(), { duration: 250 }).duration).toBe(250);
    document.documentElement.dataset.reducedMotion = 'true';
    expect(fade(node(), { duration: 250 }).duration).toBe(0);
    document.documentElement.dataset.reducedMotion = 'false';
    expect(fade(node(), { duration: 250 }).duration).toBe(250);
  });

  it('treats a missing attribute as full motion', () => {
    // An add-on's sandboxed frame is a separate document the shell cannot write into, so
    // this is the case that decides how one behaves: it animates, rather than freezing.
    expect(prefersReducedMotion()).toBe(false);
    expect(fade(node()).duration).toBeGreaterThan(0);
  });
});
