import { describe, it, expect } from 'vitest';
import { charge, roundedCharge, displayCharge, isDead } from './charge';
import { get } from 'svelte/store';

describe('charge store', () => {
  it('initializes charge to 100', () => {
    charge.set(100);
    expect(get(charge)).toBe(100);
    expect(get(roundedCharge)).toBe(100);
    expect(get(displayCharge)).toBe(100);
    expect(get(isDead)).toBe(false);
  });

  it('updates charge state', () => {
    charge.set(75);
    expect(get(charge)).toBe(75);
    expect(get(roundedCharge)).toBe(75);
    expect(get(displayCharge)).toBe(75);
    expect(get(isDead)).toBe(false);
  });

  it('calculates roundedCharge and displayCharge correctly for floating point battery levels', () => {
    charge.set(45.678);
    expect(get(roundedCharge)).toBe(45.68);
    expect(get(displayCharge)).toBe(46);
    expect(get(isDead)).toBe(false);
  });

  it('uses Math.ceil for displayCharge so non-zero battery shows as 1%', () => {
    charge.set(0.49);
    expect(get(displayCharge)).toBe(1);
    expect(get(isDead)).toBe(false);
  });

  it('flags battery as dead when charge drops to 0 or below', () => {
    charge.set(0);
    expect(get(displayCharge)).toBe(0);
    expect(get(isDead)).toBe(true);

    charge.set(-5);
    expect(get(roundedCharge)).toBe(0);
    expect(get(displayCharge)).toBe(0);
    expect(get(isDead)).toBe(true);
  });
});

