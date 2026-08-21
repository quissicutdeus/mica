import {
  currentApp,
  openApp,
  goHome,
  closePhone,
  consumeAppProps
} from '../../shell/state/navigation';
import { assertCapability } from '../capability';

/**
 * OS Service Hook for phone navigation (opening apps, returning home, closing phone shell).
 */
export function useNavigation() {
  assertCapability('navigation', 'useNavigation');
  return {
    currentApp,
    openApp: (appName: string, props: Record<string, unknown> = {}) => openApp(appName, props),
    goHome: () => goHome(),
    closePhone: () => closePhone(),
    /**
     * Mark this app's deep-link props as handled, so they do not fire again.
     *
     * Call it from whatever acts on `initialX` / `xId` props. Without it the prop stays
     * set for as long as the app is resident and re-applies itself the moment the user
     * navigates back inside the app.
     */
    consumeDeepLink: (appId: string) => consumeAppProps(appId)
  };
}
