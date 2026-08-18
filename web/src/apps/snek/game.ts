export type Direction = 'up' | 'down' | 'left' | 'right';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Point {
  x: number;
  y: number;
}

export interface GameState {
  grid: { width: number; height: number };
  snake: Point[];
  direction: Direction;
  food: Point;
  score: number;
  tickMs: number;
  gameOver: boolean;
}

export const BASE_TICK_MS: Record<Difficulty, number> = {
  easy: 220,
  medium: 160,
  hard: 110
};

/** Never speed up past this — a tick faster than this is unplayable, not "hard". */
const MIN_TICK_MS = 60;
/** Shave this many ms off the tick interval per food eaten. */
const SPEEDUP_MS = 4;

const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left'
};

const DELTA: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

function placeFood(grid: GameState['grid'], snake: Point[], rng: () => number): Point {
  // Bounded retry rather than computing free cells: the snake is small relative to the
  // grid for the entire playable game, so a handful of random draws almost always lands
  // on a free cell, and a full free-cell scan would run every tick that eats.
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate: Point = {
      x: Math.floor(rng() * grid.width),
      y: Math.floor(rng() * grid.height)
    };
    if (!snake.some((cell) => samePoint(cell, candidate))) return candidate;
  }
  // Grid is full (or effectively full) — park food off-grid so nothing can be eaten.
  return { x: -1, y: -1 };
}

export function createGame(
  difficulty: Difficulty,
  grid: GameState['grid'],
  rng: () => number = Math.random
): GameState {
  const start: Point = { x: Math.floor(grid.width / 2), y: Math.floor(grid.height / 2) };
  const snake = [start];
  return {
    grid,
    snake,
    direction: 'right',
    food: placeFood(grid, snake, rng),
    score: 0,
    tickMs: BASE_TICK_MS[difficulty],
    gameOver: false
  };
}

/**
 * What direction a queued keypress actually becomes. A snake longer than one segment may
 * not reverse directly into its own neck; length 1 has no neck, so any direction is legal.
 */
export function queueDirection(state: GameState, next: Direction): Direction {
  if (state.snake.length > 1 && next === OPPOSITE[state.direction]) {
    return state.direction;
  }
  return next;
}

/** Points per food, scaling with how fast the game currently is relative to the base tick. */
function scoreForTick(baseTick: number, tickMs: number): number {
  return Math.max(1, Math.round(baseTick / tickMs));
}

export function tick(
  state: GameState,
  nextDirection: Direction,
  rng: () => number = Math.random
): GameState {
  if (state.gameOver) return state;

  const direction = queueDirection(state, nextDirection);
  const head = state.snake[0];
  const newHead: Point = { x: head.x + DELTA[direction].x, y: head.y + DELTA[direction].y };

  const outOfBounds =
    newHead.x < 0 || newHead.y < 0 || newHead.x >= state.grid.width || newHead.y >= state.grid.height;
  if (outOfBounds) {
    return { ...state, direction, gameOver: true };
  }

  const ateFood = samePoint(newHead, state.food);
  // The tail cell vacates this tick unless the snake just grew, so a move onto the current
  // tail position is legal — check against the body excluding the tail when not growing.
  const bodyToCheck = ateFood ? state.snake : state.snake.slice(0, -1);
  const hitSelf = bodyToCheck.some((cell) => samePoint(cell, newHead));
  if (hitSelf) {
    return { ...state, direction, gameOver: true };
  }

  const snake = ateFood ? [newHead, ...state.snake] : [newHead, ...state.snake.slice(0, -1)];
  const tickMs = ateFood ? Math.max(MIN_TICK_MS, state.tickMs - SPEEDUP_MS) : state.tickMs;
  const score = ateFood ? state.score + scoreForTick(BASE_TICK_MS.easy, state.tickMs) : state.score;
  const food = ateFood ? placeFood(state.grid, snake, rng) : state.food;

  return { ...state, snake, direction, tickMs, score, food, gameOver: false };
}
