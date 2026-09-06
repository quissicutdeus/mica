# Registered numbers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a server resource own a phone number, answer calls placed to it,
and start a call on a player's behalf (MICA-226).

**Architecture:** One new module, `server/lib/numberRegistry.ts`, holds the
number → line map, per-resource ownership, and the guarded handler call.
`Phone.ts` gains a fallback branch after its existing `getPlayerByPhone` miss,
and loses its hardcoded emergency-number comparison. `publicApi.ts` publishes
three exports onto the registry.

**Tech Stack:** TypeScript 7 (server is typechecked, strictly — AGENTS.md §3),
Vitest 4 under the root `vitest.config.ts`, FiveM server natives.

**Spec:** `docs/superpowers/specs/2026-09-05-registered-numbers-design.md`

## Global Constraints

- `pnpm` only. Never `npm`, `npx`, `bun`, `yarn`. Use `pnpm dlx` for `npx`.
- Every new file carries the SPDX header used by its neighbours:
  `// SPDX-FileCopyrightText: 2026 quissicutdeus` then
  `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Server tests live in `server/__tests__/`, run with `pnpm test:unit:server`.
  They are **not** typechecked; the source they exercise is. **To run one file,
  use `pnpm exec vitest run <path>`** — `test:unit:server` is a bare
  `vitest run` and `pnpm test:unit:server -- <pattern>` does not narrow it; it
  runs all 101 files. Run the full suite once before committing.
- Prettier at 100 columns for code, 80 for prose. Run `pnpm format`.
- No AI attribution in any commit message (AGENTS.md §2.10).
- Commit subjects are imperative and lead with the key: `MICA-226: <decision>`.
- Do not edit `fxmanifest.lua` or anything in `dist/` — both generated.
- **No new runtime dependencies.** This plan adds none.

## Deviation from the spec, decided during planning

The spec says failures use "`invalid_args`, `already_registered`, `not_owner`,
`number_in_use`, `unknown_player`". Only the first and last exist —
`ExportFailure` in `server/lib/exports.ts` is a closed union of
`unknown_player | offline | not_ready | invalid_args | internal_error`.

Task 1 extends that union with the three new reasons. This is **additive**: no
existing export can return them, so `MICA_API_VERSION` does not bump (its
docblock says bumped when an existing export changes shape, not when one is
added).

Second, smaller deviation: the spec says both `forward(source)` and `CreateCall`
check `isConnected(source)`. That helper lives in `server/services/Signal.ts`,
and importing a service from `server/lib/` is the runtime cycle
`lib/phoneNumbers.ts` documents avoiding. The plan calls
`FrameworkBridge.getPlayer(source)` directly instead, which is exactly what
`isConnected` itself does. Same check, no cycle.

## File Structure

| File                                            | Responsibility                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `server/lib/numberRegistry.ts` (new)            | The whole registry: map, ownership, cleanup, guarded handler call with timeout. The only module that knows how a line is stored.          |
| `server/lib/exports.ts` (modify)                | Three new `ExportFailure` members.                                                                                                        |
| `server/lib/publicApi.ts` (modify)              | Publishes `RegisterNumber`, `UnregisterNumber`, `CreateCall`.                                                                             |
| `server/services/Phone.ts` (modify)             | Pseudo-source pool; registry fallback in `phone:start`; emergency special-case removed; dial body extracted so `CreateCall` can reuse it. |
| `server/__tests__/numberRegistry.test.ts` (new) | Registry unit tests.                                                                                                                      |
| `server/__tests__/setup.ts` (modify)            | Stub `GetInvokingResource`.                                                                                                               |
| `server/__tests__/exports.test.ts` (modify)     | Pin the three new export names.                                                                                                           |
| `server/__tests__/phone.test.ts` (modify)       | Emergency blockability moves from convar comparison to `blockable`.                                                                       |

---

### Task 1: Failure reasons and the registry's storage

**Files:**

- Modify: `server/lib/exports.ts` (the `ExportFailure` union)
- Create: `server/lib/numberRegistry.ts`
- Modify: `server/__tests__/setup.ts`
- Test: `server/__tests__/numberRegistry.test.ts`

**Interfaces:**

- Consumes: `ExportOutcome`, `ok`, `fail` from `server/lib/exports.ts`.
- Produces: `registerNumber(number, options, owner)`,
  `unregisterNumber(number, owner)`, `lookupLine(number)`, `__resetRegistry()`,
  and the types `CallVerdict`, `LineOptions`, `RegisteredLine`.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/numberRegistry.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: { getPlayerByPhone: vi.fn(() => undefined), getPlayer: vi.fn() }
}));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import {
  registerNumber,
  unregisterNumber,
  lookupLine,
  __resetRegistry
} from '../lib/numberRegistry';

const onCall = () => ({ action: 'reject' }) as const;

describe('numberRegistry storage', () => {
  beforeEach(() => {
    __resetRegistry();
    bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  });

  it('registers a number and finds it again', () => {
    const result = registerNumber('5551234', { onCall }, 'taxi');
    expect(result.ok).toBe(true);
    expect(lookupLine('5551234')?.owner).toBe('taxi');
  });

  it('defaults blockable to true', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    expect(lookupLine('5551234')?.blockable).toBe(true);
  });

  it('honours blockable false', () => {
    registerNumber('911', { onCall, blockable: false }, 'mica');
    expect(lookupLine('911')?.blockable).toBe(false);
  });

  it('refuses a number another resource already holds', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    const second = registerNumber('5551234', { onCall }, 'mechanic');
    expect(second).toMatchObject({ ok: false, reason: 'already_registered' });
    expect(lookupLine('5551234')?.owner).toBe('taxi');
  });

  it('lets the same owner replace its own entry, so a script can hot-reload', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    const again = registerNumber(
      '5551234',
      { onCall, blockable: false },
      'taxi'
    );
    expect(again.ok).toBe(true);
    expect(lookupLine('5551234')?.blockable).toBe(false);
  });

  it('refuses a number a real character already holds', () => {
    bridgeMock.getPlayerByPhone.mockReturnValue({
      source: 3,
      citizenid: 'ABC'
    });
    const result = registerNumber('5550100', { onCall }, 'taxi');
    expect(result).toMatchObject({ ok: false, reason: 'number_in_use' });
    expect(lookupLine('5550100')).toBeUndefined();
  });

  it('refuses a number that is not phone-number-shaped', () => {
    expect(registerNumber('', { onCall }, 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
    expect(registerNumber('x'.repeat(33), { onCall }, 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });

  it('refuses a registration with no callable onCall', () => {
    expect(registerNumber('5551234', {} as never, 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });

  it('unregisters only for the owner', () => {
    registerNumber('5551234', { onCall }, 'taxi');
    expect(unregisterNumber('5551234', 'mechanic')).toMatchObject({
      ok: false,
      reason: 'not_owner'
    });
    expect(lookupLine('5551234')).toBeDefined();
    expect(unregisterNumber('5551234', 'taxi').ok).toBe(true);
    expect(lookupLine('5551234')).toBeUndefined();
  });

  it('reports unregistering a number nobody holds', () => {
    expect(unregisterNumber('5551234', 'taxi')).toMatchObject({
      ok: false,
      reason: 'invalid_args'
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run server/__tests__/numberRegistry.test.ts` Expected:
FAIL — cannot resolve `../lib/numberRegistry`.

