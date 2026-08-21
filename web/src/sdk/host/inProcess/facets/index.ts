// Type-only. Nothing here is a runtime import: `current.ts` (and through it `guard.ts`,
// `system.ts`, `createInProcessHost.ts`) needs the *shape* of the facet surface, never the
// facet implementations themselves. A facet module's own file imports `shell/`/`services/`
// — pulling any of that in at runtime here would put the whole `shell/state` tree back on
// the module graph between `guard.ts` and the state it reads, recreating the import cycle
// this file exists to avoid. Each facet self-registers into `current.ts`'s registry via a
// side-effect import in its owning hook file instead (see `useTheme.ts` etc.).
import type { account } from './account';
import type { accounts } from './accounts';
import type { admin } from './admin';
import type { call } from './call';
import type { camera } from './camera';
import type { contacts } from './contacts';
import type { highscores } from './highscores';
import type { location } from './location';
import type { mail } from './mail';
import type { marketplace } from './marketplace';
import type { media } from './media';
import type { messages } from './messages';
import type { notifications } from './notifications';
import type { reports } from './reports';
import type { report } from './report';

import type { appAction } from './appAction';
import type { appEvents } from './appEvents';
import type { appLevels } from './appLevels';
import type { appRegistry } from './appRegistry';
import type { clock } from './clock';
import type { deepLink } from './deepLink.svelte';
import type { devTools } from './devTools';
import type { display } from './display';
import type { keybinds } from './keybinds';
import type { navigation } from './navigation';
import type { notificationSettings } from './notificationSettings';
import type { phoneNotification } from './phoneNotification';
import type { sound } from './sound';
import type { systemHardware } from './systemHardware';
import type { theme } from './theme';
import type { wallpaper } from './wallpaper';

import type { storage, appStorageBytes, clearAppStorage } from './storage';
import type { persisted } from './persisted';
import type { service } from './service';
import type { timer } from './timer';
import type { onAppForeground, onAppUnmount } from './lifecycle';

/** One key per facet function. The runtime object living behind this shape is the `Proxy`
 * exported as `facets` from `../../current.ts`. */
export interface Facets {
  account: typeof account;
  accounts: typeof accounts;
  admin: typeof admin;
  call: typeof call;
  camera: typeof camera;
  contacts: typeof contacts;
  highscores: typeof highscores;
  location: typeof location;
  mail: typeof mail;
  marketplace: typeof marketplace;
  media: typeof media;
  messages: typeof messages;
  notifications: typeof notifications;
  reports: typeof reports;
  report: typeof report;

  appAction: typeof appAction;
  appEvents: typeof appEvents;
  appLevels: typeof appLevels;
  appRegistry: typeof appRegistry;
  clock: typeof clock;
  deepLink: typeof deepLink;
  devTools: typeof devTools;
  display: typeof display;
  keybinds: typeof keybinds;
  navigation: typeof navigation;
  notificationSettings: typeof notificationSettings;
  phoneNotification: typeof phoneNotification;
  sound: typeof sound;
  systemHardware: typeof systemHardware;
  theme: typeof theme;
  wallpaper: typeof wallpaper;

  storage: typeof storage;
  appStorageBytes: typeof appStorageBytes;
  clearAppStorage: typeof clearAppStorage;
  persisted: typeof persisted;
  service: typeof service;
  timer: typeof timer;
  onAppForeground: typeof onAppForeground;
  onAppUnmount: typeof onAppUnmount;
}
