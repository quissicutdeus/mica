import { defineService, SchemaRepository } from '../lib/defineService';
import { MediaItem } from '@shared/types';
import { findNearbyVisiblePlayers } from '../lib/proximity';
import { appEventChannel } from '../lib/appEvents';
import { requirePositiveInt, fields } from '../lib/payload';
import { playerCoords } from '../lib/playerCoords';

/**
 * The media table: owner-scoped, create/read/delete only.
 *
 * **The table, the service and the app id are all `media` now.** They were not always in
 * agreement — the table moved off `gphone_photos` first, to `gphone_media`, while the
 * service/app id stayed `photos` because an id is a key: it is the directory name, the
 * per-app storage namespace, the `<app>` segment of every event, the `?app=` deep link and
 * the launcher label, so renaming it is a bigger change than renaming a table (§11.1). That
 * gap is what this second pass closes — the id finishing the same rename the table already
 * made, rather than three names for one thing settling into two.
 *
 * (That namespace is spelled out in words rather than as a literal on purpose:
 * `eventNames.test.ts` scans source for event-shaped string literals and cannot tell prose
 * from a real name, so writing one here reads as a malformed event.)
 *
 * The table rename was a **consequence** of needing more than one storage shape, not a
 * tidying exercise. The old table had exactly one payload column, `image mediumtext`
 * holding base64, which can only ever be a photo — and that is what blocked voice clips,
 * video with a poster frame, GIFs by URL, RCS-style file transfer, link previews and now a
 * shared location.
 *
 * `data` rather than `image` for the same reason: the column holds base64 audio and video
 * too, and the old name would be a lie the moment the table earned its own. It is also
 * **nullable** now, where `image` was `notNull` — a `link` or a hotlinked `gif` row has a
 * `url` and no bytes at all.
 *
 * `update` stays closed. Stored media has no mutable fields, so an update endpoint would
 * be dead surface. `get` and `delete` come from the generic path: get filters to
 * status = 'active', and delete is an ownership-scoped soft delete that writes the audit
 * entry.
 */
export const media = defineService<MediaItem>({
  id: 'media',
  table: 'gphone_media',
  reportable: { label: 'Photo', previewColumn: 'data' },
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    /**
     * Deliberately over-provisioned, and this is the one decision here that cannot be
     * deferred. `SchemaMigrator` is additive-only: widening an enum is a type change, so
     * it is printed for a human and never applied (§8). Every value left out now costs a
     * second hand-written migration against a bigger table, so they all go in at once
     * even though this pass writes only `photo`.
     */
    kind: {
      type: 'enum',
      values: ['photo', 'video', 'audio', 'gif', 'sticker', 'file', 'link', 'location'],
      notNull: true,
      default: 'photo'
    },
    /**
     * Base64 for locally captured media. Was `image`.
     *
     * `kind` and `data` are the only two columns a client may write, and every other one
     * is `clientWritable: false` — not because they are dangerous today but because
     * nothing writes them today. A column the client can set before any feature needs it
     * is surface with no caller to constrain it (§2.9). Flip one when the feature that
     * fills it arrives, which is a one-line, reviewable change.
     */
    data: { type: 'mediumtext' },
    /** Hotlinks — a remote GIF or video that is not ours to store. */
    url: { type: 'string', length: 512, clientWritable: false },
    /** Poster frame for video and GIF, so a feed has something before the media loads. */
    thumbnail: { type: 'mediumtext', clientWritable: false },
    mime_type: { type: 'string', length: 64, clientWritable: false },
    /** Reserve layout space, so a feed does not reflow as media arrives. */
    width: { type: 'int', clientWritable: false },
    height: { type: 'int', clientWritable: false },
    duration_ms: { type: 'int', clientWritable: false },
    byte_size: { type: 'int', clientWritable: false },
    /** Accessibility, and what RCS carries alongside an attachment. */
    alt_text: { type: 'string', length: 255, clientWritable: false }
  },
  indexes: [{ name: 'citizenid_status_created', columns: ['citizenid', 'status', 'created_at'] }],
  options: { disableUpdate: true },
  /**
   * Depending on driver and column type, a `mediumtext` can come back as a Buffer — which
   * would cross NUI as `{type:'Buffer',data:[...]}` and render as nothing. Coerced to a
   * string on the way out.
   *
   * `thumbnail` is coerced alongside `data` because it is the same column type and would
   * fail the same way; it is empty today, so this is the cheapest moment to get it right.
   */
  repositoryFactory: (resolved) =>
    new (class extends SchemaRepository<MediaItem> {
      /**
       * Write a row on a player's behalf, from the server.
       *
       * A **named** method rather than a service-level bypass (§2.9): the columns it sets
       * are `clientWritable: false` precisely so no payload can reach them, and the way
       * to write one anyway is a method that says what it is for. The only caller is the
       * `AddMedia` export, which is how an external resource gets a GIF, a video poster
       * or a voice clip into a player's gallery — the camera can only ever produce a
       * `photo`.
       */
      async addForPlayer(citizenid: string, item: Partial<MediaItem>): Promise<number> {
        return await this.create({ ...item, citizenid } as Partial<MediaItem>);
      }

      async findAll(where: Partial<MediaItem> = {}): Promise<MediaItem[]> {
        return (await super.findAll(where)).map(coerceBinaryText);
      }

      async findById(id: number | string, citizenid?: string): Promise<MediaItem | null> {
        const row = await super.findById(id, citizenid);
        return row ? coerceBinaryText(row) : null;
      }
    })(resolved)
});

