import { describe, it, expect } from 'vitest';
import { clientTransport } from './transport';

// MICA-16 step 4: `clientTransport()` used to throw when called before `bootAddOn()`
// (see boot.ts) had run `setClientTransport`. The addon-entry bundle imports the app's own
// module graph — and therefore evaluates any module-scope `useAppEvents(...).on(...)` call
// it makes (blabber/store.ts) — before `bootAddOn()` gets a chance to run, so a lazily
// created, cached transport is what lets that early call succeed instead of crashing boot.
// This file gets its own module instance (no other test in the suite has called
// `setClientTransport` against it), so `clientTransport()` here observes the "nothing set
// yet" state.

describe('clientTransport', () => {
  it('lazily creates one bound to window when none has been set, and reuses it', () => {
    const first = clientTransport();
    expect(first).toBeDefined();
    const second = clientTransport();
    expect(second).toBe(first);
  });
});
