// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fakeTransport } from '../__fixtures__/fakeTransport';
import type { ToShell } from '../messages';

// MICA-16 step 4: the seam test — every iframe facet twin must return the same key set
// as its inProcess counterpart, and route a `fn` member's call through remoteCall with the
// right facet/factoryArgs/member. Mocked so importing the inProcess twins (which pull in
// `services/*`) never touches a real transport.
vi.mock('../../../../nui/fetchNui', () => ({ fetchNui: vi.fn() }));

import { account as inAccount } from '../../inProcess/facets/account';
import { accounts as inAccounts } from '../../inProcess/facets/accounts';
import { admin as inAdmin } from '../../inProcess/facets/admin';
import { call as inCall } from '../../inProcess/facets/call';
import { camera as inCamera } from '../../inProcess/facets/camera';
import { contacts as inContacts } from '../../inProcess/facets/contacts';
import { highscores as inHighscores } from '../../inProcess/facets/highscores';
import { location as inLocation } from '../../inProcess/facets/location';
import { mail as inMail } from '../../inProcess/facets/mail';
import { marketplace as inMarketplace } from '../../inProcess/facets/marketplace';
import { media as inMedia } from '../../inProcess/facets/media';
import { messages as inMessages } from '../../inProcess/facets/messages';
import { notifications as inNotifications } from '../../inProcess/facets/notifications';
import { reports as inReports } from '../../inProcess/facets/reports';
import { report as inReport } from '../../inProcess/facets/report';
import { service as inService } from '../../inProcess/facets/service';

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
