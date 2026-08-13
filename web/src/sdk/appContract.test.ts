import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppComponent } from './manifest';
import { bundledAddOns, registeredApps } from '../shell/state/registry';

import Admin from '../apps/admin/index.svelte';
import Bank from '../apps/bank/index.svelte';
import Blabber from '../apps/blabber/index.svelte';
import Calculator from '../apps/calculator/index.svelte';
import Camera from '../apps/camera/index.svelte';
import Contacts from '../apps/contacts/index.svelte';
import Mail from '../apps/mail/index.svelte';
import Messages from '../apps/messages/index.svelte';
import Media from '../apps/media/index.svelte';
import Notes from '../apps/notes/index.svelte';
import Phone from '../apps/phone/index.svelte';
import Settings from '../apps/settings/index.svelte';
import Store from '../apps/store/index.svelte';

/**
 * Every app really is an `AppComponent`.
 *
 * The annotation below is the whole point — it is a typecheck, not a runtime one, and it
 * fails `pnpm typecheck` if any app demands a prop the shell does not pass.
 *
 * It has to be written out by hand, because the registry loads apps with
 * `import.meta.glob` and that types its result by *assertion*: Vite cannot know what those
 * modules export, so `Record<string, AppComponent>` there is a promise rather than a check.
 * Typing the registry alone proved nothing — an app declaring a required extra prop still
 * passed. An explicit import is the only thing TypeScript can actually verify.
 *
 * The test below is what stops the list going stale, which is the usual fate of a
 * hand-maintained one — see §4.3 on the two lists nothing checks.
 */
const APPS: Record<string, AppComponent> = {
  admin: Admin,
  bank: Bank,
  blabber: Blabber,
  calculator: Calculator,
  camera: Camera,
  contacts: Contacts,
  mail: Mail,
  media: Media,
  messages: Messages,
  notes: Notes,
  phone: Phone,
  settings: Settings,
  store: Store
};

const APPS_DIR = join(__dirname, '..', 'apps');

describe('app component contract', () => {
  it('covers every app in apps/', () => {
    // A new app added to `apps/` is otherwise never checked against `AppProps`, and would
    // be discovered by the shell at runtime having never been near a typechecker.
    const onDisk = readdirSync(APPS_DIR)
      .filter((entry) => statSync(join(APPS_DIR, entry)).isDirectory())
      .sort();

    expect(Object.keys(APPS).sort(), 'add the new app to APPS above').toEqual(onDisk);
  });

  it('preloads every badge it draws', () => {
    // The badge-staleness rule, made mechanical. `bootstrap.ts` used to name each store by
    // hand with nothing tying that list to the apps it loaded for, so an app shipping a
    // `badgeStore` and forgotten there showed a stale count until somebody opened it — the
    // one moment a badge has stopped being useful. Declaring `preload` in the manifest is
    // what makes "forgotten" impossible; this is what makes it checkable.
    const unpreloaded = [...registeredApps, ...bundledAddOns]
      .filter((app) => app.badgeStore && !app.preload)
      .map((app) => app.id);

    expect(unpreloaded, 'declare preload alongside badgeStore').toEqual([]);
  });

  it('gives every app the same way out', () => {
    // `onback` is required, so this is really a statement about all of them at once: the
    // shell passes it on every render, and no app may make it optional and then guard
    // against a case that cannot happen.
    for (const [id, App] of Object.entries(APPS)) {
      expect(App, `${id} does not export a component`).toBeTypeOf('function');
    }
  });
});
