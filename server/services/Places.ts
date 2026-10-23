// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository } from '../lib/defineService';
import { SavedPlace } from '@mica/shared/types';
import { placesContract } from '@mica/shared/contracts/places';
import { playerCoords } from '../lib/playerCoords';

const MAX_NAME_LENGTH = 100;
const MAX_STREET_LABEL_LENGTH = 255;
/**
 * `{"x":…,"y":…,"z":…}`: three doubles at their longest, seventeen significant digits, a sign
 * and an exponent each, and the punctuation, with room.
 */
const POSITION_MAX = 96;

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
/**
 * A saved place as stored: its coordinates are one sealed `position` (MICA-432), a JSON object
 * of `x`, `y` and `z`, rather than three readable floats.
 */
type StoredPlace = Omit<SavedPlace, 'x' | 'y' | 'z'> & { position?: string | null };

/** The coordinates as stored: three finite numbers, as JSON. */
export const positionOf = (x: number, y: number, z: number): string => JSON.stringify({ x, y, z });

/**
 * A stored row as the wire has always carried it: `x`, `y` and `z`, opened out of `position`.
 * A position that does not read — the padlock of one that would not open, or anything else —
 * reads as no position, `null` each, and the place is still listed by its name.
 */
const toPlace = (row: StoredPlace): SavedPlace => {
  const { position, ...rest } = row;
  let point: { x?: unknown; y?: unknown; z?: unknown } = {};
  try {
    point = typeof position === 'string' ? (JSON.parse(position) as typeof point) : {};
  } catch {
    point = {};
  }
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    ...rest,
    x: number(point.x),
    y: number(point.y),
    z: number(point.z)
  } as unknown as SavedPlace;
};

export class PlacesRepository extends SchemaRepository<SavedPlace> {
  /** The generic read, with `position` opened out into `x`, `y` and `z` (MICA-432). */
  override async findAll(
    where: Partial<SavedPlace> = {},
    page?: { limit?: number; cursor?: number },
    projection?: readonly string[]
  ): Promise<SavedPlace[]> {
    const rows = await super.findAll(where, page, projection);
    return (rows as unknown as StoredPlace[]).map(toPlace);
  }

  override async findById(
    id: number | string,
    citizenid?: string,
    deviceId?: string
  ): Promise<SavedPlace | null> {
    const row = await super.findById(id, citizenid, deviceId);
    return row ? toPlace(row as unknown as StoredPlace) : null;
  }

  override async findDeleted(
    citizenid: string,
    windowDays: number,
    projection?: readonly string[],
    deviceId?: string
  ): Promise<SavedPlace[]> {
    const rows = await super.findDeleted(citizenid, windowDays, projection, deviceId);
    return (rows as unknown as StoredPlace[]).map(toPlace);
  }

  /**
   * A named method rather than a service-level bypass (§2.9): `x`/`y`/`z` are
   * `clientWritable: false` precisely so no payload can reach them, and this is the one
   * place server-resolved coordinates are allowed to land. `super.create`, so the
   * identifier allowlist and ownership stamping the base class already does are not
   * duplicated here.
   */
  async addForPlayer(
    citizenid: string,
    deviceId: string,
    item: Partial<SavedPlace>
  ): Promise<number> {
    const { x, y, z, ...rest } = item;
    // The coordinates go in as one sealed `position` (MICA-432), never as three columns.
    const stored: Partial<StoredPlace> = {
      ...rest,
      citizenid,
      device_id: deviceId,
      position: positionOf(Number(x), Number(y), Number(z))
    };
    return await super.create(stored as unknown as Partial<SavedPlace>);
  }
}

export const places = defineService<SavedPlace, typeof placesContract>({
  contract: placesContract,
  deviceOwned: true,
  id: 'places',
  app: 'places',
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  /**
   * The name, the street and where the place is are sealed at rest (MICA-431, MICA-432), bound
   * to the phone. The coordinates are one `position`, a JSON object of `x`, `y` and `z`: three
   * readable floats were where a player has been, to anyone with the database. The wire still
   * carries `x`, `y` and `z` (`PlacesRepository`). `0014_private_lookups_get_blind_indexes`
   * moved existing rows' coordinates into it and dropped the three columns.
   */
  encryptionScope: [],
  schema: {
    name: {
      type: 'string',
      length: MAX_NAME_LENGTH,
      notNull: true,
      encrypted: true,
      versioned: true
    },
    street_label: {
      type: 'string',
      length: MAX_STREET_LABEL_LENGTH,
      encrypted: true,
      versioned: true
    },
    position: {
      type: 'string',
      length: POSITION_MAX,
      clientWritable: false,
      encrypted: true,
      ascii: true,
      versioned: true
    }
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
app.registerEvent('create', async (source, cbId, data, citizenid, _player, deviceId) => {
  // Trimmed, not capped: the contract already refused anything over the column's length, so
  // trimming here can only ever shorten a name that already fits.
  const name = data.name.trim();
  if (!name)
    throw new PlayerFacingError('A name is required.', { key: 'server.places.nameRequired' });

  // Cosmetic display text only, the same trust level `shareLocation`'s own `label`
  // carries — never resolved against anything, never used to authorize a read.
  const streetLabel = data.street_label?.trim() || undefined;

  const coords = playerCoords(source);
  if (!coords)
    throw new PlayerFacingError('Could not determine your location.', {
      key: 'server.places.noLocation'
    });
  const [x, y, z] = coords;

  // `street_label` only when actually sent, rather than as an explicit `undefined` —
  // `Repository.create` builds its column list from `Object.keys`, which cannot tell an
  // omitted key from one set to `undefined`, and an `undefined` bind parameter is a
  // driver error rather than the SQL NULL an unset label needs.
  // A device-owned service always has one; the endpoint refused the request otherwise.
  const id = await repo.addForPlayer(
    citizenid,
    deviceId as string,
    {
      name,
      ...(streetLabel ? { street_label: streetLabel } : {}),
      x,
      y,
      z
    } as Partial<SavedPlace>
  );

  return { id, place: await repo.findById(id, citizenid, deviceId) };
});
