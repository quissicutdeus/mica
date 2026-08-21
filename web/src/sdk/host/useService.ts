import './inProcess/facets/service';
import { guarded } from './guard';

/**
 * Talk to your own server service.
 */
export function useService(serviceId: string) {
  return guarded('useService', serviceId.split('_')[0]).facets.service(serviceId);
}
