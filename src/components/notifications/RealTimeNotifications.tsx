import { useEffect } from 'react';
import { useWebSocket } from '@/services/websocket';
import { useNotificationStore } from '@/stores/notification.store';
import { NotificationContainer } from './NotificationContainer';
import { queryClient } from '@/lib/queryClient';

/**
 * RealTimeNotifications component
 * Handles WebSocket messages and displays real-time notifications
 */
export function RealTimeNotifications() {
  const { messages, isConnected, clearMessages } = useWebSocket();
  const { notifications, addNotification, removeNotification } = useNotificationStore();

  useEffect(() => {
    // Process incoming WebSocket messages
    messages.forEach((msg) => {
      switch (msg.type) {
        case 'subscription:created': {
          const payload = msg.payload as { planName?: string };
          addNotification({
            type: 'success',
            title: 'Подписка оформлена',
            message: `Подписка ${payload.planName || ''} активирована`,
          });
          // Invalidate queries
          queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
          queryClient.invalidateQueries({ queryKey: ['user', 'stats'] });
          break;
        }

        case 'subscription:expired': {
          addNotification({
            type: 'warning',
            title: 'Подписка истекла',
            message: 'Ваша подписка истекла, продлите для продолжения использования',
            persistent: true,
          });
          queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
          queryClient.invalidateQueries({ queryKey: ['user', 'stats'] });
          break;
        }

        case 'subscription:renewed': {
          const payload = msg.payload as { planName?: string };
          addNotification({
            type: 'success',
            title: 'Подписка продлена',
            message: `Подписка ${payload.planName || ''} успешно продлена`,
          });
          queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
          queryClient.invalidateQueries({ queryKey: ['user', 'stats'] });
          break;
        }

        case 'payment:received': {
          const payload = msg.payload as { amount?: number; currency?: string };
          addNotification({
            type: 'success',
            title: 'Платеж получен',
            message: `Получено ${payload.amount || 0} ${payload.currency || 'USD'}`,
          });
          queryClient.invalidateQueries({ queryKey: ['payments'] });
          queryClient.invalidateQueries({ queryKey: ['user', 'stats'] });
          break;
        }

        case 'payment:failed': {
          const payload = msg.payload as { reason?: string };
          addNotification({
            type: 'error',
            title: 'Платеж не удался',
            message: payload.reason || 'Произошла ошибка при обработке платежа',
          });
          queryClient.invalidateQueries({ queryKey: ['payments'] });
          break;
        }

        case 'referral:registered': {
          const payload = msg.payload as { referralName?: string; bonusAmount?: number };
          addNotification({
            type: 'info',
            title: 'Новый реферал',
            message: `Пользователь ${payload.referralName || ''} зарегистрировался по вашей ссылке`,
          });
          queryClient.invalidateQueries({ queryKey: ['referrals'] });
          queryClient.invalidateQueries({ queryKey: ['referrals', 'stats'] });
          break;
        }

        case 'points:earned': {
          const payload = msg.payload as { amount?: number; source?: string };
          addNotification({
            type: 'success',
            title: 'Баллы начислены',
            message: `+${payload.amount || 0} баллов за ${payload.source || 'активность'}`,
          });
          queryClient.invalidateQueries({ queryKey: ['referrals', 'stats'] });
          queryClient.invalidateQueries({ queryKey: ['user', 'stats'] });
          break;
        }

        case 'partner:commission': {
          const payload = msg.payload as { commission?: number; currency?: string };
          addNotification({
            type: 'success',
            title: 'Партнерская комиссия',
            message: `+${payload.commission || 0} ${payload.currency || 'USD'}`,
          });
          queryClient.invalidateQueries({ queryKey: ['partner'] });
          queryClient.invalidateQueries({ queryKey: ['partner', 'data'] });
          break;
        }

        case 'payout:completed': {
          const payload = msg.payload as { amount?: number; currency?: string };
          addNotification({
            type: 'success',
            title: 'Выплата выполнена',
            message: `${payload.amount || 0} ${payload.currency || 'USD'} успешно выплачены`,
          });
          queryClient.invalidateQueries({ queryKey: ['partner', 'payouts'] });
          break;
        }

        case 'system:broadcast': {
          const payload = msg.payload as { message?: string; title?: string };
          addNotification({
            type: 'info',
            title: payload.title || 'Объявление',
            message: payload.message || '',
            persistent: true,
          });
          break;
        }

        case 'system:maintenance:started': {
          addNotification({
            type: 'warning',
            title: 'Технические работы',
            message: 'Начались технические работы. Сервис может быть недоступен.',
            persistent: true,
          });
          break;
        }

        case 'system:maintenance:ended': {
          addNotification({
            type: 'success',
            title: 'Работы завершены',
            message: 'Технические работы завершены. Сервис работает в штатном режиме.',
          });
          break;
        }

        case 'error': {
          const payload = msg.payload as { message?: string };
          addNotification({
            type: 'error',
            title: 'Ошибка',
            message: payload.message || 'Произошла ошибка',
          });
          break;
        }

        default:
          // Unknown message type - log for debugging
          console.debug('Unknown WebSocket message type:', msg.type);
      }
    });

    // Clear processed messages to prevent memory leak
    if (messages.length > 0) {
      clearMessages();
    }
  }, [messages, addNotification, clearMessages]);

  // Clear messages when disconnected and reconnected
  useEffect(() => {
    if (isConnected) {
      console.log('WebSocket connected - real-time notifications active');
    }
  }, [isConnected]);

  return (
    <NotificationContainer
      notifications={notifications}
      onClose={removeNotification}
    />
  );
}

export default RealTimeNotifications;
