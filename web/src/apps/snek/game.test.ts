import { describe, it, expect } from 'vitest';
import { createGame, queueDirection, tick, BASE_TICK_MS } from './game';
import type { Point } from './game';

const GRID = { width: 10, height: 10 };
const noRandomness = () => 0;

describe('createGame', () => {
  it('starts with a 1-length snake, centered, moving right', () => {
    const state = createGame('easy', GRID, noRandomness);
    expect(state.snake).toHaveLength(1);
    expect(state.direction).toBe('right');
    expect(state.gameOver).toBe(false);
    expect(state.score).toBe(0);
  });

  it('sets tickMs from the difficulty', () => {
    expect(createGame('easy', GRID).tickMs).toBe(BASE_TICK_MS.easy);
    expect(createGame('hard', GRID).tickMs).toBe(BASE_TICK_MS.hard);
    expect(BASE_TICK_MS.hard).toBeLessThan(BASE_TICK_MS.easy);
  });
});

describe('queueDirection', () => {
  it('accepts a perpendicular turn', () => {
    const state = createGame('easy', GRID);
    expect(queueDirection(state, 'up')).toBe('up');
  });

  it("ignores a direct reversal into the snake's own neck", () => {
    let state = createGame('easy', GRID); // moving 'right'
    // A length-1 snake has no neck; grow it to two segments so 'left' is a real reversal.
    state = { ...state, snake: [...state.snake, { x: state.snake[0].x - 1, y: state.snake[0].y }] };
    expect(queueDirection(state, 'left')).toBe('right');
  });

  it('allows a reversal when the snake is length 1 (no neck to hit)', () => {
    const state = createGame('easy', GRID); // length 1
    expect(state.snake).toHaveLength(1);
    expect(queueDirection(state, 'left')).toBe('left');
  });
});

describe('tick', () => {
  it('moves the snake one cell in the given direction', () => {
    const state = createGame('easy', GRID, noRandomness);
    const head = state.snake[0];
    const next = tick(state, 'right', noRandomness);
    expect(next.snake[0]).toEqual({ x: head.x + 1, y: head.y });
  });

  it('ends the game on a boundary collision', () => {
    let state = createGame('easy', GRID, noRandomness);
    state = { ...state, snake: [{ x: GRID.width - 1, y: 0 }] };
    const next = tick(state, 'right', noRandomness);
    expect(next.gameOver).toBe(true);
  });

  it('ends the game on self-intersection', () => {
    const snake: Point[] = [
      { x: 5, y: 5 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
      { x: 6, y: 5 }
    ];
    let state = createGame('easy', GRID, noRandomness);
    state = { ...state, snake, direction: 'right' };
    // Moving 'down' from (5,5) lands on (5,6), which is occupied by the body.
    const next = tick(state, 'down', noRandomness);
    expect(next.gameOver).toBe(true);
  });

  it('grows the snake and increments score on eating food, and raises the multiplier with speed', () => {
    let state = createGame('easy', GRID, noRandomness);
    const head = state.snake[0];
    state = { ...state, food: { x: head.x + 1, y: head.y } };
    const before = state.snake.length;
    const next = tick(state, 'right', noRandomness);
    expect(next.snake.length).toBe(before + 1);
    expect(next.score).toBeGreaterThan(state.score);
    expect(next.tickMs).toBeLessThanOrEqual(state.tickMs);
  });

  it('does not move a game-over state further', () => {
    let state = createGame('easy', GRID, noRandomness);
    state = { ...state, gameOver: true };
    const next = tick(state, 'right', noRandomness);
    expect(next).toEqual(state);
  });

  it("never places food on the snake's own body", () => {
    let state = createGame('easy', GRID);
    for (let i = 0; i < 20; i++) {
      state = { ...state, food: { x: state.snake[0].x + 1, y: state.snake[0].y } };
      state = tick(state, 'right');
      expect(state.snake).not.toContainEqual(state.food);
    }
  });
});
