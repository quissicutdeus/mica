import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/contacts').contacts>;

export function contacts(): Twin {
  return {
    contactsStore: store('contacts', [], 'contactsStore', []),
    favoriteContacts: store('contacts', [], 'favoriteContacts', []),
    addContact: fn('contacts', [], 'addContact'),
    shareContact: fn('contacts', [], 'shareContact')
  } as unknown as Twin;
}
registerFacet('contacts', contacts);
