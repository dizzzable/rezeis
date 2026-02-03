import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Notification, NotificationType } from '@/stores/notification.store';
import { Button } from '@/components/ui/button';

/**
 * Props for NotificationToast component
 */
interface NotificationToastProps extends Omit<Notification, 'timestamp'> {
  onClose: () => void;
}

/**
 * Icon mapping for notification types
 */
const iconMap: Record<NotificationType, React.ElementType> = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

/**
 * Color mapping for notification types
 */
const colorMap: Record<NotificationType, string> = {
  success: 'bg-green-50 border-green-200 text-green-800',
  error: 'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
};

/**
 * Icon color mapping for notification types
 */
const iconColorMap: Record<NotificationType, string> = {
  success: 'text-green-500',
  error: 'text-red-500',
  warning: 'text-yellow-500',
  info: 'text-blue-500',
};

/**
 * NotificationToast component
 * Displays a single notification toast
 */
export function NotificationToast({
  type,
  title,
  message,
  actions,
  onClose,
}: NotificationToastProps) {
  const Icon = iconMap[type];

  return (
    <div
      className={cn(
        'relative flex w-full max-w-sm items-start gap-3 rounded-lg border p-4 shadow-lg',
        'animate-in slide-in-from-right-full duration-300',
        colorMap[type]
      )}
      role="alert"
    >
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', iconColorMap[type])} />

      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold">{title}</h4>
        <p className="mt-1 text-sm opacity-90">{message}</p>

        {actions && actions.length > 0 && (
          <div className="mt-3 flex gap-2">
            {actions.map((action, index) => (
              <Button
                key={index}
                size="sm"
                variant="outline"
                onClick={() => {
                  action.action();
                  onClose();
                }}
                className="text-xs"
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onClose}
        className="shrink-0 rounded-md p-1 opacity-60 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-offset-1"
        aria-label="Close notification"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default NotificationToast;
