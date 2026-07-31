import { defineServerApp, SchemaRepository } from '../lib/defineServerApp';
import { Photo } from '@shared/types';

/**
 * Photos: owner-scoped, create/read/delete only.
 *
 * `update` stays closed — a stored photo has no mutable fields, so an update
 * endpoint would be dead surface. `get` and `delete` come from the generic path:
 * get filters to status = 'active' by default, and delete is an ownership-scoped
 * soft delete that writes the audit entry.
 *
 * The repositoryFactory preserves the one piece of custom behaviour the
 * hand-written PhotoRepository had: depending on driver and column type, `image`
 * can come back as a Buffer, which would cross NUI as `{type:'Buffer',data:[...]}`
 * and render as nothing. Coerced to a string on the way out.
 */
export const photos = defineServerApp<Photo>({
  id: 'photos',
  scope: 'owner',
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    image: { type: 'mediumtext', notNull: true }
  },
  indexes: [['citizenid', 'status', 'created_at']],
  options: { disableUpdate: true },
  repositoryFactory: (resolved) =>
    new (class extends SchemaRepository<Photo> {
      async findAll(where: Partial<Photo> = {}): Promise<Photo[]> {
        return (await super.findAll(where)).map(coerceImage);
      }

      async findById(id: number | string, citizenid?: string): Promise<Photo | null> {
        const row = await super.findById(id, citizenid);
        return row ? coerceImage(row) : null;
      }
    })(resolved)
});

const coerceImage = (photo: Photo): Photo => {
  if (photo.image && typeof photo.image !== 'string') {
    photo.image = (photo.image as any).toString('utf8');
  }
  return photo;
};
