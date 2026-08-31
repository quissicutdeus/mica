// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../../../web/src/host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { fakeTransport } from '../__fixtures__/fakeTransport';
import type { ToShell } from '../messages';

// MICA-16 step 4: the seam test — every iframe facet twin must return the same key set
// as its inProcess counterpart, and route a `fn` member's call through remoteCall with the
// right facet/factoryArgs/member. Mocked so importing the inProcess twins (which pull in
// `services/*`) never touches a real transport.
vi.mock('../../../../web/src/nui/fetchNui', () => ({ fetchNui: vi.fn() }));

import { account as inAccount } from '../../../../web/src/host/facets/account';
import { accounts as inAccounts } from '../../../../web/src/host/facets/accounts';
import { admin as inAdmin } from '../../../../web/src/host/facets/admin';
import { call as inCall } from '../../../../web/src/host/facets/call';
import { camera as inCamera } from '../../../../web/src/host/facets/camera';
import { contacts as inContacts } from '../../../../web/src/host/facets/contacts';
import { highscores as inHighscores } from '../../../../web/src/host/facets/highscores';
import { location as inLocation } from '../../../../web/src/host/facets/location';
import { mail as inMail } from '../../../../web/src/host/facets/mail';
import { marketplace as inMarketplace } from '../../../../web/src/host/facets/marketplace';
import { media as inMedia } from '../../../../web/src/host/facets/media';
import { messages as inMessages } from '../../../../web/src/host/facets/messages';
import { notifications as inNotifications } from '../../../../web/src/host/facets/notifications';
import { reports as inReports } from '../../../../web/src/host/facets/reports';
import { report as inReport } from '../../../../web/src/host/facets/report';
import { service as inService } from '../../../../web/src/host/facets/service';

import { account } from './account';
import { accounts } from './accounts';
import { admin } from './admin';
import { call } from './call';
import { camera } from './camera';
import { contacts } from './contacts';
import { highscores } from './highscores';
import { location } from './location';
import { mail } from './mail';
import { marketplace } from './marketplace';
import { media } from './media';
import { messages } from './messages';
import { notifications } from './notifications';
import { reports } from './reports';
import { report } from './report';
import { service } from './service';

const keys = (o: object) => Object.keys(o).sort();

describe('iframe data facet twins — key parity with inProcess', () => {
  it.each([
    ['account', account, inAccount],
    ['accounts', accounts, inAccounts],
    ['admin', admin, inAdmin],
    ['call', call, inCall],
    ['camera', camera, inCamera],
    ['contacts', contacts, inContacts],
    ['highscores', highscores, inHighscores],
    ['location', location, inLocation],
    ['mail', mail, inMail],
    ['marketplace', marketplace, inMarketplace],
    ['media', media, inMedia],
    ['messages', messages, inMessages],
    ['reports', reports, inReports],
    ['report', report, inReport]
  ] as const)('%s: same keys as inProcess', (_name, iframeFacet, inProcessFacet) => {
    fakeTransport();
    expect(keys(iframeFacet())).toEqual(keys(inProcessFacet()));
  });

  it('notifications(appId): same keys as inProcess', () => {
    fakeTransport();
    expect(keys(notifications('blabber'))).toEqual(keys(inNotifications('blabber')));
  });

  it('service(serviceId): same keys as inProcess', () => {
    fakeTransport();
    expect(keys(service('marketplace'))).toEqual(keys(inService('marketplace')));
  });
});

describe('iframe data facet twins — route a call through remoteCall', () => {
  it('contacts().addContact sends a call to the contacts facet', () => {
    const f = fakeTransport();
    contacts().addContact('A', '555');
    const msg = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toMatchObject({ kind: 'call', facet: 'contacts', member: 'addContact' });
  });

  it('mail().deleteMail sends a call to the mail facet', () => {
    const f = fakeTransport();
    mail().deleteMail(3);
    const msg = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toMatchObject({ kind: 'call', facet: 'mail', member: 'deleteMail', args: [3] });
  });

  it('service("marketplace").call routes with the service as a factoryArg', () => {
    const f = fakeTransport();
    service('marketplace').call('feed', {});
    const msg = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toMatchObject({
      kind: 'call',
      facet: 'service',
      factoryArgs: ['marketplace'],
      member: 'call'
    });
  });

  it('notifications("blabber").load sends a call scoped by appId factoryArg', () => {
    const f = fakeTransport();
    notifications('blabber').load();
    const msg = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toMatchObject({
      kind: 'call',
      facet: 'notifications',
      factoryArgs: ['blabber'],
      member: 'load'
    });
  });
});
