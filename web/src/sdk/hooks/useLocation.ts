import { media } from '../../services/media';
import { assertCapability } from '../capability';

/**
 * Share the caller's current in-game position, and set a GPS waypoint from a location a
 * message already carries. An action pair rather than a data subscription — closer in
 * shape to `useCamera` than to `useContacts` — so there is no store here to read.
 */
export function useLocation() {
  assertCapability('location', 'useLocation');
  return {
    shareLocation: media.shareLocation,
    setWaypoint: media.setWaypoint
  };
}
