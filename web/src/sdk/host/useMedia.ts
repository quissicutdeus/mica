import './inProcess/facets/media';
import { guarded } from './guard';

/**
 * The media gallery — the client face of the `media` service.
 */
export function useMedia() {
  return guarded('useMedia').facets.media();
}
