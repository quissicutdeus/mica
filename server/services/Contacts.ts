import { defineService, SchemaRepository } from '../lib/defineService';
import { Contact } from '@shared/types';
import { guardNetEvent } from '../lib/netGuard';
import { findNearbyVisiblePlayers } from '../lib/proximity';
import { appEventChannel } from '../lib/appEvents';
import { fields } from '../lib/payload';

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

const MAX_SHARE_NAME_LENGTH = 50;
const MAX_SHARE_PHONE_LENGTH = 20;

interface SharePayload {
  firstname: string;
  lastname: string;
  phone: string;
  avatar: string;
}

/** Same clamps `AddContact` applies — the columns behind them are unchanged. */
const sanitizeShare = (data: unknown): SharePayload | null => {
  const payload = fields(data);
  const firstname = String(payload.firstname ?? '')
    .trim()
    .slice(0, MAX_SHARE_NAME_LENGTH);
  const phone = String(payload.phone ?? '')
    .trim()
    .slice(0, MAX_SHARE_PHONE_LENGTH);
  if (!firstname || !phone) return null;

  return {
    firstname,
    lastname: payload.lastname
      ? String(payload.lastname).trim().slice(0, MAX_SHARE_NAME_LENGTH)
      : '',
    phone,
    avatar: payload.avatar ? String(payload.avatar) : ''
  };
};

/**
 * Proximity contact sharing — finishes the stub in `client/services/Contact.ts`.
 *
 * A raw handler outside `ServiceEndpoint`, guarded the same way `Phone.ts`'s and
 * `Signal.ts`'s are (§2.9): the client's NUI callback already resolved optimistically, so
 * this event carries no callback id and nothing is waiting on a reply. The outcome —
 * delivered to N nearby phones, or nobody in range — reaches the sender through the
 * generic push-and-toast channel instead, the same one a delivered DM uses.
 */
onNet('gphone:server:contacts:share', (data: unknown) => {
  const player = guardNetEvent('contacts', 'share');
  if (!player) return;

  const share = sanitizeShare(data);
  if (!share) return;

  void (async () => {
    const nearby = await findNearbyVisiblePlayers(player.source, player.citizenid);

    if (typeof emitNet === 'function') {
      for (const target of nearby) {
        emitNet('gphone:client:contacts:incoming', target.source, share);
      }
    }

    const outcome = appEventChannel('contacts').push(
      player.citizenid,
      'share_result',
      { count: nearby.length },
      {
        persist: false,
        notify: {
          title: nearby.length > 0 ? 'Contact shared' : 'Nobody nearby',
          message:
            nearby.length > 0
              ? `Shared with ${nearby.length} nearby ${nearby.length === 1 ? 'phone' : 'phones'}.`
              : 'No Bluetooth-visible players are in range.'
        }
      }
    );
    if (!outcome.delivered && outcome.reason !== 'offline') {
      console.error(
        `[contacts] Share result push for ${player.citizenid} was refused: ${outcome.reason}.`
      );
    }
  })();
});
