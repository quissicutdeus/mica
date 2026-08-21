import { registerFacet } from '../../current';
import { store } from './_shared';

type Twin = ReturnType<
  typeof import('../../inProcess/facets/notificationSettings').notificationSettings
>;

export function notificationSettings(): Twin {
  return {
    toastsEnabled: store('notificationSettings', [], 'toastsEnabled', true),
    notificationSoundEnabled: store('notificationSettings', [], 'notificationSoundEnabled', true),
    badgesEnabled: store('notificationSettings', [], 'badgesEnabled', true)
  } as unknown as Twin;
}

registerFacet('notificationSettings', notificationSettings);
