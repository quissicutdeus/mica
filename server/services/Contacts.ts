import { defineService, SchemaRepository } from '../lib/defineService';
import { Contact } from '@shared/types';

/**
 * Contacts: owner-scoped address book, all four generic CRUD actions.
 *
 * `phone` and `favorite` are the only filterable fields — the address-book UI
 * looks contacts up by number and filters the favourites list. Nothing else needs
 * to be, and every filterable column is one more thing a client can probe.
 */
export const contacts = defineService<Contact>({
  id: 'contacts',
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    firstname: { type: 'string', length: 50, notNull: true },
    lastname: { type: 'string', length: 50 },
    phone: { type: 'string', length: 20, notNull: true, clientFilterable: true },
    email: { type: 'string', length: 100 },
    // Base64 image data. Blob rather than text to match the existing table.
    avatar: 'blob',
    favorite: { type: 'bool', default: 0, clientFilterable: true }
  },
  indexes: [
    { name: 'phone', columns: ['phone'] },
    { name: 'citizenid_phone', columns: ['citizenid', 'phone'] },
    { name: 'citizenid_favorite', columns: ['citizenid', 'favorite', 'status'] }
  ],
  /**
   * `addForPlayer` is what makes the `AddContact` export possible — a job handing out a
   * dispatch number writes on the player's behalf, which the generic owner-scoped create
   * cannot do because there is no NUI request to scope it to. Same pattern as
   * `Photos.ts`'s `addForPlayer`: a named method rather than a service-level bypass (§2.9),
   * so the columns it sets are exactly the ones a contact needs and nothing wider opens up.
   */
  repositoryFactory: (resolved) =>
    new (class extends SchemaRepository<Contact> {
      async addForPlayer(citizenid: string, item: Partial<Contact>): Promise<number> {
        return await this.create({ ...item, citizenid } as Partial<Contact>);
      }
    })(resolved)
});
