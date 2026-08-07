import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: { getPlayer: vi.fn(() => ({ citizenid: 'CID' })), registerUsableItem: vi.fn() }
}));

import {
  addDeadZone,
  currentRules,
  playerOverride,
  removeDeadZone,
  setGlobalSignal,
  setPlayerSignal,
  __resetSignal,
  FULL_SIGNAL
} from '../services/Signal';
import { evaluateSignal } from '../../client/services/Signal';

beforeEach(() => {
  __resetSignal();
  (globalThis as any).emitNet = vi.fn();
});

/**
 * Reception: a global level, dead zones, and per-player overrides.
 *
 * The precedence rule is the whole design, and it is the thing worth pinning — a city-wide
 * outage and a jammer are deliberately the **same primitive** rather than two mechanisms,
 * because two would drift the first time they disagreed.
 */
describe('signal rules', () => {
  it('starts at full bars with nothing to say otherwise', () => {
    expect(currentRules()).toEqual({ global: FULL_SIGNAL, zones: [] });
  });

  it('clamps a level rather than refusing it', () => {
    expect(setGlobalSignal(99)).toBe(FULL_SIGNAL);
    expect(setGlobalSignal(-5)).toBe(0);
  });

  it('pushes the rules on every change, not on a poll', () => {
    // The rules change rarely; polling would put a request per player per interval on the
    // wire for an answer that is almost always the same one.
    setGlobalSignal(1);
    expect(globalThis.emitNet).toHaveBeenCalledWith(
      'gphone:client:signal:rules',
      -1,
      expect.objectContaining({ global: 1 })
    );
  });

  it('hands back an id, which is the only thing a caller can do with a zone', () => {
    const zone = addDeadZone({ x: 1, y: 2, z: 3, radius: 50, level: 0 });
    expect(zone.id).toBeGreaterThan(0);
    expect(removeDeadZone(zone.id)).toBe(true);
    expect(removeDeadZone(zone.id)).toBe(false);
    expect(currentRules().zones).toEqual([]);
  });

  it('keeps an override per source and clears it with null', () => {
    setPlayerSignal(7, 0);
    expect(playerOverride(7)).toBe(0);
    setPlayerSignal(7, null);
    expect(playerOverride(7)).toBeNull();
  });
});

describe('the precedence order', () => {
  const rules = (global: number, zones: any[] = []) => ({ global, zones });
  const zone = (over: Partial<any> = {}) => ({
    id: 1,
    x: 0,
    y: 0,
    z: 0,
    radius: 100,
    level: 0,
    ...over
  });

  it('is full bars when nothing applies', () => {
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL), null)).toBe(FULL_SIGNAL);
  });

  it('takes the lowest of the global level and any zone the player is inside', () => {
    // The same primitive, not two mechanisms: a blackout is a global level, a jammer is a
    // zone, and whichever is worse is what you get.
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL, [zone({ level: 1 })]), null)).toBe(1);
    expect(evaluateSignal(0, 0, 0, rules(2, [zone({ level: 3 })]), null)).toBe(2);
  });

  it('ignores a zone the player is outside', () => {
    expect(evaluateSignal(500, 500, 0, rules(FULL_SIGNAL, [zone({ level: 0 })]), null)).toBe(
      FULL_SIGNAL
    );
  });

  it('measures in three dimensions, so a basement is not the street above it', () => {
    // A radius check that ignored z would black out every floor of a building because one
    // room in it has a jammer.
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL, [zone({ radius: 10 })]), null)).toBe(0);
    expect(evaluateSignal(0, 0, 40, rules(FULL_SIGNAL, [zone({ radius: 10 })]), null)).toBe(
      FULL_SIGNAL
    );
  });

  it('lets a per-player override win outright, including upward', () => {
    // It is set *at* a player rather than at the world, so it is not part of the
    // lowest-wins comparison — otherwise there would be no way to give somebody bars
    // inside a blackout, which is the whole point of the override.
    expect(evaluateSignal(0, 0, 0, rules(0, [zone({ level: 0 })]), FULL_SIGNAL)).toBe(FULL_SIGNAL);
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL), 0)).toBe(0);
  });

  it('takes the worst of several overlapping zones', () => {
    const overlapping = [zone({ id: 1, level: 3 }), zone({ id: 2, level: 1 })];
    expect(evaluateSignal(0, 0, 0, rules(FULL_SIGNAL, overlapping), null)).toBe(1);
  });
});
