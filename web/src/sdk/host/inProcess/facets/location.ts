import { registerFacet } from '../../current';
import { media } from '../../../../services/media';

/**
 * Share the caller's current in-game position, and set a GPS waypoint from a location a
 * message already carries. An action pair rather than a data subscription — closer in
 * shape to `useCamera` than to `useContacts` — so there is no store here to read.
 */
export function location() {
  return {
    shareLocation: media.shareLocation,
    setWaypoint: media.setWaypoint
  };
}

registerFacet('location', location);
