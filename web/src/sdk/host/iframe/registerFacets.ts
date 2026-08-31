/**
 * The iframe facet set — the other side of the SDK's host seam, and an add-on's half of it.
 *
 * MICA-176; see `../inProcess/registerFacets.ts` for why the choice moved out of
 * `vite.addon.config.ts`'s deleted `facetSwap()` plugin and into the entry point. This is
 * the file `bootAddOn` imports, and the shell never does.
 *
 * Every module below is a twin that goes over the `postMessage` transport rather than
 * touching `shell/`, `services/` or `nui/` — which is what makes an add-on bundle safe to
 * hand a sandboxed iframe. `seam.test.ts` checks that property on the whole
 * `sdk/host/iframe/**` tree transitively, and checks this list against the directory so a
 * twin added and not listed here fails rather than silently never registering.
 */
/**
 * `persisted` first, mirroring the in-process set — see its comment. Nothing under
 * `iframe/facets/` reaches a module-scope `usePersisted` today, but an add-on's own code is
 * free to build a settings store at module scope, and the two sets staying the same shape
 * is worth more than the one line saved.
 */
import './facets/persisted';

import './facets/account';
import './facets/accounts';
import './facets/admin';
import './facets/appAction';
import './facets/appEvents';
import './facets/appLevels';
import './facets/appRegistry';
import './facets/appRegistryWrite';
import './facets/bank';
import './facets/call';
import './facets/camera';
import './facets/clock';
import './facets/clockWrite';
import './facets/contacts';
import './facets/deepLink.svelte';
import './facets/devTools';
import './facets/display';
import './facets/displayWrite';
import './facets/highscores';
import './facets/keybinds';
import './facets/keybindsWrite';
import './facets/lifecycle';
import './facets/location';
import './facets/lockScreen';
import './facets/lockScreenWrite';
import './facets/mail';
import './facets/marketplace';
import './facets/media';
import './facets/messages';
import './facets/music';
import './facets/navigation';
import './facets/notificationSettings';
import './facets/notificationSettingsWrite';
import './facets/notifications';
import './facets/phoneNotification';
import './facets/report';
import './facets/reports';
import './facets/service';
import './facets/sound';
import './facets/storage';
import './facets/systemHardware';
import './facets/systemHardwareWrite';
import './facets/theme';
import './facets/themeWrite';
import './facets/timer';
import './facets/wallpaper';
import './facets/wallpaperWrite';
