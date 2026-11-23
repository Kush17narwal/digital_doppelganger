'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { sendSessionEvent, subscribeToEvents } from '@/lib/api';

interface UseWebSocketOptions {
  onMessage?: (data: any) => void;
  autoConnect?: boolean;
}

// Compatibility hook: Supabase Realtime replaces the old FastAPI WebSocket.
export function useWebSocket(path: string, options: UseWebSocketOptions = {}) {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<any>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const callbackRef = useRef(options.onMessage);
  callbackRef.current = options.onMessage;

  const connect = useCallback(() => {
    if (cleanupRef.current || !path) return;
    const sessionId = path.match(/^\/ws\/events\/([^/]+)$/)?.[1] ?? null;
    cleanupRef.current = subscribeToEvents(path === '/ws/dashboard' ? null : sessionId, (data) => {
      setLastMessage(data);
      callbackRef.current?.(data);
    }, setConnected);
  }, [path]);

  const send = useCallback((data: any) => {
    if (!path.startsWith('/ws/events/')) return Promise.resolve(undefined);
    return sendSessionEvent(path, data);
  }, [path]);

  const disconnect = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => {
    if (path && options.autoConnect !== false) connect();
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [connect, path, options.autoConnect]);

  return { connected, lastMessage, send, connect, disconnect };
}
