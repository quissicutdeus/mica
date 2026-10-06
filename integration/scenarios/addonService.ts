// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An add-on's server half, registered from another resource (MICA-308).
 *
 * The declaration is built with `defineAddonService`, imported from micaOS's source as an
 * add-on author's resource would import it, rather than restated the way `lib/mica.ts` restates
 * the export outcome: the helper and its types are the thing an author uses, so they are part
 * of what is under test here. `pnpm typecheck:integration` compiles this file, which makes the
 * type assertions below the compiled proof that a declaration's types infer.
 */

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { assert, expectOk, expectRefusal, seedCitizen } from '../lib/mica';
import { eventually } from '../lib/wait';
import {
  addonError,
  addonOutput,
  defineAddonService,
  type AddonActionInput,
  type AddonActionOutput,
  type AddonHandlers,
  type AddonServiceDeclaration
} from '../../shared/addonService';

interface Entry {
  id: number;
  title: string;
}

const journal = defineAddonService({
  id: 'itx_journal',
  actions: {
    create: {
      input: {
        title: { type: 'string', min: 1, max: 80 },
        body: { type: 'string', max: 2000, optional: true },
        mood: { type: 'enum', values: ['calm', 'busy'], nullable: true },
        tags: { type: 'array', of: { type: 'string', max: 16 }, max: 4, optional: true },
        pinned: { type: 'boolean' },
        rating: { type: 'integer', min: 0, max: 5 },
        weight: { type: 'number', optional: true }
      },
      output: addonOutput<Entry>()
    },
    list: { input: {}, output: addonOutput<Entry[]>() }
  }
});

// --- Compile-time proof: these lines fail `tsc` if inference regresses ------------------------

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const holds = <T extends true>(): T | undefined => undefined;

holds<
  Equal<
    AddonActionInput<typeof journal, 'create'>,
    {
      title: string;
      body?: string;
      mood: 'calm' | 'busy' | null;
      tags?: string[];
      pinned: boolean;
      rating: number;
      weight?: number;
    }
  >
>();
holds<Equal<AddonActionInput<typeof journal, 'list'>, {}>>();
holds<Equal<AddonActionOutput<typeof journal, 'create'>, Entry>>();
holds<Equal<AddonActionOutput<typeof journal, 'list'>, Entry[]>>();

const typedHandlers: AddonHandlers<typeof journal> = {
  create: (_citizenid, input) => {
    // @ts-expect-error `body` is optional, so it may be undefined.
    const body: string = input.body;
    // @ts-expect-error not a declared field.
    void input.citizenid;
    return input.title.length > 0 ? { id: 1, title: input.title + body } : addonError('Empty.');
  },
  list: async () => [{ id: 1, title: 'a' }]
};

// @ts-expect-error a handler for every declared action, and `list` is missing.
const missingHandler: AddonHandlers<typeof journal> = { create: () => ({ id: 1, title: '' }) };
void missingHandler;

void ({
  id: 'itx_typed',
  // @ts-expect-error a string must declare `max`.
  actions: { a: { input: { t: { type: 'string' } } } }
} satisfies AddonServiceDeclaration);

// --- The scenario ------------------------------------------------------------------------------

/**
 * What this proves, and what it cannot.
 *
 * This resource is a resource other than `mica`, so every call here crosses the export boundary
 * as an add-on's own resource would: the declaration as msgpack data, the handlers as function
 * refs into this resource, and `GetInvokingResource()` naming this resource as the owner.
 * Registration, its refusals, re-registration, `PushToApp` with a persisted toast for an
 * offline character, and release all run in the real runtime.
 *
 * **The guarded call itself does not run here.** `mica:server:<id>:<action>` authenticates the
 * caller before it parses or calls anything, and no player ever connects to the harness, so a
 * call emitted from here would stop at "Player not authenticated" and answer a client that does
 * not exist. `addonServices.test.ts` drives that path through the real `ServiceEndpoint` handler
 * instead; proving it in-server waits for a harness that can connect a client (MICA-304).
 */
export const addonServiceScenarios: Scenario[] = [
  {
    id: 'addon-service-registers-pushes-and-releases',
    tickets: ['MICA-308'],
    run: async (signal) => {
      const who = await seedCitizen('addon_push');

      await expectRefusal(
        'invalid_args',
        'RegisterService',
        { ...journal, id: 'contacts' },
        typedHandlers
      );
      await expectRefusal('invalid_args', 'RegisterService', journal, {
        create: typedHandlers.create
      });
      await expectRefusal(
        'invalid_args',
        'RegisterService',
        { id: journal.id, actions: { a: {} } },
        {
          a: () => null
        }
      );
      // Nobody holds it yet, so a push is refused as not this resource's to make.
      await expectRefusal('not_owner', 'PushToApp', journal.id, who.citizenid, 'entry_added', {});

      await expectOk('RegisterService', journal, typedHandlers);
      try {
        // Again from the same resource replaces, rather than conflicting with itself.
        await expectOk('RegisterService', journal, typedHandlers);

        await expectRefusal(
          'invalid_args',
          'PushToApp',
          journal.id,
          who.citizenid,
          'Entry-Added',
          {}
        );
        const pushed = await expectOk<{ delivered: string[]; offline: string[] }>(
          'PushToApp',
          journal.id,
          [who.citizenid],
          'entry_added',
          { id: 1 },
          { message: 'A new journal entry', title: 'Journal' }
        );
        assert(
          pushed.delivered.length === 0 && pushed.offline[0] === who.citizenid,
          `PushToApp answered ${JSON.stringify(pushed)} for an offline character`
        );
        await eventually(
          async () =>
            (await db.count(
              'SELECT COUNT(*) FROM `mica_notifications` WHERE `citizenid` = ? AND `app` = ? AND `body` = ?',
              [who.citizenid, journal.id, 'A new journal entry']
            )) || null,
          5_000,
          signal,
          "the add-on push's persisted notification"
        );
      } finally {
        await expectOk('UnregisterService', journal.id);
      }

      await expectRefusal('invalid_args', 'UnregisterService', journal.id);
      await expectRefusal('not_owner', 'PushToApp', journal.id, who.citizenid, 'entry_added', {});
    }
  }
];