- [ ] **Step 3: Extend the failure union**

In `server/lib/exports.ts`, add three members to `ExportFailure`, each with the
doc-comment style the existing members use:

```ts
  /** micaOS raised where it should not have. Reported rather than propagated. */
  | 'internal_error'
  /** Another resource already holds that number. */
  | 'already_registered'
  /** That number belongs to a different resource. */
  | 'not_owner'
  /** A character already holds that number, and a player always wins. */
  | 'number_in_use';
```

- [ ] **Step 4: Stub the native the registry needs**

In `server/__tests__/setup.ts`, add to `fivemGlobals`:

```ts
  GetInvokingResource: () => 'test-resource',
```

- [ ] **Step 5: Write the registry**

Create `server/lib/numberRegistry.ts`:

```ts
// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import { phoneNumberFrom } from './netGuard';
import { ok, fail, type ExportOutcome } from './exports';

/**
 * Numbers owned by a script rather than by a character.
 *
 * A resource registers a number, and a call placed to it reaches that resource's handler
 * instead of failing as unreachable. This is the registry and nothing else: `Phone.ts` asks
 * it one question, `publicApi.ts` publishes onto it, and no other module knows how a line
 * is stored or how its handler is invoked.
 *
 * **A player always wins.** `Phone.ts` resolves `getPlayerByPhone` first and only falls back
 * here on a miss, so a number that later becomes a real character's silently stops reaching
 * the script. Registration additionally refuses a number a character already holds, but that
 * check is a courtesy — the per-call ordering is the guarantee, because phone numbers are
 * issued by the framework and can change under us at any time.
 */

/** What a handler may answer. `forward` re-enters the ordinary player call path. */
export type CallVerdict =
  | { action: 'accept' }
  | { action: 'reject' }
  | { action: 'forward'; source: number };

/** What reaches a line's handler when somebody calls it. */
export interface IncomingLineCall {
  /** The caller's phone number. */
  from: string;
  /** The caller's server id. */
  source: number;
  /** The call this verdict answers. */
  callId: number;
}

export interface LineOptions {
  onCall: (call: IncomingLineCall) => CallVerdict | Promise<CallVerdict>;
  /** Defaults to true. A blockable line can be blocked like any other number. */
  blockable?: boolean;
}

export interface RegisteredLine {
  number: string;
  owner: string;
  blockable: boolean;
  onCall: LineOptions['onCall'];
}

const lines = new Map<string, RegisteredLine>();

/** Test seam, matching `__resetCalls` in `Phone.ts`. */
export const __resetRegistry = (): void => {
  lines.clear();
};

export const lookupLine = (number: string): RegisteredLine | undefined =>
  lines.get(number);

/** Every line a resource owns. Used by the resource-stop sweep. */
export const linesOwnedBy = (owner: string): RegisteredLine[] =>
  [...lines.values()].filter((line) => line.owner === owner);

export function registerNumber(
  rawNumber: unknown,
  options: LineOptions,
  owner: string
): ExportOutcome {
  const number = phoneNumberFrom(rawNumber);
  if (!number) {
    return fail('invalid_args', 'A phone number is required.');
  }
  if (typeof options?.onCall !== 'function') {
    return fail('invalid_args', 'onCall must be a function.');
  }

  const held = lines.get(number);
  if (held && held.owner !== owner) {
    return fail(
      'already_registered',
      `${held.owner} already holds that number.`
    );
  }

  if (FrameworkBridge.getPlayerByPhone(number)) {
    return fail('number_in_use', 'A character already holds that number.');
  }

  lines.set(number, {
    number,
    owner,
    blockable: options.blockable !== false,
    onCall: options.onCall
  });
  return ok();
}

export function unregisterNumber(
  rawNumber: unknown,
  owner: string
): ExportOutcome {
  const number = phoneNumberFrom(rawNumber);
  if (!number) return fail('invalid_args', 'A phone number is required.');

  const held = lines.get(number);
  if (!held) return fail('invalid_args', 'Nothing holds that number.');
  if (held.owner !== owner)
    return fail('not_owner', 'That number belongs to another resource.');

  lines.delete(number);
  return ok();
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm exec vitest run server/__tests__/numberRegistry.test.ts` Expected:
PASS, 10 tests.

