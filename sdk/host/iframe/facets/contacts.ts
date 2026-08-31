import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<Facets['contacts']>>;

export function contacts(): Twin {
  return {
    contactsStore: store('contacts', [], 'contactsStore', []),
    favoriteContacts: store('contacts', [], 'favoriteContacts', []),
    addContact: fn('contacts', [], 'addContact'),
    shareContact: fn('contacts', [], 'shareContact'),
    getDeletedContacts: fn('contacts', [], 'getDeletedContacts'),
    restoreContact: fn('contacts', [], 'restoreContact')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('contacts', contacts as unknown as Facets['contacts']);
