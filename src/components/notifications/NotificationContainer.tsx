import { NotificationToast } from './NotificationToast';
import type { Notification } from '@/stores/notification.store';

/**
 * Props for NotificationContainer component
 */
interface NotificationContainerProps {
  notifications: Notification[];
  onClose: (id: string) => void;
}

/**
 * NotificationContainer component
 * Renders a stack of notification toasts
 */
export function NotificationContainer({ notifications, onClose }: NotificationContainerProps) {
  if (notifications.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed right-4 top-4 z-[100] flex flex-col gap-2"
      aria-live="polite"
      aria-atomic="true"
    >
      {notifications.map((notification) => (
        <NotificationToast
          key={notification.id}
          id={notification.id}
          type={notification.type}
          title={notification.title}
          message={notification.message}
          persistent={notification.persistent}
          actions={notification.actions}
          onClose={() => onClose(notification.id)}
        />
      ))}
    </div>
  );
}

export default NotificationContainer;