- [ ] **Step 7: Typecheck, format, commit**

```bash
pnpm typecheck:server
pnpm format
git add server/lib/numberRegistry.ts server/lib/exports.ts server/__tests__/setup.ts server/__tests__/numberRegistry.test.ts
git commit -m "MICA-226: store script-owned numbers, and let a player's number always win"
```

---

### Task 2: Invoking the handler, with a timeout

**Files:**

- Modify: `server/lib/numberRegistry.ts`
- Test: `server/__tests__/numberRegistry.test.ts`

**Interfaces:**

- Consumes: `RegisteredLine`, `CallVerdict`, `IncomingLineCall` from Task 1.
- Produces: `askLine(line, call): Promise<CallVerdict>` — never throws, never
  hangs. Returns `{ action: 'reject' }` for a throwing or slow handler.
- Produces: `HANDLER_TIMEOUT_MS = 5000`.

- [ ] **Step 1: Write the failing test**

Append to `server/__tests__/numberRegistry.test.ts`:

```ts
import { askLine, HANDLER_TIMEOUT_MS } from '../lib/numberRegistry';

describe('numberRegistry handler invocation', () => {
  beforeEach(() => {
    __resetRegistry();
    bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  });

  const lineWith = (handler: LineOptions['onCall']) => {
    registerNumber('5551234', { onCall: handler }, 'taxi');
    return lookupLine('5551234')!;
  };

  const incoming = { from: '5550100', source: 3, callId: 42 };

  it('passes the call through and returns the verdict', async () => {
    const handler = vi.fn(() => ({ action: 'accept' }) as const);
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'accept'
    });
    expect(handler).toHaveBeenCalledWith(incoming);
  });

  it('awaits an async handler', async () => {
    const handler = async () => ({ action: 'forward', source: 9 }) as const;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'forward',
      source: 9
    });
  });

  it('treats a throwing handler as a reject rather than propagating', async () => {
    const handler = () => {
      throw new Error('script bug');
    };
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('treats a rejected promise as a reject', async () => {
    const handler = async () => {
      throw new Error('async script bug');
    };
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('treats a verdict it does not recognise as a reject', async () => {
    const handler = () => ({ action: 'explode' }) as never;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('rejects a forward whose source is not a number', async () => {
    const handler = () => ({ action: 'forward', source: 'nope' }) as never;
    await expect(askLine(lineWith(handler), incoming)).resolves.toEqual({
      action: 'reject'
    });
  });

  it('gives up on a handler that never returns', async () => {
    vi.useFakeTimers();
    const handler = () => new Promise<never>(() => {});
    const pending = askLine(lineWith(handler), incoming);
    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ action: 'reject' });
    vi.useRealTimers();
  });
});
```

