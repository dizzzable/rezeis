import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * WebSocket connection state
 */
export type ConnectionState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * WebSocket message structure
 */
export interface WebSocketMessage {
  type: string;
  payload: unknown;
  timestamp: number;
  correlationId?: string;
}

/**
 * WebSocket service options
 */
export interface WebSocketServiceOptions {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  connectionType?: 'client' | 'admin';
}

/**
 * WebSocket event handler type
 */
export type EventHandler = (payload: unknown) => void;

/**
 * WebSocket service for real-time communication
 */
export class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: WebSocketMessage[] = [];
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private options: Required<WebSocketServiceOptions>;
  private connectionState: ConnectionState = 'closed';
  private isAuthenticated = false;

  constructor(options: WebSocketServiceOptions) {
    this.options = {
      reconnectInterval: 3000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      connectionType: 'client',
      ...options,
    };
  }

  /**
   * Connect to WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.connectionState = 'connecting';
    this.emit('connectionState', this.connectionState);

    try {
      const url = `${this.options.url}/${this.options.connectionType}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connectionState = 'open';
        this.reconnectAttempts = 0;
        this.emit('connectionState', this.connectionState);
        this.emit('connected', undefined);

        // Start heartbeat
        this.startHeartbeat();

        // Flush message queue
        this.flushMessageQueue();
      };

      this.ws.onclose = () => {
        this.connectionState = 'closed';
        this.isAuthenticated = false;
        this.emit('connectionState', this.connectionState);
        this.emit('disconnected', undefined);
        this.stopHeartbeat();
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        this.emit('error', error);
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          this.handleMessage(message);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };
    } catch (err) {
      this.connectionState = 'closed';
      this.emit('connectionState', this.connectionState);
      this.emit('error', err);
      this.attemptReconnect();
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.ws) {
      this.connectionState = 'closing';
      this.emit('connectionState', this.connectionState);
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Reconnect to WebSocket server
   */
  reconnect(): void {
    this.disconnect();
    setTimeout(() => this.connect(), 100);
  }

  /**
   * Send a message to the server
   */
  send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  /**
   * Authenticate with JWT token
   */
  authenticate(token: string): void {
    this.send({
      type: 'auth:jwt',
      payload: { token },
      timestamp: Date.now(),
    });
  }

  /**
   * Subscribe to a channel
   */
  subscribe(channel: string): void {
    this.send({
      type: 'subscribe',
      payload: { channel },
      timestamp: Date.now(),
    });
  }

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channel: string): void {
    this.send({
      type: 'unsubscribe',
      payload: { channel },
      timestamp: Date.now(),
    });
  }

  /**
   * Register an event handler
   */
  on(event: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)?.add(handler);

    // Return unsubscribe function
    return () => {
      this.off(event, handler);
    };
  }

  /**
   * Remove an event handler
   */
  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event to all registered handlers
   */
  private emit(event: string, payload: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(payload);
        } catch (err) {
          console.error(`Error in event handler for ${event}:`, err);
        }
      });
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: WebSocketMessage): void {
    // Handle special message types
    switch (message.type) {
      case 'connection:established':
        this.emit('connected', message.payload);
        break;

      case 'auth:success':
        this.isAuthenticated = true;
        this.emit('authenticated', message.payload);
        break;

      case 'auth:error':
        this.isAuthenticated = false;
        this.emit('authError', message.payload);
        break;

      case 'pong':
        // Heartbeat response
        break;

      case 'error':
        this.emit('error', message.payload);
        break;

      default:
        // Emit the message type for specific handlers
        this.emit(message.type, message.payload);
        // Also emit as generic 'message' event
        this.emit('message', message);
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit('maxReconnectAttemptsReached', undefined);
      return;
    }

    const delay = Math.min(
      this.options.reconnectInterval * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Clear reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: 'ping',
        payload: { timestamp: Date.now() },
        timestamp: Date.now(),
      });
    }, this.options.heartbeatInterval);
  }

  /**
   * Stop heartbeat interval
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Flush queued messages
   */
  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        this.send(message);
      }
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if user is online (connected and authenticated)
   */
  isUserOnline(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.isAuthenticated;
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if authenticated
   */
  getIsAuthenticated(): boolean {
    return this.isAuthenticated;
  }
}

// Global WebSocket service instance
let wsServiceInstance: WebSocketService | null = null;

/**
 * Initialize WebSocket service
 */
export function initializeWebSocketService(url: string, connectionType: 'client' | 'admin' = 'client'): WebSocketService {
  if (!wsServiceInstance) {
    wsServiceInstance = new WebSocketService({
      url,
      connectionType,
    });
  }
  return wsServiceInstance;
}

/**
 * Get WebSocket service instance
 */
export function getWebSocketService(): WebSocketService | null {
  return wsServiceInstance;
}

/**
 * React hook for using WebSocket
 */
export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [messages, setMessages] = useState<WebSocketMessage[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const serviceRef = useRef<WebSocketService | null>(null);

  useEffect(() => {
    const service = getWebSocketService();
    if (!service) return;

    serviceRef.current = service;

    // Subscribe to events
    const unsubscribeConnected = service.on('connected', () => {
      setIsConnected(true);
    });

    const unsubscribeDisconnected = service.on('disconnected', () => {
      setIsConnected(false);
      setIsAuthenticated(false);
    });

    const unsubscribeState = service.on('connectionState', (state) => {
      setConnectionState(state as ConnectionState);
    });

    const unsubscribeAuthenticated = service.on('authenticated', () => {
      setIsAuthenticated(true);
    });

    const unsubscribeMessage = service.on('message', (msg) => {
      setMessages((prev) => [...prev, msg as WebSocketMessage]);
    });

    // Set initial state
    setIsConnected(service.isConnected());
    setConnectionState(service.getConnectionState());
    setIsAuthenticated(service.getIsAuthenticated());

    return () => {
      unsubscribeConnected();
      unsubscribeDisconnected();
      unsubscribeState();
      unsubscribeAuthenticated();
      unsubscribeMessage();
    };
  }, []);

  const send = useCallback((message: WebSocketMessage) => {
    serviceRef.current?.send(message);
  }, []);

  const subscribe = useCallback((channel: string) => {
    serviceRef.current?.subscribe(channel);
  }, []);

  const unsubscribe = useCallback((channel: string) => {
    serviceRef.current?.unsubscribe(channel);
  }, []);

  const authenticate = useCallback((token: string) => {
    serviceRef.current?.authenticate(token);
  }, []);

  const connect = useCallback(() => {
    serviceRef.current?.connect();
  }, []);

  const disconnect = useCallback(() => {
    serviceRef.current?.disconnect();
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    isConnected,
    connectionState,
    isAuthenticated,
    messages,
    send,
    subscribe,
    unsubscribe,
    authenticate,
    connect,
    disconnect,
    clearMessages,
  };
}

export default WebSocketService;
