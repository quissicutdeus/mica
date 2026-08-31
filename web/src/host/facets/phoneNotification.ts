import type { SendNotificationOptions } from '../../../../sdk/host/facets';
import { registerFacet } from '../../../../sdk/host/current';
import { toast } from '../../shell/state/toast';

// MICA-179: defined once in the host contract; re-exported so existing importers keep working.
/**
 * OS Service Hook for sending toast notifications and system alerts.
 */
export function phoneNotification() {
  return {
    sendNotification: (options: SendNotificationOptions) => {
      return toast.show({
        title: options.title,
        message: options.message,
        avatar: options.avatar,
        type: options.type || 'info',
        duration: options.duration,
        onClick: options.onClick
      });
    },
    dismissNotification: (id: string) => {
      toast.dismiss(id);
    },
    toast
  };
}

registerFacet('phoneNotification', phoneNotification);