Add `type LineOptions` to the existing import from `../lib/numberRegistry`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run server/__tests__/numberRegistry.test.ts` Expected:
FAIL — `askLine` is not exported.

- [ ] **Step 3: Implement `askLine`**

Append to `server/lib/numberRegistry.ts`:

```ts
/**
 * How long a line's handler gets before the call is treated as unanswered.
 *
 * Long enough for a script doing a database read, short enough that a caller is not left
 * ringing a dead line. A handler that overruns is answered as `reject`, which reaches the
 * caller as `failUnreachable` — so a broken integration is indistinguishable from a number
 * nobody holds, the same guarantee MICA-64 makes about a blocked call.
 */
export const HANDLER_TIMEOUT_MS = 5000;

const REJECT: CallVerdict = { action: 'reject' };

/** A verdict shaped the way this module promised, or null. */
const verdictFrom = (raw: unknown): CallVerdict | null => {
  if (!raw || typeof raw !== 'object') return null;
  const action = (raw as { action?: unknown }).action;
  if (action === 'accept' || action === 'reject') return { action };
  if (action === 'forward') {
    const source = (raw as { source?: unknown }).source;
    return typeof source === 'number' && Number.isInteger(source)
      ? { action: 'forward', source }
      : null;
  }
  return null;
};

/**
 * Ask a line what to do with a call. Never throws, never hangs.
 *
 * The handler belongs to another resource and is reached through a function ref, so all
 * three failure modes are somebody else's bug rather than ours: it can throw, it can reject,
 * and it can simply never come back. Each answers `reject`, because the alternative is a
 * caller whose phone rings forever.
 */
