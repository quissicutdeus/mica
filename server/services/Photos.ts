import { defineService, SchemaRepository } from '../lib/defineService';
import { MediaItem } from '@shared/types';
import { findNearbyVisiblePlayers } from '../lib/proximity';
import { appEventChannel } from '../lib/appEvents';
import { requirePositiveInt, fields } from '../lib/payload';

/**
 * The media table: owner-scoped, create/read/delete only.
 *
 * **The table is `gphone_media`; the service and app id stay `photos`.** That split is
 * deliberate. An id is a key — it is the directory name, the per-app storage namespace,
 * the `<app>` segment of every event, the `?app=photos` deep link and the launcher label —
 * so renaming one is a data migration (§11.1). A table name is not a key to anything
 * outside SQL, so the `table:` override moves it for free.
 *
 * (That namespace is spelled out in words rather than as a literal on purpose:
 * `eventNames.test.ts` scans source for event-shaped string literals and cannot tell prose
 * from a real name, so writing one here reads as a malformed event.)
 *
 * The rename is a **consequence** of needing more than one storage shape, not a tidying
 * exercise. The old table had exactly one payload column, `image mediumtext` holding
 * base64, which can only ever be a photo — and that is what blocked voice clips, video
 * with a poster frame, GIFs by URL, RCS-style file transfer and link previews.
 *
 * `data` rather than `image` for the same reason: the column will hold base64 audio and
 * video, and the old name becomes a lie the moment the table earns its own. It is also
 * **nullable** now, where `image` was `notNull` — a `link` or a hotlinked `gif` row has a
 * `url` and no bytes at all.
 *
 * `update` stays closed. Stored media has no mutable fields, so an update endpoint would
 * be dead surface. `get` and `delete` come from the generic path: get filters to
 * status = 'active', and delete is an ownership-scoped soft delete that writes the audit
 * entry.
 */
export const photos = defineService<MediaItem>({
  id: 'photos',
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
      values: ['photo', 'video', 'audio', 'gif', 'sticker', 'file', 'link'],
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

const app = photos.app;
const repo = photos.repo;

/**
 * Bluetooth proximity drop: copy one of the caller's own media rows to everyone nearby
 * and Bluetooth-visible.
 *
 * A custom `registerEvent` action rather than a raw `onNet` handler — reached through the
 * named `sharePhotoNearby` route (`shared/routes.ts`), so `ServiceEndpoint`'s own rate
 * limiting and citizenid resolution already cover it, and its return value becomes the
 * NUI response directly (§10's `BlabberDms.ts` `send` action is the worked example of
 * this shape).
 *
 * `findById(mediaId, citizenid)` is the ownership check (§2.9) — a `mediaId` naming a row
 * the caller does not own resolves to `null` and the whole request is refused before
 * anything nearby is even computed. Each recipient gets a **copy**, not a shared
 * reference: gPhone's gallery is owned per player, and the sender deleting their photo
 * later must not delete anyone else's.
 */
app.registerEvent('drop', async (source, _cbId, data, citizenid) => {
  const mediaId = requirePositiveInt(fields(data).mediaId, 'mediaId');

  const owned = await repo.findById(mediaId, citizenid);
  if (!owned) throw new Error('That photo could not be found.');

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

    const outcome = appEventChannel('photos').push(
      target.citizenid,
      'media_received',
      {},
      {
        notify: { title: 'Media received', message: 'A nearby phone sent you a photo.' }
      }
    );
    if (!outcome.delivered && outcome.reason !== 'offline') {
      console.error(
        `[photos] mediaReceived push to ${target.citizenid} was refused: ${outcome.reason}.`
      );
    }
  }

  return { count };
});
