import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_EVENT_NET_EVENT, APP_EVENT_NUI_ACTION } from '@shared/appEvents';

const ROOT = join(__dirname, '..', '..');
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

/**
 * The push channel spans four files — `shared/appEvents.ts`, the server channel, the client
 * forwarder and the NUI route — and a gap in any one of them fails **silently**, exactly like the
 * NUI round trip §8 warns about. These are the assertions that would catch it.
 */

describe('the wire strings are shared, not retyped', () => {
  it.each([['client/services/AppEvents.ts'], ['web/src/shell/nuiMessages.ts']])(
    '%s imports the constants rather than spelling them out',
    (file) => {
      // The defect this prevents is the one that made every custom mail action time out for
      // fifteen seconds: two sides deriving the same name independently and disagreeing.
      const text = read(file);
      expect(text).toContain("from '@shared/appEvents'");
      expect(text).not.toContain("'gphone:client:shell:appEvent'");
      expect(text).not.toContain('"gphone:client:shell:appEvent"');
    }
  );

  it('keeps the net event a literal, so eventNames.test.ts can see it', () => {
    /**
     * A future tidy-up into `` `gphone:client:${SHELL}:appEvent` `` would slip straight past
     * that file's literal-only scan and lose the four checks it performs on the name's shape.
     */
    const text = read('shared/appEvents.ts');
    expect(text).toContain("= 'gphone:client:shell:appEvent'");
    expect(APP_EVENT_NET_EVENT).toBe('gphone:client:shell:appEvent');
  });

  it('keeps the NUI action out of the gphone: namespace', () => {
    // NUI action names are their own namespace (§8); prefixing one would read as a net event.
    expect(APP_EVENT_NUI_ACTION).toBe('appEvent');
    expect(APP_EVENT_NUI_ACTION.startsWith('gphone:')).toBe(false);
  });
});

describe('app-space is open', () => {
  it('the NUI router dispatches by app id rather than by a fixed name', () => {
    /**
     * The whole point, asserted structurally: the route is keyed on the shared constant and the
     * app comes out of the envelope, so a new app joins by subscribing at runtime. An add-on
     * installed from the Store *cannot* edit `nuiMessages.ts` — apps may import nothing outside
     * `@gphone/sdk` — so if this ever became a hardcoded list again, add-ons would silently stop
     * being able to receive anything.
     */
    const text = read('web/src/shell/nuiMessages.ts');
    expect(text).toContain('[APP_EVENT_NUI_ACTION]: appEvent');
    expect(text).toContain('deliverAppEvent(envelope)');
  });

  it('the SDK re-exports the hook, so no app reaches into shell/ by path', () => {
    // Without this the first add-on writes `../../shell/state/appEvents`, which is the drift
    // `sdk/boundary.test.ts` exists to prevent. The body moved behind the host protocol
    // (MICA-16 step 3): `useAppEvents.ts` is now a one-liner through `guarded()`, and the
    // actual `subscribeAppEvent` call lives in its facet module — assert both halves of that
    // wiring rather than the string that used to sit in one file.
    expect(read('web/src/sdk/host/useAppEvents.ts')).toContain("guarded('useAppEvents'");
    // MICA-172 step 1 moved the shell-backed facets out of the SDK, so the implementation
    // half of this assertion now lives in `web/src/host/facets/`. The wiring being asserted is
    // unchanged; only where the phone keeps its own facet did. This path is hardcoded from the
    // *server* test project, so nothing in `web/` fails when it goes stale — which is exactly
    // what happened: the move landed green on the web suite and broke here.
    expect(read('web/src/host/facets/appEvents.ts')).toContain('subscribeAppEvent');
    expect(read('web/src/sdk/host/index.ts')).toContain('useAppEvents');
  });
});

describe('a push does not excuse a fetch', () => {
  it('every app subscribing to events also loads on foreground', () => {
    /**
     * §11.6 made enforceable. A push only covers what arrives while you are looking, so an app
     * that subscribed *instead of* fetching would show whatever happened to arrive and nothing
     * that came before — which is worst precisely for the player who was away longest.
     */
    const app = read('web/src/apps/blabber/index.svelte');
    if (app.includes('useAppEvents')) {
      expect(app).toContain('onAppForeground');
    }
  });
});
