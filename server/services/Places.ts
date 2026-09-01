// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository } from '../lib/defineService';
import { SavedPlace } from '@gphone/shared/types';
import { placesContract } from '@gphone/shared/contracts/places';
import { playerCoords } from '../lib/playerCoords';

const MAX_NAME_LENGTH = 100;
const MAX_STREET_LABEL_LENGTH = 255;

/**
 * Saved places (MICA-65): a name and a snapshot of where the player was standing when
 * they saved it, owned by citizenid like every other player-owned row.
 *
 * `x`/`y`/`z` are `clientWritable: false` and reached only by the custom `create` action
 * below, which resolves them from the caller's own live position the same way
 * `Media.ts`'s `shareLocation` does (`playerCoords`) — never accepted as client-reported
 * coordinates. That is what makes the generic `create` unusable here: it can only write
 * columns a payload actually names, and a place with no position is not a saved place.
 * `update`/`delete`/`get` stay fully generic — renaming a place or moving its
 * `street_label` never touches where it actually is.
 */
export class PlacesRepository extends SchemaRepository<SavedPlace> {
  /**
   * A named method rather than a service-level bypass (§2.9): `x`/`y`/`z` are
   * `clientWritable: false` precisely so no payload can reach them, and this is the one
   * place server-resolved coordinates are allowed to land. `super.create`, so the
   * identifier allowlist and ownership stamping the base class already does are not
   * duplicated here.
   */
  async addForPlayer(citizenid: string, item: Partial<SavedPlace>): Promise<number> {
    return await super.create({ ...item, citizenid } as Partial<SavedPlace>);
  }
}

export const places = defineService<SavedPlace, typeof placesContract>({
  contract: placesContract,
  id: 'places',
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    name: { type: 'string', length: MAX_NAME_LENGTH, notNull: true },
    street_label: { type: 'string', length: MAX_STREET_LABEL_LENGTH },
    x: { type: 'float', clientWritable: false },
    y: { type: 'float', clientWritable: false },
    z: { type: 'float', clientWritable: false }
  },
  // No extra indexes: `citizenid_status` is already emitted for every primary table, and
  // that is the only shape a saved-places list is ever queried by.
  // Custom `create` only — `x`/`y`/`z` have to be resolved server-side, and the generic
  // path can only write columns a payload names. `get`/`update`/`delete` fit the generic
  // owner-scoped shape exactly, the same as Contacts and Notes.
  options: { disableCreate: true },
  repositoryFactory: (resolved) => new PlacesRepository(resolved)
});

const app = places.app;
const repo = places.repo as PlacesRepository;

/**
 * Save the caller's current position under a name. The route table calls this action
 * `create` (`shared/routes.ts`'s `route('createSavedPlace', 'places', 'create')`), so the
 * generic `create` being disabled above is what makes this registration legal rather than
 * a collision — `ServiceEndpoint` never wires the generic one when `disableCreate` is set.
 */
app.registerEvent('create', async (source, cbId, data, citizenid) => {
  // Trimmed, not capped: the contract already refused anything over the column's length, so
  // trimming here can only ever shorten a name that already fits.
  const name = data.name.trim();
  if (!name) throw new PlayerFacingError('A name is required.');

  // Cosmetic display text only, the same trust level `shareLocation`'s own `label`
  // carries — never resolved against anything, never used to authorize a read.
  const streetLabel = data.street_label?.trim() || undefined;

  const coords = playerCoords(source);
  if (!coords) throw new PlayerFacingError('Could not determine your location.');
  const [x, y, z] = coords;

  // `street_label` only when actually sent, rather than as an explicit `undefined` —
  // `Repository.create` builds its column list from `Object.keys`, which cannot tell an
  // omitted key from one set to `undefined`, and an `undefined` bind parameter is a
  // driver error rather than the SQL NULL an unset label needs.
  const id = await repo.addForPlayer(citizenid, {
    name,
    ...(streetLabel ? { street_label: streetLabel } : {}),
    x,
    y,
    z
  } as Partial<SavedPlace>);

  return { id, place: await repo.findById(id, citizenid) };
});