const coerceBinaryText = (item: MediaItem): MediaItem => {
  if (item.data && typeof item.data !== 'string') {
    item.data = (item.data as any).toString('utf8');
  }
  if (item.thumbnail && typeof item.thumbnail !== 'string') {
    item.thumbnail = (item.thumbnail as any).toString('utf8');
  }
  return item;
};

const app = media.app;
const repo = media.repo;

/**
 * Bluetooth proximity drop: copy one of the caller's own media rows to everyone nearby
 * and Bluetooth-visible.
 *
 * A custom `registerEvent` action rather than a raw `onNet` handler — reached through the
 * named `shareMediaNearby` route (`shared/routes.ts`), so `ServiceEndpoint`'s own rate
 * limiting and citizenid resolution already cover it, and its return value becomes the
 * NUI response directly (§10's `BlabberDms.ts` `send` action is the worked example of
 * this shape).
 *
 * `findById(mediaId, citizenid)` is the ownership check (§2.9) — a `mediaId` naming a row
 * the caller does not own resolves to `null` and the whole request is refused before
 * anything nearby is even computed. Each recipient gets a **copy**, not a shared
 * reference: gPhone's gallery is owned per player, and the sender deleting their photo
 * later must not delete anyone else's.
 *
 * `findById` scopes by owner but not by `status` — it is the primitive `findById(id,
 * citizenid?)` on `Repository`, and nothing about it knows this table has a moderation
 * state. Without the explicit check below, a photo a moderator had already pulled from
 * every read (`status = 'moderated'`) — or one its own owner had deleted — was still
 * reachable by its id and would go right back out to nearby players, the same hole
 * `access.editWindow`'s `status != 'moderated'` predicate closes on the write side.
 */
app.registerEvent('drop', async (source, _cbId, data, citizenid) => {
  const mediaId = requirePositiveInt(fields(data).mediaId, 'mediaId');

  const owned = await repo.findById(mediaId, citizenid);
  if (!owned || owned.status !== 'active') throw new Error('That photo could not be found.');

  const nearby = await findNearbyVisiblePlayers(source, citizenid);

  let count = 0;
  for (const target of nearby) {
    await repo.create({
      citizenid: target.citizenid,
      kind: owned.kind,
      data: owned.data,
      url: owned.url,
      thumbnail: owned.thumbnail,
      mime_type: owned.mime_type,
      width: owned.width,
      height: owned.height,
      duration_ms: owned.duration_ms,
      byte_size: owned.byte_size,
      alt_text: owned.alt_text
    } as Partial<MediaItem>);
    count += 1;

    const outcome = appEventChannel('media').push(
      target.citizenid,
      'media_received',
      {},
      {
        notify: { title: 'Media received', message: 'A nearby phone sent you a photo.' }
      }
    );
    if (!outcome.delivered && outcome.reason !== 'offline') {
      console.error(
        `[media] mediaReceived push to ${target.citizenid} was refused: ${outcome.reason}.`
      );
    }
  }

  return { count };
});

/**
 * Share the caller's current in-game position as a message attachment.
 *
 * The coordinates never come from `data` — only `playerCoords(source)` does, the same
 * guarded `GetPlayerPed`/`DoesEntityExist`/`GetEntityCoords` read `Signal.ts` and
 * `proximity.ts` already trust for a player's live position. A client-reported
 * coordinate would be exactly the failure the roadmap's Battery correction already named:
 * a value with real stakes (this is what a recipient's waypoint points at) accepted from
 * self-report instead of read independently.
 *
 * `label` is the one thing actually trusted from the payload, and deliberately: the
 * street name it names can only be resolved by a client-only native
 * (`GetStreetNameAtCoord`/`GetStreetNameFromHashKey` do not exist server-side), so it is
 * resolved on the sender's own client and carried here as cosmetic display text — the
 * same trust level as a contact name or a message body, never as anything the waypoint's
 * actual target depends on. Bounded to `alt_text`'s own 255-char column length here,
 * since a custom action is not covered by `assertWritableValue`'s per-column rules the
 * way generic CRUD is.
 *
 * `addForPlayer` (the same privileged bypass `AddMedia` uses) rather than the ordinary
 * client-writable path, because `data` and `alt_text` here are both server-determined —
 * a location row's `data` is never something the client itself should be free to set.
 */
app.registerEvent('shareLocation', async (source, _cbId, data, citizenid) => {
  const rawLabel = fields(data).label;
  const label =
    typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim().slice(0, 255) : undefined;

  const coords = playerCoords(source);
  if (!coords) throw new Error('Could not determine your location.');
  const [x, y, z] = coords;

  const privileged = repo as unknown as {
    addForPlayer(citizenid: string, item: Partial<MediaItem>): Promise<number>;
  };
  const id = await privileged.addForPlayer(citizenid, {
    kind: 'location',
    data: JSON.stringify({ x, y, z }),
    alt_text: label
  } as Partial<MediaItem>);

  return { id, media: await repo.findById(id, citizenid) };
});
