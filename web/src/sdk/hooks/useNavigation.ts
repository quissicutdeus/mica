import { currentApp, openApp, goHome, closePhone } from '../../store/navigation';

/**
 * OS Service Hook for phone navigation (opening apps, returning home, closing phone shell).
 */
export function useNavigation() {
  return {
    currentApp,
    openApp: (appName: string, props: any = {}) => openApp(appName, props),
    goHome: () => goHome(),
    closePhone: () => closePhone()
  };
}