export async function askLine(
  line: RegisteredLine,
  call: IncomingLineCall
): Promise<CallVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verdict = await Promise.race([
      Promise.resolve(line.onCall(call)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.error(
            `[mica] line ${line.number} (${line.owner}) did not answer within ` +
              `${HANDLER_TIMEOUT_MS}ms; treating the call as unreachable.`
          );
          resolve(null);
        }, HANDLER_TIMEOUT_MS);
      })
    ]);
    return verdictFrom(verdict) ?? REJECT;
  } catch (error) {
    console.error(`[mica] line ${line.number} (${line.owner}) threw:`, error);
    return REJECT;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run server/__tests__/numberRegistry.test.ts` Expected:
PASS, 17 tests.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm typecheck:server
pnpm format
git add server/lib/numberRegistry.ts server/__tests__/numberRegistry.test.ts
git commit -m "MICA-226: answer for a line that throws, stalls or lies, rather than hanging the caller"
```

---

### Task 3: Releasing a stopped resource's numbers

**Files:**

- Modify: `server/lib/numberRegistry.ts`
- Test: `server/__tests__/numberRegistry.test.ts`

**Interfaces:**

- Consumes: `linesOwnedBy` from Task 1.
- Produces: `releaseResource(owner): string[]` returning the numbers dropped,
  and a module-scope `on('onResourceStop', …)` registration.
- Produces: `onLineReleased(fn)` — a one-slot hook `Phone.ts` fills in Task 4 so
  the registry can end live calls without importing a service.

- [ ] **Step 1: Write the failing test**

Append to `server/__tests__/numberRegistry.test.ts`:

```ts
import { releaseResource, onLineReleased } from '../lib/numberRegistry';

describe('numberRegistry resource lifecycle', () => {
  beforeEach(() => {
    __resetRegistry();
    bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  });

  it("drops every number the stopping resource owned, and nobody else's", () => {
    registerNumber('5551111', { onCall }, 'taxi');
    registerNumber('5552222', { onCall }, 'taxi');
    registerNumber('5553333', { onCall }, 'mechanic');

    const dropped = releaseResource('taxi');

    expect(dropped.sort()).toEqual(['5551111', '5552222']);
    expect(lookupLine('5551111')).toBeUndefined();
    expect(lookupLine('5552222')).toBeUndefined();
    expect(lookupLine('5553333')).toBeDefined();
  });

  it('tells the call layer about each released number', () => {
    const released: string[] = [];
    onLineReleased((number) => released.push(number));
    registerNumber('5551111', { onCall }, 'taxi');

    releaseResource('taxi');

    expect(released).toEqual(['5551111']);
  });

  it('is a no-op for a resource that held nothing', () => {
    expect(releaseResource('unrelated')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run server/__tests__/numberRegistry.test.ts` Expected:
FAIL — `releaseResource` is not exported.

- [ ] **Step 3: Implement the release path**

Append to `server/lib/numberRegistry.ts`:

```ts
/**
 * Told when a line goes away, so live calls on it can be ended.
 *
 * A hook rather than a direct call because this module lives in `lib/` and the call state
 * lives in `services/Phone.ts`; importing the service from here would close the same runtime
 * cycle `lib/phoneNumbers.ts` documents avoiding. `Phone.ts` fills the slot at import time.
 */
let lineReleased: (number: string) => void = () => {};

export const onLineReleased = (fn: (number: string) => void): void => {
  lineReleased = fn;
};

/**
 * Drop every number a resource owns, and return them.
 *
 * Without this a stopped script leaves a number that swallows calls into a dead function
 * ref forever — the failure mode function refs trade against, and the reason the export
 * takes refs at all rather than resource+export-name strings.
 */
export function releaseResource(owner: string): string[] {
  const dropped = linesOwnedBy(owner).map((line) => line.number);
  for (const number of dropped) {
    lines.delete(number);
    lineReleased(number);
  }
  return dropped;
}

on('onResourceStop', (resource: string) => {
  const dropped = releaseResource(resource);
  if (dropped.length > 0) {
    console.log(
      `[mica] released ${dropped.length} number(s) held by ${resource}.`
    );
  }
});
```

Note: `__resetRegistry` must also clear the hook so suites do not leak into each
other. Change it to:

```ts
export const __resetRegistry = (): void => {
  lines.clear();
  lineReleased = () => {};
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run server/__tests__/numberRegistry.test.ts` Expected:
PASS, 20 tests.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm typecheck:server
pnpm format
git add server/lib/numberRegistry.ts server/__tests__/numberRegistry.test.ts
git commit -m "MICA-226: release a resource's numbers when it stops, so a dead ref stops answering"
```

---

### Task 4: Routing a call to a line

**Files:**

- Modify: `server/services/Phone.ts`
- Test: `server/__tests__/phone.test.ts`

**Interfaces:**

- Consumes: `lookupLine`, `askLine`, `onLineReleased` from Tasks 1–3.
- Produces: `placeCall(src, targetPhone): Promise<void>` — the extracted dial
  body, called by both the `phone:start` net event and Task 6's `CreateCall`.

Read `server/services/Phone.ts:187-270` before starting. The existing handler
body becomes `placeCall`; the `onNet` wrapper keeps its `guardNetEvent` call.

- [ ] **Step 1: Write the failing test**

Add to `server/__tests__/phone.test.ts`, following the mock style already at the
top of that file:

```ts
it('rings the line handler when no character holds the number', async () => {
  const onCall = vi.fn(() => ({ action: 'accept' }) as const);
  registerNumber('5559999', { onCall }, 'taxi');
  bridgeMock.getPlayerByPhone.mockReturnValue(undefined);

  await placeCall(CALLER_SRC, '5559999');

  expect(onCall).toHaveBeenCalledWith(
    expect.objectContaining({ from: CALLER_PHONE, source: CALLER_SRC })
  );
});

it('does not reach the registry when a character holds the number', async () => {
  const onCall = vi.fn(() => ({ action: 'accept' }) as const);
  registerNumber('5559999', { onCall }, 'taxi');
  bridgeMock.getPlayerByPhone.mockReturnValue({
    source: TARGET_SRC,
    citizenid: 'TGT'
  });

  await placeCall(CALLER_SRC, '5559999');

  expect(onCall).not.toHaveBeenCalled();
});

it('gives two simultaneous callers to one line distinct calls', async () => {
  registerNumber(
    '5559999',
    { onCall: () => ({ action: 'accept' }) as const },
    'taxi'
  );
  bridgeMock.getPlayerByPhone.mockReturnValue(undefined);

  await placeCall(CALLER_SRC, '5559999');
  await placeCall(SECOND_CALLER_SRC, '5559999');

  const ids = emitted
    .filter(([event]) => event === 'mica:client:phone:accepted')
    .map(([, , payload]) => (payload as { callId: number }).callId);
  expect(new Set(ids).size).toBe(ids.length);
});

it('a rejecting line fails exactly like an unreachable number', async () => {
  registerNumber(
    '5559999',
    { onCall: () => ({ action: 'reject' }) as const },
    'taxi'
  );
  bridgeMock.getPlayerByPhone.mockReturnValue(undefined);

  await placeCall(CALLER_SRC, '5559999');

  expect(emitted).toContainEqual(['mica:client:phone:failed', CALLER_SRC]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run server/__tests__/phone.test.ts` Expected: FAIL —
`placeCall` is not exported.

- [ ] **Step 3: Add the pseudo-source pool**

In `server/services/Phone.ts`, below `CONSOLE_CALLER_SOURCE`:

```ts
/**
 * Sources for the far end of a line call, one per active call.
 *
 * `CONSOLE_CALLER_SOURCE` is a single sentinel, and `playerCalls` is keyed by source — so
 * two players calling one taxi line at the same moment would collide on the same key and
 * the second would be told the line was busy. Counting down from -2 leaves -1 the console's
 * and gives every line call its own key. Every existing negative-source behaviour still
 * holds: `getCitizenId` answers null, and `logCallEnd` already skips writing a row for a
 * source with no citizenid behind it.
 */
let nextLineSource = -2;
const allocateLineSource = (): number => nextLineSource--;
```

Extend `__resetCalls` with `nextLineSource = -2;` so suites do not drift.

- [ ] **Step 4: Extract the dial body and add the fallback**

Replace the `onNet('mica:server:phone:start', …)` handler at
`server/services/Phone.ts:187` with an exported function plus a thin wrapper:

```ts
export async function placeCall(
  src: number,
  rawTarget: unknown
): Promise<void> {
  const targetPhone = phoneNumberFrom(rawTarget);
  if (!targetPhone) return;

  const callerPhone = FrameworkBridge.getPlayerPhone(src);
  if (!callerPhone) return;

  const targetPlayer = FrameworkBridge.getPlayerByPhone(targetPhone);
  const targetSrc = targetPlayer?.source || null;
  const line = targetSrc ? undefined : lookupLine(targetPhone);

  const blocked =
    (line ? line.blockable : true) &&
    (await isBlocked(targetPlayer?.citizenid ?? '', callerPhone));

  if (!targetSrc && line && !blocked) {
    await connectLineCall(src, callerPhone, targetPhone, line);
    return;
  }

  if (!targetSrc || blocked) {
    failUnreachable(src, targetPhone);
    return;
  }

  if (targetSrc === src) {
    notifyPlayer(src, {
      type: 'error',
      message: 'Busy',
      key: 'server.phone.busy'
    });
    emitNet('mica:client:phone:failed', src);
    return;
  }

  if (playerCalls[targetSrc] || playerCalls[src]) {
    notifyPlayer(src, {
      type: 'error',
      message: 'Line busy',
      key: 'server.phone.lineBusy'
    });
    emitNet('mica:client:phone:failed', src);
    return;
  }

  const callId = generateCallId();
  activeCalls[callId] = {
    id: callId,
    caller: src,
    target: targetSrc,
    callerPhone,
    targetPhone,
    startTime: Date.now(),
    answeredAt: null
  };
  playerCalls[src] = callId;
  playerCalls[targetSrc] = callId;

  emitNet('mica:client:phone:incoming', targetSrc, {
    from: callerPhone,
    callId
  });
}

onNet('mica:server:phone:start', async (rawTarget: unknown) => {
  const player = guardNetEvent('phone', 'start');
  if (!player) return;
  await placeCall(source, rawTarget);
});
```

Then add the line-call connector beneath it:

```ts
/**
 * Ring a script-owned line and act on its verdict.
 *
 * `accept` connects through the same events a player answering emits, so the caller's UI
 * shows a connected call — with no second client on the other end, so nothing joins
 * pma-voice. `forward` re-enters the ordinary path at a real source, which is what keeps
 * voice, blocking and call logging identical to a player-to-player call.
 */
async function connectLineCall(
  src: number,
  callerPhone: string,
  targetPhone: string,
  line: RegisteredLine
): Promise<void> {
  if (playerCalls[src]) {
    notifyPlayer(src, {
      type: 'error',
      message: 'Line busy',
      key: 'server.phone.lineBusy'
    });
    emitNet('mica:client:phone:failed', src);
    return;
  }

  const callId = generateCallId();
  const lineSource = allocateLineSource();
  const verdict = await askLine(line, {
    from: callerPhone,
    source: src,
    callId
  });

  // A forward re-dials by the target's own number, which cannot land back here: a number a
  // character holds is refused at registration and loses to the player lookup on every call,
  // so `placeCall` resolves it down the player path. A source with no phone yields `''`,
  // which `phoneNumberFrom` rejects and `placeCall` returns on.
  if (verdict.action === 'forward') {
    if (!FrameworkBridge.getPlayer(verdict.source)) {
      failUnreachable(src, targetPhone);
      return;
    }
    await placeCall(src, FrameworkBridge.getPlayerPhone(verdict.source) ?? '');
    return;
  }

  if (verdict.action !== 'accept') {
    failUnreachable(src, targetPhone);
    return;
  }

  activeCalls[callId] = {
    id: callId,
    caller: src,
    target: lineSource,
    callerPhone,
    targetPhone,
    startTime: Date.now(),
    answeredAt: Date.now()
  };
  playerCalls[src] = callId;
  playerCalls[lineSource] = callId;

  emitNet('mica:client:phone:accepted', src, { callId });
}
```

Add the imports at the top of the file:

```ts
import {
  lookupLine,
  askLine,
  onLineReleased,
  type RegisteredLine
} from '../lib/numberRegistry';
```

And register the release hook at module scope, near the other registrations:

```ts
onLineReleased((number) => {
  for (const call of Object.values(activeCalls)) {
    if (call.targetPhone === number)
      endActiveCall(call.id, CONSOLE_CALLER_SOURCE);
  }
});
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm exec vitest run server/__tests__/phone.test.ts` Expected: PASS,
including the four new cases.

- [ ] **Step 6: Typecheck, format, commit**

```bash
pnpm typecheck:server
pnpm format
git add server/services/Phone.ts server/__tests__/phone.test.ts
git commit -m "MICA-226: fall back to a registered line when no character holds the number"
```

---

### Task 5: The emergency number becomes the first registered line

**Files:**

- Modify: `server/services/Phone.ts`
- Test: `server/__tests__/phone.test.ts`

**Interfaces:**

- Consumes: `registerNumber` from Task 1, `placeCall` from Task 4.
- Produces: nothing new. `currentEmergencyNumber()` keeps its signature so
  `publicApi.ts`'s `GetEmergencyNumber` is untouched.

**Second controller ruling, after Task 4.** The original criterion "the
emergency number is re-expressed as the first registered number and `Phone.ts`
no longer names it" is **withdrawn**. `line` is consulted only when no player
holds the number, and the emergency number is normally held by a real dispatcher
— so a registry-only exemption silently stops applying the moment 911 is
staffed, which is precisely when it matters. Task 4 proved this against three
existing tests. Keep `targetPhone === emergencyNumber()`. This task is now
strictly additive: register the emergency number as an unblockable line with no
handler, so a dispatch resource can own 911 without a player behind it.

**Controller ruling, applied before dispatch.** `isBlocked(citizenid, number)`
queries `mica_blocklist WHERE citizenid = ?`, and that citizenid is the person
who did the blocking. A line has no citizenid, so `isBlocked('', callerPhone)`
is always false and a `blockable: true` line cannot actually be blocked today.
The flag still earns its place — its job here is to replace the hardcoded
`targetPhone !== emergencyNumber()` comparison, which it does correctly — but do
not write a test claiming a line gets blocked. The test below asserts what is
true: an unblockable line never consults the blocklist, a blockable one does.
Blocking a script line is a follow-up, not this ticket.

`Phone.ts:230` currently reads
`targetPhone !== emergencyNumber() && (await isBlocked(...))`. Task 4 already
replaced that with `(line ? line.blockable : true)`. This task registers the
emergency number so that expression covers it.

- [ ] **Step 1: Write the failing test**

```ts
it('never blocks the emergency number, because its line is unblockable', async () => {
  bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  isBlockedMock.mockResolvedValue(true);

  await placeCall(CALLER_SRC, '911');

  expect(isBlockedMock).not.toHaveBeenCalled();
});

it('still blocks an ordinary registered line', async () => {
  registerNumber(
    '5559999',
    { onCall: () => ({ action: 'accept' }) as const },
    'taxi'
  );
  bridgeMock.getPlayerByPhone.mockReturnValue(undefined);
  isBlockedMock.mockResolvedValue(true);

  await placeCall(CALLER_SRC, '5559999');

  expect(emitted).toContainEqual(['mica:client:phone:failed', CALLER_SRC]);
});

it('registers the emergency number to micaOS itself at boot', () => {
  expect(lookupLine('911')?.owner).toBe('mica');
  expect(lookupLine('911')?.blockable).toBe(false);
});

it('still exempts the emergency number when a real dispatcher holds it', async () => {
  bridgeMock.getPlayerByPhone.mockReturnValue({
    source: EMERGENCY_SRC,
    citizenid: CID_DISPATCH
  });
  isBlockedMock.mockResolvedValue(true);

  await placeCall(CALLER_SRC, '911');

  expect(isBlockedMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run server/__tests__/phone.test.ts` Expected: FAIL —
nothing holds `911`.

- [ ] **Step 3: Register it at boot**

At module scope in `server/services/Phone.ts`, after the emergency helpers:

```ts
/**
 * The emergency number, as the first registered line.
 *
 * Its only special behaviour was ever an exemption from the block check — "always connects"
 * meant "is never blockable", not that anybody was behind it. Expressing that as a line with
 * `blockable: false` removes the last place `Phone.ts` names the number, so a dispatch
 * resource re-registering it inherits the exemption instead of having to be special-cased
 * here too. No handler: until something registers one, a call to it still fails as
 * unreachable, exactly as before.
 */
registerNumber(
  emergencyNumber(),
  { onCall: () => ({ action: 'reject' }), blockable: false },
  GetCurrentResourceName()
);
```

Then confirm the emergency comparison in the dial path is **still there**:

```bash
grep -n "emergencyNumber()" server/services/Phone.ts
```

It must still appear in the `unblockable` expression. Deleting it is the one
thing this task must not do — see the ruling above.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run server/__tests__/phone.test.ts` Expected: PASS.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm typecheck:server
pnpm format
git add server/services/Phone.ts server/__tests__/phone.test.ts
git commit -m "MICA-226: make the emergency number a line, so Phone.ts stops naming it"
```

---

### Task 6: The three exports

**Files:**

- Modify: `server/lib/publicApi.ts`
- Modify: `server/__tests__/exports.test.ts`

**Interfaces:**

- Consumes: `registerNumber`, `unregisterNumber` (Tasks 1), `placeCall` (Task
  4).
- Produces: exports `RegisterNumber`, `UnregisterNumber`, `CreateCall`.

- [ ] **Step 1: Write the failing test**

In `server/__tests__/exports.test.ts`, add the three names to the pinned list
the suite already asserts, then add:

```ts
it('RegisterNumber attributes the line to the calling resource', () => {
  const register = publishedExport('RegisterNumber')!;
  const result = register('5551234', { onCall: () => ({ action: 'reject' }) });
  expect(result).toMatchObject({ ok: true });
  expect(lookupLine('5551234')?.owner).toBe('test-resource');
});

it('CreateCall refuses a source nobody is connected on', async () => {
  bridgeMock.getPlayer.mockReturnValue(undefined);
  const createCall = publishedExport('CreateCall')!;
  await expect(createCall(999, '5551234')).resolves.toMatchObject({
    ok: false,
    reason: 'unknown_player'
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run server/__tests__/exports.test.ts` Expected: FAIL —
the names are not published.

- [ ] **Step 3: Publish them**

In `registerPublicApi()` in `server/lib/publicApi.ts`:

```ts
/**
 * Own a phone number, and answer calls placed to it (MICA-226).
 *
 * The line belongs to the calling resource and is released when that resource stops, so a
 * script that crashes does not leave a number swallowing calls. `onCall` is a function ref
 * across the resource boundary: it may return `{ action: 'accept' | 'reject' }` or
 * `{ action: 'forward', source }`, synchronously or as a promise, and has five seconds.
 */
publish(
  'RegisterNumber',
  guarded('RegisterNumber', (number: unknown, options: unknown) =>
    registerNumber(number, options as LineOptions, GetInvokingResource())
  )
);

publish(
  'UnregisterNumber',
  guarded('UnregisterNumber', (number: unknown) =>
    unregisterNumber(number, GetInvokingResource())
  )
);

/** Start a call for a player, as a payphone or a dispatch pick-up would. */
publish(
  'CreateCall',
  guardedAsync('CreateCall', async (src: unknown, number: unknown) => {
    if (typeof src !== 'number' || !FrameworkBridge.getPlayer(src)) {
      return fail('unknown_player', 'That player is not connected.');
    }
    if (!phoneNumberFrom(number)) {
      return fail('invalid_args', 'A phone number is required.');
    }
    await placeCall(src, number);
    return ok();
  })
);
```

Add the imports this needs at the top of `publicApi.ts`:

```ts
import {
  registerNumber,
  unregisterNumber,
  type LineOptions
} from './numberRegistry';
import { placeCall } from '../services/Phone';
import { phoneNumberFrom } from './netGuard';
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run server/__tests__/exports.test.ts` Expected: PASS.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm typecheck:server
pnpm format
git add server/lib/publicApi.ts server/__tests__/exports.test.ts
git commit -m "MICA-226: publish RegisterNumber, UnregisterNumber and CreateCall"
```

---

### Task 7: Prove nothing became client-reachable, and close out

**Files:**

- Test: `server/__tests__/reachability.test.ts` (read only — must stay green)
- Test: `server/__tests__/eventNames.test.ts` (read only — must stay green)
- Delete: `docs/superpowers/specs/2026-09-05-registered-numbers-design.md`
- Delete: `docs/superpowers/plans/2026-09-05-registered-numbers.md`

- [ ] **Step 1: Confirm the client surface did not grow**

Run:
`pnpm exec vitest run server/__tests__/reachability.test.ts server/__tests__/eventNames.test.ts`
Expected: PASS, with **no snapshot or fixture updated**. This feature adds no
net events and no generic service actions; if either suite demands a change,
stop — something became reachable from a modified client and that was not the
design.

- [ ] **Step 2: Run every gate**

Run: `pnpm verify` Expected: exit 0. Report any failure with its output rather
than summarising.

- [ ] **Step 3: Remove the spec and this plan**

Both are in-flight documents, deleted on landing the way `10932ea4` removed the
Blabber design and plan docs.

```bash
git rm docs/superpowers/specs/2026-09-05-registered-numbers-design.md
git rm docs/superpowers/plans/2026-09-05-registered-numbers.md
```

- [ ] **Step 4: Commit — do NOT push**

```bash
pnpm format
git add -A
git commit -m "MICA-226: retire the registered-numbers design and plan, now that it has shipped"
```

**Controller ruling: the push is removed from this task.** The work is on the
`MICA-226` branch, so `git push origin dev` would move a shared branch from a
place it was never meant to move, and pushing anywhere is a decision for the
person who owns the repository rather than for an implementer finishing a task.
Commit and stop; the branch gets presented for merge separately.

- [ ] **Step 5: Say what was not verified**

In the Jira comment closing MICA-226, state plainly that no suite here proves
`onResourceStop` fires on a live server, that function refs survive the
cross-resource round trip, or that a forwarded call joins pma-voice. Those need
the game. Move the ticket to Testing rather than Done.
