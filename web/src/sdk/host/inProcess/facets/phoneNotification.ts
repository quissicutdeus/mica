import { registerFacet } from '../../current';
import { toast, type ToastMessage } from '../../../../shell/state/toast';

export interface SendNotificationOptions {
  title?: string;
  message: string;
  avatar?: string;
  type?: ToastMessage['type'];
  duration?: number;
  onClick?: () => void;
}

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
