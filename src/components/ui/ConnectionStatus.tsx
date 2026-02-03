import { Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/services/websocket';

/**
 * ConnectionStatus component
 * Displays WebSocket connection status indicator
 */
export function ConnectionStatus() {
  const { isConnected, connectionState } = useWebSocket();

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300',
        isConnected
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
      )}
      title={isConnected ? 'Подключено к серверу' : 'Подключение к серверу...'}
    >
      <div
        className={cn(
          'w-2 h-2 rounded-full transition-all duration-300',
          isConnected
            ? 'bg-green-500 animate-pulse'
            : 'bg-yellow-500 animate-pulse'
        )}
      />
      {isConnected ? (
        <Wifi className="h-3.5 w-3.5" />
      ) : (
        <WifiOff className="h-3.5 w-3.5" />
      )}
      <span>
        {isConnected
          ? 'Online'
          : connectionState === 'connecting'
          ? 'Подключение...'
          : 'Offline'}
      </span>
    </div>
  );
}

export default ConnectionStatus;
